import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ImapFlow } from 'imapflow'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomUUID } from 'node:crypto'

/**
 * JARVIS's inbox: Phil's Tobit David mailbox, reached over plain IMAP/SMTP —
 * not Gmail, not a Google Workspace API. David exposes standard IMAP/SMTP
 * once "Remote Access nutzen" is switched on for the account, so this needs
 * no vendor SDK, only imapflow (IMAP) and a hand-rolled SMTP client (below —
 * see why nodemailer doesn't work here).
 *
 * Same shape as obsidian.mjs: reading opens a connection, does one thing,
 * closes it again — no persistent session to keep in sync with a mailbox
 * that other clients (Outlook, the David client itself) are also touching
 * concurrently.
 *
 * David's server certificate on the LAN is self-signed (confirmed while
 * wiring this up: the connection only completed with certificate validation
 * off), so TLS is used for confidentiality on the local network but not for
 * server identity — acceptable for a private LAN mail server, not for
 * anything reached over the open internet.
 */

const HOST = process.env.JARVIS_MAIL_HOST ?? ''
const IMAP_PORT = Number(process.env.JARVIS_MAIL_IMAP_PORT ?? 143)
const SMTP_PORT = Number(process.env.JARVIS_MAIL_SMTP_PORT ?? 587)
const USER = process.env.JARVIS_MAIL_USER ?? ''
const PASSWORD = process.env.JARVIS_MAIL_PASSWORD ?? ''

/** True once host/user/password are all set — the tools no-op with a plain
 *  message otherwise, rather than the bridge crashing at boot. */
export const mailConfigured = () => Boolean(HOST && USER && PASSWORD)

// Off by default because David's cert on the LAN is self-signed (confirmed
// while wiring this up — the connection only completed with validation off).
// Set JARVIS_MAIL_TLS_STRICT=1 once the server has a cert that validates.
const TLS_OPTS = { rejectUnauthorized: process.env.JARVIS_MAIL_TLS_STRICT === '1' }

function imapClient() {
  return new ImapFlow({
    host: HOST,
    port: IMAP_PORT,
    secure: false, // upgrades to STARTTLS automatically when the server offers it
    auth: { user: USER, pass: PASSWORD },
    tls: TLS_OPTS,
    logger: false,
  })
}

/**
 * David's Postman SMTP service (port 587) never lists AUTH in its EHLO
 * response — confirmed by hand while debugging the first send attempt — so
 * nodemailer, which only authenticates when the server advertises support
 * for it, silently connects anonymously and every RCPT then gets refused
 * with "550 No such user here". A raw AUTH LOGIN sent anyway is accepted
 * ("235 Authentication successful") — also confirmed by hand — so this talks
 * SMTP directly instead of trusting the capability list.
 */
function readSmtpReply(sock) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\r\n').filter(Boolean)
      const last = lines[lines.length - 1] ?? ''
      // A reply is done on a line "NNN text" (space) — "NNN-text" (dash)
      // means more lines follow.
      if (/^\d{3} /.test(last)) {
        cleanup()
        resolve({ code: Number(last.slice(0, 3)), text: buf })
      }
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      sock.removeListener('data', onData)
      sock.removeListener('error', onError)
    }
    sock.on('data', onData)
    sock.on('error', onError)
  })
}

async function smtpCommand(sock, cmd) {
  if (cmd != null) sock.write(cmd + '\r\n')
  const reply = await readSmtpReply(sock)
  if (reply.code >= 400) throw new Error(`SMTP said: ${reply.text.trim()}`)
  return reply
}

/** Escapes a line consisting of just "." per RFC 5321 dot-stuffing, and
 *  normalizes line endings — a body built from spoken text can arrive with
 *  bare \n, which some SMTP servers treat as a malformed line. */
function stuffDots(text) {
  return text.replace(/\r\n|\r|\n/g, '\r\n').replace(/^\./gm, '..')
}

