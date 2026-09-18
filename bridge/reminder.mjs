import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Spoken reminders. Deliberately in-memory only — a `setTimeout` per
 * reminder, nothing written to disk. It survives for as long as the bridge
 * process does, which is the same lifetime mailwatch.mjs and
 * statuswatch.mjs already assume for their own background work, and a
 * reminder that outlives a bridge restart is not something a single-user
 * voice assistant needs to promise.
 *
 * `notify` is the same broadcast+push callback server.mjs already wires up
 * for mail and status alerts — a reminder firing is exactly that kind of
 * event, unscoped to any particular conversation turn.
 */
const REMIND_DESCRIPTION = `Set a one-off spoken reminder. Fires once, after
the given number of minutes, as a notification (spoken immediately,
whichever tab is open — same channel as a new-mail alert). Not persisted:
a bridge restart cancels every pending reminder. Use whenever Phil asks to
be reminded or asks for a timer.`

export function reminderServer(notify) {
  return createSdkMcpServer({
    name: 'jarvis_reminder',
    version: '1.0.0',
    instructions: 'Set spoken reminders with remind_me. In-memory only — a bridge restart cancels them.',
    alwaysLoad: true,
    tools: [
      tool(
        'remind_me',
        REMIND_DESCRIPTION,
        {
          minutes: z.number().min(1).max(1440).describe('Minutes from now, 1–1440 (24h).'),
          text: z.string().describe('What to be reminded of — spoken back verbatim-ish when it fires.'),
        },
        async (args) => {
          const minutes = args.minutes
          const text = String(args.text ?? '').trim()
          if (!text) return { isError: true, content: [{ type: 'text', text: 'Reminder text must not be empty.' }] }
          setTimeout(() => notify(`Erinnerung: ${text}`), minutes * 60_000)
          return { content: [{ type: 'text', text: `Erinnerung in ${minutes} Minuten gesetzt.` }] }
        },
      ),
    ],
  })
}
