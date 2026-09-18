import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'

/**
 * Phil's calendar, over CalDAV on the same Tobit David server as mail.mjs.
 *
 * Found by hand, the same way the SMTP AUTH quirk in mail.mjs was: David's
 * "WebBox" component (identifies itself as `David-WebBox/12.00a`) answers on
 * the ordinary web ports (80/443 — confirmed open, every other port the
 * David forums mention was closed) and OPTIONS on /caldav/ reports `DAV: 1,
 * calendar-access, addressbook`. The Remote Access mail credentials
 * authenticate here too — no separate calendar login exists. A PROPFIND on
 * /caldav/<url-encoded-address>/ returns exactly one collection, resourcetype
 * `CAL:calendar`, displayname "David.fx - <name>" — Phil's one personal
 * calendar, which is what he meant by the "Kalender"-Ordner he saw in the
 * mailbox list. There is no second calendar to choose between.
 *
 * A calendar-query REPORT (the standard way to ask CalDAV for events in a
 * time range) finds the right event resources but 404s on inlining
 * `calendar-data` for them — confirmed by hand, not guessed; some quirk of
 * this WebBox version. A plain authenticated GET on the same href returns
 * the full .ics without trouble, so that's what this does: REPORT for the
 * list of hrefs, then one GET per href for the content.
 *
 * Deliberately no recurrence expansion. A REPORT match only proves a
 * recurring event occurs *somewhere* in the window — David hands back the
 * same one .ics resource regardless of which occurrence matched, and
 * computing the actual occurrence date from RRULE/EXDATE is a real
 * calendar engine's job, not a home-grown regex's. A recurring hit is
 * reported as such rather than attached to a wrong date.
 *
 * calendar_events is read-only (GET/REPORT only). calendar_create_event
 * uses PUT to add a real appointment — confirmed working by hand (201,
 * event actually appears). DELETE, by contrast, does NOT work on this
 * WebBox version: it answers 200 whether given the resource's own path,
 * its server-assigned internal filename, or an If-Match with the current
 * ETag, and the event is still there afterwards every time — confirmed by
 * hand, cost a real leftover test appointment on Phil's actual calendar
 * that had to be deleted by hand in the David client. So there is
 * deliberately no delete/cancel tool here: it would lie about succeeding.
 * Getting calendar_create_event's inputs right matters more than usual,
 * because a mistake can't be undone through this module at all.
 *
 * Same self-signed-cert situation as mail.mjs, so the same TLS flag governs
 * both.
 */

const HOST = process.env.JARVIS_MAIL_HOST ?? ''
const USER = process.env.JARVIS_MAIL_USER ?? ''
const PASSWORD = process.env.JARVIS_MAIL_PASSWORD ?? ''
const PORT = Number(process.env.JARVIS_CALDAV_PORT ?? 443)

export const calendarConfigured = () => Boolean(HOST && USER && PASSWORD)

const REJECT_UNAUTHORIZED = process.env.JARVIS_MAIL_TLS_STRICT === '1'
const PRINCIPAL_PATH = () => `/caldav/${encodeURIComponent(USER)}/`

/**
 * One CalDAV/HTTP request. `insecureHTTPParser` is load-bearing: WebBox's
 * responses on this path tripped Node's strict parser during discovery
 * ("Content-Length can't be present with Transfer-Encoding") even though the
 * response is a perfectly ordinary chunked body — the same class of
 * quirk-tolerance mail.mjs needed for David's SMTP.
 *
 * `agent: false` is load-bearing too, found the same way: Node's default
 * agent keeps the TCP connection open (WebBox sends `Connection: Keep-Alive`)
 * and reuses it for the next request, and WebBox does not survive that —
 * confirmed by hand, the REPORT-then-GET sequence below reliably hung up the
 * socket on the second request until every request got its own connection.
 */