// `to` and `subject` land directly in SMTP command lines and message
// headers, not just the body — a CRLF in either would inject a second SMTP
// command (e.g. a second RCPT TO, adding a hidden recipient) or a forged
// header (e.g. Bcc). Both are attacker-reachable indirectly: `to`/`subject`
// are whatever the model passes, and the model may be summarizing an email
// it just read that was crafted to make it do exactly that.
const EMAIL_RE = /^[^\s<>()[\]:;,"\\@]+@[^\s<>()[\]:;,"\\@]+\.[^\s<>()[\]:;,"\\@]+$/

function assertNoCrlf(value, label) {
  if (/[\r\n\0]/.test(value)) throw new Error(`${label} must not contain line breaks.`)
}

async function smtpSend({ to, subject, body }) {
  assertNoCrlf(to, 'Recipient')
  if (!EMAIL_RE.test(to)) throw new Error(`Not a plain email address: ${to}`)
  assertNoCrlf(subject, 'Subject')

  let sock = netConnect({ host: HOST, port: SMTP_PORT })
  const TIMEOUT_MS = 15_000
  sock.setTimeout(TIMEOUT_MS, () => sock.destroy(new Error('SMTP connection timed out')))
  try {
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })
    await readSmtpReply(sock) // 220 greeting
    await smtpCommand(sock, 'EHLO jarvis.local')
    await smtpCommand(sock, 'STARTTLS')
    sock = tlsConnect({ socket: sock, host: HOST, ...TLS_OPTS })
    await new Promise((resolve, reject) => {
      sock.once('secureConnect', resolve)
      sock.once('error', reject)
    })
    await smtpCommand(sock, 'EHLO jarvis.local')
    await smtpCommand(sock, 'AUTH LOGIN')
    await smtpCommand(sock, Buffer.from(USER, 'utf8').toString('base64'))
    await smtpCommand(sock, Buffer.from(PASSWORD, 'utf8').toString('base64'))
    await smtpCommand(sock, `MAIL FROM:<${USER}>`)
    await smtpCommand(sock, `RCPT TO:<${to}>`)
    await smtpCommand(sock, 'DATA')
    const headers =
      `From: ${USER}\r\nTo: ${to}\r\nSubject: ${subject}\r\n` +
      `Date: ${new Date().toUTCString()}\r\nMessage-ID: <${randomUUID()}@jarvis.local>\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`
    await smtpCommand(sock, headers + stuffDots(body) + '\r\n.')
    await smtpCommand(sock, 'QUIT')
  } finally {
    sock.destroy()
  }
}

async function saveDraft({ to, subject, body }) {
  assertNoCrlf(to, 'Recipient')
  if (!EMAIL_RE.test(to)) throw new Error(`Not a plain email address: ${to}`)
  assertNoCrlf(subject, 'Subject')

  const message =
    `From: ${USER}\r\nTo: ${to}\r\nSubject: ${subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\nMessage-ID: <${randomUUID()}@jarvis.local>\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n` +
    body.replace(/\r\n|\r|\n/g, '\r\n')

  const client = imapClient()
  try {
    await client.connect()
    await client.append(DRAFTS_FOLDER, message, ['\\Draft'])
  } finally {
    await client.logout().catch(() => {})
  }
}

const NOT_CONFIGURED = {
  isError: true,
  content: [
    {
      type: 'text',
      text: 'Mail is not configured — JARVIS_MAIL_HOST, JARVIS_MAIL_USER and JARVIS_MAIL_PASSWORD must be set.',
    },
  ],
}

function errorResult(prefix, err) {
  return { isError: true, content: [{ type: 'text', text: `${prefix}: ${err?.message ?? err}` }] }
}

function summarizeEnvelope(msg) {
  const from = msg.envelope?.from?.[0]
  const fromStr = from ? (from.name ? `${from.name} <${from.address}>` : from.address) : 'unknown'
  const date = msg.envelope?.date ? new Date(msg.envelope.date).toISOString().slice(0, 16).replace('T', ' ') : ''
  const flag = msg.flags?.has('\\Seen') ? ' ' : '*'
  return `${flag}[${msg.uid}] ${date}  ${fromStr}  —  ${msg.envelope?.subject ?? '(no subject)'}`
}

