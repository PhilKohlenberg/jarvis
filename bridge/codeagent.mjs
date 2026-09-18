import { createSdkMcpServer, tool, query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * JARVIS's hands on real code: a fresh, independent Claude Code session,
 * spawned per task, with the full run of Bash/Edit/Write in one project
 * directory — the same thing Phil gets from typing `claude` in a terminal,
 * just started by voice instead.
 *
 * Deliberately the biggest hammer in this bridge. Everything else here
 * (mail, the vault, the TOUR32 folder) is bounded — one email, one file, one
 * append. A coding session is not: it can install packages, run arbitrary
 * shell commands, rewrite any file it can see, push to git. That is why this
 * whole server answers to ALLOW_WRITES, the same hard switch already gating
 * raw Bash and file writes elsewhere in this bridge, rather than the
 * lighter voice-gated pattern mail_send and tour32_append_case use — those
 * are each one bounded action described back before it happens; this is an
 * open-ended session that can do a great many things across many minutes
 * with nobody watching the terminal.
 *
 * Synchronous for now: the tool call blocks until the whole session
 * finishes, which is fine for a task worth a few minutes and a bad fit for
 * anything longer — JARVIS goes silent for the duration, and voice has no
 * good way to show progress partway through a multi-minute build.
 */

const MODEL = process.env.JARVIS_CODE_MODEL ?? 'claude-sonnet-5'
const MAX_TURNS = 60

const RUN_DESCRIPTION = `Hand off a coding task to a real, independent Claude Code
session running in one project directory, with full shell and file access
there — install packages, edit files, run tests, commit. This can take
several minutes and changes real files on Phil's machine; there is no undo.

Only call this after Phil has clearly asked, in this conversation, for
something to be built, fixed or changed in a specific project. The task you
pass in is the ENTIRE brief that session gets — it starts with no memory of
this conversation, so restate everything it needs: what to do, which project,
any constraints Phil mentioned. Vague instructions produce a vague result;
spell it out the way you'd brief a colleague who just walked in.`

export function codeAgentServer() {
  return createSdkMcpServer({
    name: 'jarvis_code',
    version: '1.0.0',
    instructions:
      'A real coding agent, one task at a time, in a project directory Phil names. ' +
      'The biggest hammer this bridge has — only reach for it once Phil has clearly ' +
      'asked for code to be written or changed, and tell him what you are about to ' +
      'do before you start, since it can run for minutes.',
    alwaysLoad: true,
    tools: [
      tool(
        'code_run_task',
        RUN_DESCRIPTION,
        {
          project: z.string().describe('Absolute path to the project directory the task runs in.'),
          task: z.string().describe('The complete brief for the task — restate everything relevant, this session starts with no other context.'),
        },
        async (args) => {
          const dir = resolve(String(args.project ?? ''))
          if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            return { isError: true, content: [{ type: 'text', text: `Not a real directory: ${dir}` }] }
          }
          try {
            const session = query({
              prompt: String(args.task ?? ''),
              options: {
                cwd: dir,
                model: MODEL,
                maxTurns: MAX_TURNS,
                // Phil's own machine, the same trust level running `claude`
                // in a terminal already has — this tool's own gate
                // (ALLOW_WRITES, in server.mjs) is what stands between voice
                // and that trust, not a second permission layer in here.
                permissionMode: 'bypassPermissions',
              },
            })
            let resultText = ''
            for await (const msg of session) {
              if (msg.type === 'result') {
                resultText =
                  msg.subtype === 'success'
                    ? msg.result ?? ''
                    : `Task ended without finishing (${msg.subtype}).`
              }
            }
            return { content: [{ type: 'text', text: resultText || 'Task finished with no summary.' }] }
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Task failed: ${err?.message ?? err}` }] }
          }
        },
      ),
    ],
  })
}