function davRequest(method, path, { depth, body, contentType = 'application/xml; charset=utf-8' } = {}) {
  return new Promise((resolve, reject) => {
    const auth = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64')
    const payload = body ? Buffer.from(body, 'utf8') : null
    const req = httpsRequest(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        rejectUnauthorized: REJECT_UNAUTHORIZED,
        insecureHTTPParser: true,
        agent: false,
        timeout: 15_000,
        headers: {
          Authorization: auth,
          Connection: 'close',
          ...(depth !== undefined ? { Depth: String(depth) } : {}),
          ...(payload ? { 'Content-Type': contentType, 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('CalDAV request timed out')))
    if (payload) req.end(payload)
    else req.end()
  })
}

/** YYYYMMDDTHHMMSSZ, what a CalDAV time-range filter wants. */
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/**
 * Just enough ICS to read one event aloud — not a general parser. Unfolds
 * the RFC 5545 line-continuation (a leading space or tab means "still the
 * previous line") before pulling the handful of fields a voice briefing
 * needs out of the first VEVENT block.
 */
function parseEvent(ics) {
  const unfolded = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '')
  const body = unfolded.split('BEGIN:VEVENT')[1]?.split('END:VEVENT')[0]
  if (!body) return null
  const field = (name) => {
    const m = new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, 'm').exec(body)
    return m ? m[1].trim() : ''
  }
  return {
    summary: field('SUMMARY') || '(ohne Titel)',
    start: field('DTSTART'),
    end: field('DTEND'),
    location: field('LOCATION'),
    recurring: /^RRULE:/m.test(body),
  }
}

/** "20260918T140000Z" / "20260918T140000" / "20260918" -> a readable stamp.
 *  Best-effort: a date-only value (all-day event) shows as just the date. */