const LIST_DESCRIPTION = `List the most recent messages in a mail folder (default
INBOX), newest first. Each line shows the UID (use it with mail_read), an
unread marker, date, sender and subject. Use this to see what's new before
reading anything in full.`

const SEARCH_DESCRIPTION = `Search a mail folder by sender, subject or body text.
Returns the same summary lines as mail_list. Use this instead of mail_list when
looking for something specific rather than browsing what's recent.`

const READ_DESCRIPTION = `Read one message in full by its UID (from mail_list or
mail_search): sender, subject, date and the plain-text body. Marks it read.`

const DRAFTS_FOLDER = 'System/Entwürfe'

const DRAFT_DESCRIPTION = `Save an email as a draft in Phil's own mailbox
(${DRAFTS_FOLDER}) instead of sending it — he reviews and sends it himself from
his own mail client. Prefer this whenever Phil wants a message written but
hasn't clearly said to send it right now, or when the recipient is outside the
server's own domain (external send is currently refused by the mail server
itself — see mail_send's own error if that comes up).`

const SEND_DESCRIPTION = `Send an email from Phil's own mailbox. Real, irreversible
— it leaves the machine the moment this returns, and there is no undo.

Never call this speculatively, as part of "helping", or because a reply
seems to write itself. Call it only when Phil has, in this conversation,
explicitly told you to send this specific message — not implied it, not
asked what you'd write. If the recipient, subject or content is at all
uncertain, say back what you're about to send and get a yes before calling
this, in the same breath you'd use before any other action that can't be
undone.`