function formatWhen(value) {
  if (!value) return ''
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(6, 8)}.${value.slice(4, 6)}.${value.slice(0, 4)}`
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(value)
  if (!m) return value
  const [, y, mo, da, h, mi] = m
  return `${da}.${mo}.${y} ${h}:${mi}`
}

/** RFC 5545 TEXT escaping — the four characters that mean something to an
 *  ICS parser (backslash itself has to go first). */
const escapeIcsText = (s) =>
  String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')

/** "2026-09-20T14:00" (Phil's own local time, no offset) parsed as this
 *  machine's local time — same assumption formatWhen's output already
 *  makes — then rendered as the UTC stamp CalDAV wants. Avoids needing a
 *  VTIMEZONE block entirely. */
function localToUtcStamp(local) {
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return stamp(d)
}

const NOT_CONFIGURED = {
  isError: true,
  content: [
    {
      type: 'text',
      text: 'Calendar is not configured — it reuses JARVIS_MAIL_HOST, JARVIS_MAIL_USER and JARVIS_MAIL_PASSWORD, which are not all set.',
    },
  ],
}

const EVENTS_DESCRIPTION = `List calendar events in the next N days (default 1
— today only), from Phil's real David calendar. Each line is one event: date/
time, title, and location if set; a recurring event is marked as such rather
than dated, since its exact occurrence date isn't computed (see the file
comment for why). Use this whenever he asks what's on his calendar, or as
part of a morning briefing.`

export function calendarServer() {
  return createSdkMcpServer({
    name: 'jarvis_calendar',
    version: '1.0.0',
    instructions:
      "Phil's calendar on the Tobit David server, read-only over CalDAV. " +
      'calendar_events for anything about what is on his schedule.',
    alwaysLoad: true,
    tools: [
      tool(
        'calendar_events',
        EVENTS_DESCRIPTION,
        {
          days: z.number().int().min(1).max(30).optional().catch(undefined)
            .describe('How many days ahead to include, starting today. Default 1 (today only).'),
        },
        async (args) => {
          if (!calendarConfigured()) return NOT_CONFIGURED
          const days = args.days ?? 1
          const start = new Date()
          start.setHours(0, 0, 0, 0)
          const end = new Date(start)
          end.setDate(end.getDate() + days)

          const reportBody =
            '<?xml version="1.0" encoding="utf-8"?>' +
            '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
            '<D:prop><D:getetag/></D:prop>' +
            '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
            `<C:time-range start="${stamp(start)}" end="${stamp(end)}"/>` +
            '</C:comp-filter></C:comp-filter></C:filter>' +
            '</C:calendar-query>'

          let res
          try {
            res = await davRequest('REPORT', PRINCIPAL_PATH(), { depth: 1, body: reportBody })
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Calendar request failed: ${err?.message ?? err}` }] }
          }
          if (res.status !== 207) {
            return { isError: true, content: [{ type: 'text', text: `Calendar server said ${res.status}.` }] }
          }

          // One <D:href> per matching resource. calendar-data can't be
          // inlined here (see file comment), so this is just the list of
          // resources to fetch individually next.
          const hrefs = [...new Set([...res.text.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]))]
          if (!hrefs.length) {
            return { content: [{ type: 'text', text: '(keine Termine im gewählten Zeitraum)' }] }
          }

          const events = []
          for (const href of hrefs) {
            let got
            try {
              got = await davRequest('GET', href)
            } catch {
              continue
            }
            if (got.status !== 200) continue
            const event = parseEvent(got.text)
            if (event) events.push(event)
          }

          if (!events.length) {
            return { content: [{ type: 'text', text: '(keine Termine im gewählten Zeitraum)' }] }
          }
          events.sort((a, b) => (a.start || '').localeCompare(b.start || ''))
          const lines = events.map((e) => {
            if (e.recurring) return `${e.summary} (wiederkehrend)${e.location ? ` (${e.location})` : ''}`
            const startStr = formatWhen(e.start)
            const endTime = e.end ? formatWhen(e.end).split(' ')[1] : null
            const when = endTime ? `${startStr}–${endTime}` : startStr
            return `${when}: ${e.summary}${e.location ? ` (${e.location})` : ''}`
          })
          return { content: [{ type: 'text', text: lines.join('\n') }] }
        },
      ),

      tool(
        'calendar_create_event',
        `Create a new appointment on Phil's real David calendar. Real and
immediate — it lands on the actual calendar the moment this returns. Only
call it once Phil has clearly asked for something to be scheduled, with a
title and a time he actually said, not invented. \`start\`/\`end\` are his
own local time, no timezone suffix, e.g. "2026-09-20T14:00".`,
        {
          summary: z.string().describe('Event title.'),
          start: z.string().describe('Start, local time, e.g. "2026-09-20T14:00".'),
          end: z.string().describe('End, local time, same format. Must be after start.'),
          location: z.string().optional().catch(undefined).describe('Optional location text.'),
        },
        async (args) => {
          if (!calendarConfigured()) return NOT_CONFIGURED
          const startStamp = localToUtcStamp(args.start)
          const endStamp = localToUtcStamp(args.end)
          if (!startStamp || !endStamp) {
            return { isError: true, content: [{ type: 'text', text: 'start/end must be parseable local date-times.' }] }
          }
          if (endStamp <= startStamp) {
            return { isError: true, content: [{ type: 'text', text: 'end must be after start.' }] }
          }
          const uid = randomUUID()
          const ics =
            'BEGIN:VCALENDAR\r\n' +
            'VERSION:2.0\r\n' +
            'PRODID:-//JARVIS//Bridge//EN\r\n' +
            'BEGIN:VEVENT\r\n' +
            `UID:${uid}\r\n` +
            `DTSTAMP:${stamp(new Date())}\r\n` +
            `DTSTART:${startStamp}\r\n` +
            `DTEND:${endStamp}\r\n` +
            `SUMMARY:${escapeIcsText(args.summary)}\r\n` +
            (args.location ? `LOCATION:${escapeIcsText(args.location)}\r\n` : '') +
            'END:VEVENT\r\n' +
            'END:VCALENDAR\r\n'

          let res
          try {
            res = await davRequest('PUT', `${PRINCIPAL_PATH()}jarvis-${uid}.ics`, {
              body: ics,
              contentType: 'text/calendar; charset=utf-8',
            })
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Could not create event: ${err?.message ?? err}` }] }
          }
          if (res.status !== 201 && res.status !== 204) {
            return { isError: true, content: [{ type: 'text', text: `Calendar server said ${res.status} creating the event.` }] }
          }
          return { content: [{ type: 'text', text: `Termin angelegt: ${args.summary}.` }] }
        },
      ),
    ],
  })
}