export function mailServer() {
  return createSdkMcpServer({
    name: 'jarvis_mail',
    version: '1.0.0',
    instructions:
      "Phil's mailbox on the Tobit David server. Reading (mail_list, mail_search, " +
      'mail_read) is always available. Sending (mail_send) only works when Phil ' +
      'has explicitly asked for that message to go out.',
    alwaysLoad: true,
    tools: [
      tool(
        'mail_list',
        LIST_DESCRIPTION,
        {
          folder: z.string().optional().catch(undefined).describe('Folder name, e.g. "INBOX". Defaults to INBOX.'),
          limit: z.number().int().min(1).max(50).optional().catch(undefined).describe('Max messages to return, default 15.'),
        },
        async (args) => {
          if (!mailConfigured()) return NOT_CONFIGURED
          const folder = args.folder || 'INBOX'
          const limit = args.limit ?? 15
          const client = imapClient()
          try {
            await client.connect()
            const lock = await client.getMailboxLock(folder)
            try {
              const total = client.mailbox.exists
              if (!total) return { content: [{ type: 'text', text: '(empty folder)' }] }
              const from = Math.max(1, total - limit + 1)
              const lines = []
              for await (const msg of client.fetch(`${from}:${total}`, { envelope: true, flags: true, uid: true })) {
                lines.push(summarizeEnvelope(msg))
              }
              lines.reverse()
              return { content: [{ type: 'text', text: lines.join('\n') }] }
            } finally {
              lock.release()
            }
          } catch (err) {
            return errorResult('Could not list mail', err)
          } finally {
            await client.logout().catch(() => {})
          }
        },
      ),

      tool(
        'mail_search',
        SEARCH_DESCRIPTION,
        {
          query: z.string().describe('Text to search for.'),
          field: z.enum(['subject', 'from', 'body']).optional().catch(undefined).describe('Where to search. Defaults to subject.'),
          folder: z.string().optional().catch(undefined).describe('Folder name. Defaults to INBOX.'),
          limit: z.number().int().min(1).max(50).optional().catch(undefined).describe('Max results, default 15.'),
        },
        async (args) => {
          if (!mailConfigured()) return NOT_CONFIGURED
          const folder = args.folder || 'INBOX'
          const field = args.field || 'subject'
          const limit = args.limit ?? 15
          const client = imapClient()
          try {
            await client.connect()
            const lock = await client.getMailboxLock(folder)
            try {
              const criteria =
                field === 'from' ? { from: args.query } : field === 'body' ? { body: args.query } : { subject: args.query }
              const uids = await client.search(criteria, { uid: true })
              if (!uids?.length) return { content: [{ type: 'text', text: 'No messages matched.' }] }
              const wanted = uids.slice(-limit)
              const lines = []
              for await (const msg of client.fetch(wanted, { envelope: true, flags: true, uid: true }, { uid: true })) {
                lines.push(summarizeEnvelope(msg))
              }
              lines.reverse()
              return { content: [{ type: 'text', text: lines.join('\n') }] }
            } finally {
              lock.release()
            }
          } catch (err) {
            return errorResult('Search failed', err)
          } finally {
            await client.logout().catch(() => {})
          }
        },
      ),

      tool(
        'mail_read',
        READ_DESCRIPTION,
        {
          uid: z.number().int().describe('Message UID, from mail_list or mail_search.'),
          folder: z.string().optional().catch(undefined).describe('Folder name. Defaults to INBOX.'),
        },
        async (args) => {
          if (!mailConfigured()) return NOT_CONFIGURED
          const folder = args.folder || 'INBOX'
          const client = imapClient()
          try {
            await client.connect()
            const lock = await client.getMailboxLock(folder)
            try {
              const msg = await client.fetchOne(String(args.uid), { envelope: true, source: false, bodyStructure: true }, { uid: true })
              if (!msg) return { isError: true, content: [{ type: 'text', text: `No message with UID ${args.uid} in ${folder}.` }] }
              const { content: bodyContent } = await client.download(String(args.uid), 'TEXT', { uid: true }).catch(() => ({ content: null }))
              let body = ''
              if (bodyContent) {
                const chunks = []
                for await (const chunk of bodyContent) chunks.push(chunk)
                body = Buffer.concat(chunks).toString('utf8')
              }
              const from = msg.envelope?.from?.[0]
              const fromStr = from ? (from.name ? `${from.name} <${from.address}>` : from.address) : 'unknown'
              const to = (msg.envelope?.to ?? []).map((t) => t.address).join(', ')
              const header =
                `From: ${fromStr}\nTo: ${to}\nSubject: ${msg.envelope?.subject ?? '(no subject)'}\n` +
                `Date: ${msg.envelope?.date ?? ''}\n\n`
              return { content: [{ type: 'text', text: header + body.trim() }] }
            } finally {
              lock.release()
            }
          } catch (err) {
            return errorResult('Could not read message', err)
          } finally {
            await client.logout().catch(() => {})
          }
        },
      ),

      tool(
        'mail_send',
        SEND_DESCRIPTION,
        {
          to: z.string().describe('Recipient email address.'),
          subject: z.string().describe('Subject line.'),
          body: z.string().describe('Plain-text body.'),
        },
        async (args) => {
          if (!mailConfigured()) return NOT_CONFIGURED
          try {
            await smtpSend({ to: args.to, subject: args.subject, body: args.body })
            return { content: [{ type: 'text', text: `Sent to ${args.to}.` }] }
          } catch (err) {
            return errorResult('Send failed', err)
          }
        },
      ),

      tool(
        'mail_draft',
        DRAFT_DESCRIPTION,
        {
          to: z.string().describe('Recipient email address.'),
          subject: z.string().describe('Subject line.'),
          body: z.string().describe('Plain-text body.'),
        },
        async (args) => {
          if (!mailConfigured()) return NOT_CONFIGURED
          try {
            await saveDraft({ to: args.to, subject: args.subject, body: args.body })
            return { content: [{ type: 'text', text: `Saved as a draft to ${args.to} — review and send it yourself.` }] }
          } catch (err) {
            return errorResult('Could not save draft', err)
          }
        },
      ),
    ],
  })
}
