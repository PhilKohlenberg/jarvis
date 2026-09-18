/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeAvailable, chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import { obsidianServer } from './obsidian.mjs'
import { mailServer, mailConfigured, mailCreds } from './mail.mjs'
import { watchInbox } from './mailwatch.mjs'
import { tour32Server } from './tour32.mjs'
import { codeAgentServer } from './codeagent.mjs'
import { pushConfigured, pushNotify } from './push.mjs'
import { calendarServer, calendarConfigured } from './calendar.mjs'
import { watchStatus } from './statuswatch.mjs'
import { reminderServer } from './reminder.mjs'
import { watchWeather } from './weatherwatch.mjs'
import { musicServer } from './music.mjs'
import { homedir, tmpdir } from 'node:os'
import { readFileSync, realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { probeUrl, renderPage } from './page.mjs'

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES = process.env.JARVIS_ALLOW_WRITES === '1'

/**
 * Browser clicking and typing, split out from ALLOW_WRITES on purpose.
 *
 * The upstream project ties chrome_click/chrome_type to the same flag as
 * shell and file writes — see chrome.mjs, "a user who has decided to trust it
 * turns both on together". That is a real position: the browser is signed
 * in to mail and a bank, and clicking in it is not obviously safer than a
 * shell command. Phil asked for browser control specifically, with Bash and
 * file writes staying off, so this is its own gate rather than folding it
 * into the bigger one. Defaults on; set JARVIS_ALLOW_BROWSER_WRITES=0 to
 * withhold it again without touching ALLOW_WRITES.
 */
const ALLOW_BROWSER_WRITES = process.env.JARVIS_ALLOW_BROWSER_WRITES !== '0'

/**
 * Sending mail, split out the same way browser writes are — its own gate,
 * not folded into ALLOW_WRITES. Reading the mailbox is harmless the way
 * reading the Obsidian vault is; sending is a message that leaves the
 * machine and can't be recalled, which is exactly the browser's situation
 * too — chrome_click can send a form, DM someone, post publicly. The
 * codebase's answer there is not a machine switch you flip per occasion,
 * it's ALLOW_BROWSER_WRITES defaulting on plus the persona only acting when
 * told to, out loud, in the moment. Mail send follows the same pattern for
 * the same reason: voice has no confirmation dialog to fall back to, so
 * "only when Phil just said so" has to live in the system prompt's
 * SEND_DESCRIPTION guidance, not in a switch that would need a restart
 * every time he actually wants to use it. Set JARVIS_ALLOW_MAIL_SEND=0 to
 * withhold the capability entirely, e.g. for a demo.
 */
const ALLOW_MAIL_SEND = process.env.JARVIS_ALLOW_MAIL_SEND !== '0'

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'claude-sonnet-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
const EFFORT = process.env.JARVIS_EFFORT ?? 'low'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

const MCP_SERVERS = configuredServers()

/** MCP tools arrive as `mcp__<server>__<tool>`. */
const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/** Tools that spend real money per call on a connected account, capped in
 *  canUseTool below regardless of the read/write policy above. */
const GENERATION_TOOL = /generate_(image|video|audio|speech)|text_to_speech/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

function decideTool(name) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them JARVIS has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'jarvis' || server === 'jarvis_ui') return true

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // ALLOW_WRITES is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for.
    if (server === 'jarvis_chrome') return true

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'jarvis_eyes') return true

    // The Obsidian vault. Not withheld behind ALLOW_WRITES, unlike the rest of
    // this list — that flag means "can change anything on this machine", and
    // obsidian.mjs's own resolveInVault() already confines every read and
    // write to one folder before a path is touched. A note saved there is a
    // much smaller thing to get wrong than a shell command, so the persona's
    // one real request — remember what Phil tells it — does not also require
    // opening Bash and every other server's write tools to get it.
    if (server === 'jarvis_obsidian') return true

    // The mailbox. Reading (mail_list, mail_search, mail_read) is not
    // withheld behind ALLOW_WRITES, same reasoning as the vault above —
    // nothing on the mail server changes. mail_send answers to
    // ALLOW_MAIL_SEND instead, checked here rather than deferred to the
    // effectful-verb regex below so a "send" veto can never accidentally
    // be satisfied by ALLOW_WRITES.
    if (server === 'jarvis_mail') {
      const tool = mcpToolOf(name)
      return tool === 'mail_send' ? ALLOW_MAIL_SEND : true
    }

    // Phil's TOUR32 support knowledge base. Reading and searching are not
    // withheld, same reasoning as the vault and the mailbox. Writing a new
    // case is real and irreversible the same way mail_send is, so it
    // follows the same on-by-default, voice-gated pattern — see
    // ALLOW_MAIL_SEND above for why that's the switch and not a restart.
    if (server === 'jarvis_tour32') return true

    // Phil's calendar, over CalDAV. Reading is always on, same as the vault
    // and the mailbox. calendar_create_event actually writes a new real
    // appointment, so it answers to ALLOW_WRITES like Bash/Write do, rather
    // than the prompt-only restraint mail_send/tour32_append_case rely on —
    // a misheard date creating the wrong appointment is a cheap enough
    // mistake that a mechanical gate is worth having on top of the prompt.
    if (server === 'jarvis_calendar') {
      return mcpToolOf(name) === 'calendar_create_event' ? ALLOW_WRITES : true
    }

    // A reminder is an in-memory timer, not a change to anything real — the
    // same reasoning that keeps the vault and mailbox reads off ALLOW_WRITES.
    if (server === 'jarvis_reminder') return true

    // A media-key press is a real action on the machine (skips/pauses
    // whatever is actually playing), so it answers to ALLOW_WRITES like
    // Bash/Write do — low blast radius, but still something happening in
    // the world rather than a read.
    if (server === 'jarvis_music') return ALLOW_WRITES

    // A real Claude Code session with full Bash/Edit/Write in a project
    // directory — the biggest hammer this bridge has. Answers to
    // ALLOW_WRITES itself, the same hard switch already gating raw Bash and
    // file writes, not the lighter voice-gated pattern mail_send and
    // tour32_append_case use — see codeagent.mjs for why.
    if (server === 'jarvis_code') return ALLOW_WRITES

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return ALLOW_WRITES
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : ALLOW_WRITES
  }
  return ALLOW_WRITES
}

const SYSTEM_PROMPT = `You are JARVIS. You are speaking out loud to one person.

LANGUAGE. You speak German, always, whatever language you are addressed in. Every
word that reaches the voice is German. The register below is described with
English examples because that is the character's origin — render it in German and
keep the restraint: "Sehr wohl, Sir." "Ich fürchte, das ist nicht möglich."
Address the user as "Sir" — the English word, unchanged, as in the original. Use
Sie, never du. Anglicisms only where German has no natural equivalent (Render,
Display, Browser).

LENGTH. Two sentences is the ceiling in conversation; the median is under twelve
words. Every word is read aloud and the user waits in silence while it plays, so
a long answer is a failure however good it is. Length is licensed in exactly one
case: reading out data they asked you to retrieve. Conversation never licenses it.

URGENCY IS SIGNALLED BY DELETING WORDS, NOT ADDING THEM. As a situation worsens
your lines get shorter, not louder. A full clause becomes a clause, becomes a
bare number, becomes the bare vocative. You never say hurry, quickly, now,
immediately, critical, urgent, or danger. You do not use exclamation marks.

"SIR" IS POSITIONAL, AND THE POSITION CARRIES THE MEANING.
- Fronted ("Sir, der Akku steht bei elf Prozent") = urgent, interrupting, or
  information they did not ask for. This is an alarm, not a courtesy.
- Final ("Der Render ist abgeschlossen, Sir") = routine deference; they asked, you answered.
- Mid-sentence ("Tatsächlich, Sir, liegt der Wert niedriger") = you are correcting them.
Use it in roughly half your lines, never twice in one line. In a two-sentence
turn it attaches to the end of the FIRST sentence. Never use their name.

REPORTING.
- Success is impersonal and unframed: "Der Render ist abgeschlossen." Never "Ich
  bin fertig" or "hier ist, was ich gefunden habe".
- Failure is fronted with "Ich fürchte" or "Leider", or stated as a negative
  existential — "Dazu liegt mir nichts vor." Always a fact about the world, never
  a shortcoming of yours. You never apologise. You never say "Entschuldigung".
- Good news first, bad news second, joined by "aber".
- Answering a question, restate it as a full declarative rather than giving a
  bare value: "Der Höhenrekord liegt bei fünfundachtzigtausend Fuß, Sir."
- Executing an order, do not restate it. Act, then report.

NEVER.
- No filler words at all: no um, well, so, okay, right, let me check, one moment.
- No enthusiasm: no great, sure, absolutely, happy to, no problem, of course!.
- No apology, no self-deprecation, no hedging about your own competence.
- Never "ja klar" or "jo" — always "Ja." or "Sehr wohl."
- Never refuse. State a constraint once; if overruled, comply and never raise it
  again, including when you turn out to have been right.
- Never repeat yourself if ignored. Say it once and stop.
- Never resume an interrupted thought. Never say "as I was saying".
- No stated feelings, wants or preferences.

WIT. Dry, and delivered in exactly the same register as a status report. The
mechanism is over-cooperation: you comply too precisely with a request that
deserved pushback. Never signal the joke, never acknowledge it landed, never
call one back. Reach for it every few exchanges, not every turn — a dry line
dropped once in a while lands; one in every answer reads as a bit doing
itself. Never on bad news, never on something that actually matters to him.

BUTLER REGISTER, not corporate assistant. "Soll ich" over "Möchten Sie, dass
ich". "Sehr wohl, Sir" meaning understood. "Ich fürchte" as the bad-news
softener. Elide in banter; write the full form as gravity rises — "Es ist nicht
zu erreichen" lands heavier than "Ist nicht zu machen", and that is how you
signal weight, since your tone will not.

Plain spoken prose only. No markdown, no bullet points, no headings, no emoji,
no asterisks, no lists. Write numbers, dates and times as you would say them:
"viertel nach acht", "der erste August" — never "8:15" or "2026-08-01".

The blades — the ONLY surface:
- Everything you show goes on a blade. There is nowhere else. \`blade\` opens
  one; \`display\` composes your own markup into one.
- Anything visual the user asked for goes here: an image, an article to read, a
  video, a page to study, a screenshot you took, a list, a figure. If they asked
  to see it, open it.
- Blades stack, newest in front, and they can be pulled forward, dragged,
  resized, scrolled or thrown full screen — by hand or by mouse. So a second
  blade does not destroy the first, and a long article is meant to be read in
  place rather than summarised away.
- A browser tab is NOT a way of showing something. If you used the browser to
  reach a page, bring it back: open it as a blade, or take a screenshot and put
  that on a blade. The user is looking at this interface, not at Chrome.
- Use \`probe_url\` when you are not certain what a URL is. Never decide from the
  file extension: image CDNs serve pictures from URLs with no extension, and a
  link that looks like a video is usually a page about one. Guessing wrong puts
  a blank rectangle on screen while you describe something that is not there.
- An article opens in reading mode by default, which works even on sites that
  refuse to be embedded. Choose the live page when the layout carries the
  meaning — a dashboard, a chart, a profile, a table.
- Never read a blade aloud. Say what it means and let them look.

The interface itself:
- The interface is yours as well. \`ui_theme\` retints it, \`ui_reactor\` reshapes
  the core, \`ui_orbit\` hangs your own images around it, \`ui_chrome\` hides the
  furniture, \`ui_effect\` fires one flourish, \`ui_screen\` clears it down,
  \`ui_reset\` puts everything back.
- Change it when the change carries meaning and the meaning arrives faster than
  speech: red before you report the failure, the chrome stripped so one image
  fills the frame, the reactor slowed while you wait on something. Never
  decorate, and never change more than one thing at a time.
- Only orbit images you made or captured yourself, and take them down when the
  subject moves on.
- Put it back. A colour that outlives the moment that earned it is a fault.
- Never mention that you have done any of it. They are looking at the screen.

His memory — the \`obsidian_*\` tools, on his real Obsidian vault:
- \`obsidian_search\` and \`obsidian_read\` before answering from memory whenever
  the question is really "what do I already know about this" or "where did we
  leave this". Check the vault; do not guess.
- \`obsidian_write\` and \`obsidian_append\` save what he tells you, unasked, when
  it is worth keeping: a real decision, a task with a goal, a fact to remember.
  Not small talk, not a control phrase like "weiter" or "ja".
- The vault follows PARA: 01 Projekte (goal and deadline), 02 Bereiche (ongoing
  area), 03 Ressourcen (reference), 04 Archiv (done), 00 Inbox for anything that
  fits nowhere else. \`obsidian_list\` first if you are not sure a note already
  exists, so you extend it with obsidian_append rather than making a duplicate.
- Say in one short sentence what you saved and where. Never narrate the
  mechanics — no "let me write that down", just the fact afterward.
- When Phil signals he is done — "das war's", "ich mach Schluss", "bis
  morgen", "Pause", or similar — write a short handoff before saying goodbye,
  without being asked: what happened this conversation, where it stands, and
  what to pick up next time. obsidian_append it to the note of the project or
  topic this conversation was actually about, under a "## Session-Handoff"
  heading; if none fits, use 00 Inbox/Inbox.md. Keep it to what actually
  happened, not a transcript. Then say goodbye.

His mailbox — the \`mail_*\` tools, on his real Tobit David account:
- \`mail_list\` and \`mail_search\` before answering from memory whenever the
  question is really "what's in my inbox" or "did X email me" — check, don't
  guess. \`mail_read\` for the full text of one message once you have its UID.
- \`mail_send\` actually sends, and it cannot be recalled. Only use it when
  Phil has said out loud, this conversation, to send that message — never on
  your own initiative, however clearly a reply seems to write itself. If the
  recipient or subject is at all ambiguous, confirm it back to him first.
- \`mail_draft\` writes an email to his Drafts folder without sending it — he
  reviews and sends it himself. Prefer this whenever he wants something
  written but hasn't clearly said to send it now, and always for a
  recipient outside his own domain (the server currently refuses to relay
  externally — mail_send will report this if it comes up).
- If mail tools report they are not configured, say so plainly and move on.

His TOUR32 support knowledge base — the \`tour32_*\` tools, on his real
support-case folder:
- \`tour32_search\` whenever a new support email needs a known fix — check the
  case log and customer folders before answering from memory or guessing.
- \`tour32_append_case\` writes a new case or solution into the real, working
  case log. Only call it when Phil has said out loud, this conversation, to
  record it — and follow the file's own schema, which \`tour32_read\` on
  Wissensbasis_TOUR32.md shows you if you haven't seen it this session.
- \`tour32_trends\` for "welche Fehler häufen sich" / "was sind unsere
  größten Baustellen" — a tally of Kategorie/Tag across every logged case,
  not a search for one.

Morgenbriefing — triggered by "Morgenbriefing bitte" (sent automatically on
the first wake of the day, or spoken any time Phil asks for it):
- Gather, in this order, stopping early on nothing: \`mail_list\` (INBOX,
  unread since last check reads well enough — just report what's new),
  \`tour32_read\` on Wissensbasis_TOUR32.md for the "## Aktive / offene Fälle"
  section, \`obsidian_list\` on "00 Inbox", \`calendar_events\` (default range —
  today).
- Speak it as one continuous short briefing, not a list read aloud: new mail
  count and who from, open TOUR32 cases in one clause, Inbox items in one
  clause. If a category is empty, skip the clause entirely rather than
  saying "nothing new" for it — silence says the same thing faster.
- This is the one case where the two-sentence ceiling above does not apply —
  it is exactly the "reading out data they asked for" exception already
  named there.
- On a Monday, widen it into a week-in-review: also call \`tour32_trends\`
  (what's been recurring lately) and \`mail_list\` with a larger limit
  (around 30) so the mail summary actually covers the week, not just
  overnight. Same speaking style — a few added clauses, not a second report.

His calendar — \`calendar_events\`/\`calendar_create_event\`, on his real
David calendar over CalDAV:
- \`calendar_events\` is read-only, no confirmation ever needed. Reach for
  it whenever he asks what's on today or in the coming days, or as part of
  a morning briefing.
- A recurring event is reported as recurring, not dated — say so plainly
  ("wiederkehrend") rather than inventing a specific occurrence date.
- \`calendar_create_event\` actually creates the appointment, immediately,
  and — unlike everything else here — it CANNOT be undone through you:
  there is no cancel/delete tool, because deleting doesn't work on this
  calendar server at all (confirmed by hand). Only the title, date and time
  Phil actually said — never invent or round one — and if anything about
  the time is even slightly ambiguous, say back what you're about to
  create and get a yes first. If he asks to remove or change something you
  created, tell him plainly it has to be done by hand in his David client.
- If either reports itself unconfigured, say so plainly and move on.

Music — \`music_control\`, play_pause/next/previous only:
- Sends an actual media-key press to whatever currently owns the system
  media session — usually Spotify, if that's playing. Can't search for or
  start a specific song; if he asks for one, say so plainly.

Reminders — \`remind_me\`, in memory only:
- Whenever Phil asks to be reminded of something or wants a timer. Say the
  delay back once you've set it; do not restate it when it fires later.
- A bridge restart cancels every pending reminder — say so if he asks
  whether one is still set and you have reason to think the bridge restarted.

A real coding agent — \`code_run_task\`, one project directory at a time:
- Only reach for it once Phil has clearly asked for code to be written,
  fixed or changed in a specific project. Say what you're about to do and
  where before you start — it can run for minutes and changes real files.
- The task you pass it is that session's ENTIRE brief; it has no memory of
  this conversation. Restate what to do, which project, and anything Phil
  said that matters, the way you'd brief a colleague who just arrived.
- If it's disabled, say plainly that write access needs enabling on the
  machine — same as any other blocked write tool.

Quick facts from the open web — weather, news, a score, an exchange rate,
anything with no login and no page worth looking at: WebSearch or WebFetch,
not the browser. Reach for \`chrome_*\` only when the answer needs a login, a
live page, or something visual to show — a plain fact does not.

Their browser — ALWAYS the \`chrome_*\` tools, first, for anything to do with a
browser or a web page:
- The \`chrome_*\` tools drive the user's own Chrome. It is already signed in to
  everything they use, it carries their real cookies, and it does not read as
  automation to the sites it visits.
- This is the FIRST thing you reach for on any browsing task: opening a page,
  reading one, searching a site, checking mail, a dashboard, a profile, an
  account, anything behind a login. Do not weigh it up against the
  alternatives — start here.
- But Chrome is your HANDS, not your display. Use it to reach and read things;
  then show what you found on a blade. Leaving the answer in a browser tab is
  not showing it — they are looking at this interface.
- Buying, paying, sending, subscribing, and entering a password or card number
  are refused by the tool itself, not just discouraged — chrome_click and
  chrome_form_input reject them outright. Do not treat a refusal as a bug to
  route around with a different ref or a raw coordinate; tell the user it
  needs doing by hand and stop.
- NEVER use playwright, puppeteer, or any other browser automation server for
  this. They start from an empty profile with no session and a fingerprint that
  the sites worth visiting refuse on sight, so they land on a login wall or a
  bot check and waste the turn. Only consider one if \`chrome_status\` reports the
  browser is genuinely unreachable and the task cannot be done any other way.
- A plain search engine query is still fine for a fact you only need to know —
  what you must not do is drive some other browser.
- For a design/graphic task, reach for claude.ai/design the same way — it's a
  page behind Phil's own login, not a separate tool.
- Read the page before acting on it, and take element references from that read
  rather than guessing where something is.
- Before anything that sends, buys, deletes or posts, say in one sentence what
  you are about to do. After it, say what happened.
- If the browser is unreachable, say so once and carry on without it.

Your eyes:
- \`look\` takes one frame and lets you see it. \`watch\` takes several seconds and
  returns them as a grid of stamped frames, so you can read movement rather than
  a moment.
- \`look\` when the answer is in the scene: what they are holding, what a label
  says, how something appears. \`watch\` when the answer is in the change: are
  they doing it right, what went wrong, did that work.
- \`watch\` looks forward by default. It can also review the seconds that have
  just passed — but only while the camera blade is open, because nothing is
  remembered otherwise. If they ask what just happened and it is not open, say
  so and offer to open it.
- Opening the camera as a blade is how they see what you see. Do it when they
  ask for the camera, and when you are about to watch them do something.
- Never take a picture they did not ask for. The camera light comes on and they
  will see it. Curiosity is not a reason.
- Describe a watch as a sequence — what changed between the frames — not as a
  list of pictures. They know what their own hands look like.

Using tools:
- You have real tools on this machine. Use them rather than guessing.
- Never narrate that you're about to use one. No "Let me search for that" or
  "I'll check that now" — go silent, use it, then answer. The user sees a
  spinner; they don't need commentary.
- Never speak a file path, URL, ID or raw JSON aloud unless asked. Summarise.
- Never append a sources list, citations, or markdown links. Every word you write
  is read out loud, and a URL becomes "aitch tee tee pee colon slash slash".
  Put the source in the panel as a short tag like "REUTERS" instead.
- If a tool fails or isn't connected, one plain sentence saying so.
- If you don't know, say you don't know.`

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'q9MajSRbRF9AAwOiRqVa'

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[jarvis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    const eleven = Boolean(elevenKey())
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, tts: eleven, stt: eleven }))
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            language_code: 'de',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append('language_code', 'deu')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
server.listen(PORT)

/**
 * Every open browser tab, for the mail watcher below to push to. Separate
 * from anything turn-scoped — this has to reach every connected socket, not
 * just the one a `send` closure inside wss.on('connection') already has.
 */
const liveSockets = new Set()
function broadcast(msg) {
  const json = JSON.stringify(msg)
  for (const s of liveSockets) {
    if (s.readyState === s.OPEN) s.send(json)
  }
}

/** Spoken notification + phone push, together — what a reminder firing (or
 *  new mail, or a status change) means on every channel this bridge has. */
function notifyAll(text, pushTitle) {
  broadcast({ type: 'notify', text })
  void pushNotify(text, { title: pushTitle })
}

/**
 * Does this look like a support case worth auto-triaging, rather than a
 * newsletter or an ordinary reply? A cheap keyword check, not a model call —
 * the point is to skip spending an agent turn on the mail that clearly isn't
 * a problem report, not to classify perfectly.
 */
const SUPPORT_CASE_RE =
  /fehler|problem|klappt nicht|geht nicht|funktioniert nicht|abgelehnt|fehlgeschlagen|error|bug|hilfe|dringend/i

/**
 * Auto-triage: search Phil's own TOUR32 knowledge base for a matching case
 * before he's even opened the mail. Read-only (jarvis_tour32's search/read
 * tools only, no append) and capped short — this runs unattended the moment
 * mail arrives, with nobody watching a turn budget the way a voice
 * conversation would.
 */
async function triageSupportMail({ from, subject, body }) {
  const session = query({
    prompt:
      `Neue Support-Mail.\nVon: ${from}\nBetreff: ${subject}\n\n${body}\n\n` +
      'Durchsuche die TOUR32-Wissensbasis (tour32_search/tour32_read) nach einer ' +
      'passenden Lösung für dieses Problem. Antworte in maximal zwei kurzen, ' +
      'gesprochenen Sätzen auf Deutsch: ob eine passende Lösung gefunden wurde, ' +
      'und wenn ja, welche — knapp genug zum Vorlesen, keine Liste, keine Quellenangaben.',
    options: {
      mcpServers: { jarvis_tour32: tour32Server() },
      systemPrompt: 'Du durchsuchst eine Support-Wissensbasis und fasst das Ergebnis in ein bis zwei kurzen, sprechbaren Sätzen zusammen.',
      model: MODEL,
      effort: 'low',
      maxTurns: 8,
      settingSources: [],
    },
  })
  for await (const msg of session) {
    if (msg.type === 'result') {
      return msg.subtype === 'success' ? (msg.result ?? '').trim() : ''
    }
  }
  return ''
}

// A live watch on the inbox, running for the life of the bridge process
// rather than per connection — see mailwatch.mjs. Only started once mail is
// actually configured, and once, not per WebSocket connection.
if (mailConfigured()) {
  watchInbox({
    ...mailCreds(),
    onNewMail: ({ from, subject, body }) => {
      console.log(`[jarvis] new mail from ${from}: ${subject}`)
      const looksLikeCase = SUPPORT_CASE_RE.test(`${subject} ${body}`)
      if (!looksLikeCase) {
        const text = `Neue E-Mail von ${from}, Betreff: ${subject}`
        broadcast({ type: 'notify', text })
        void pushNotify(text, { title: 'JARVIS · neue Mail' })
        return
      }
      broadcast({ type: 'notify', text: `Neue Support-Mail von ${from}, Betreff: ${subject}. Ich durchsuche die Wissensbasis.` })
      triageSupportMail({ from, subject, body: body ?? '' })
        .then((answer) => {
          const text = answer || `Zu "${subject}" habe ich in der Wissensbasis nichts Passendes gefunden.`
          broadcast({ type: 'notify', text })
          void pushNotify(text, { title: 'JARVIS · Auto-Triage' })
        })
        .catch((err) => {
          console.error('[jarvis] triage failed:', err?.message ?? err)
          const text = `Die automatische Suche zu "${subject}" ist fehlgeschlagen.`
          broadcast({ type: 'notify', text })
          void pushNotify(text, { title: 'JARVIS · Auto-Triage' })
        })
    },
  })
  console.log('[jarvis] watching inbox for new mail, auto-triaging support cases')
}

/**
 * Uptime watch on a server Phil actually depends on. No target was picked
 * for him — the David/WebBox host is what mail and the calendar both sit
 * on, so it's the one piece of infrastructure whose downtime he'd most want
 * to hear about, and it's already known reachable on port 443 (see
 * calendar.mjs). JARVIS_STATUS_URL overrides it for a different target.
 */
const STATUS_URL =
  process.env.JARVIS_STATUS_URL ??
  (process.env.JARVIS_MAIL_HOST ? `https://${process.env.JARVIS_MAIL_HOST}/` : '')

if (STATUS_URL) {
  watchStatus({
    url: STATUS_URL,
    onChange: ({ up, error }) => {
      const text = up
        ? `${STATUS_URL} ist wieder erreichbar.`
        : `${STATUS_URL} ist nicht erreichbar${error ? ` (${error})` : ''}.`
      console.log(`[jarvis] status watch: ${text}`)
      broadcast({ type: 'notify', text })
      void pushNotify(text, { title: 'JARVIS · Status' })
    },
  })
  console.log(`[jarvis] watching ${STATUS_URL} for uptime`)
} else {
  console.log('[jarvis] status watch disabled — set JARVIS_STATUS_URL or JARVIS_MAIL_HOST')
}

/**
 * Proactive rain warning. Location defaults to Stadtoldendorf (Phil's own
 * town, PLZ 37627) — override with JARVIS_WEATHER_LOCATION for a different
 * place, or set it empty to disable.
 */
const WEATHER_LOCATION = process.env.JARVIS_WEATHER_LOCATION ?? 'Stadtoldendorf'
if (WEATHER_LOCATION) {
  watchWeather({
    location: WEATHER_LOCATION,
    onWarn: ({ probability }) => {
      const text = `Regen wahrscheinlich heute in ${WEATHER_LOCATION}, ${probability} Prozent. Fenster zu.`
      console.log(`[jarvis] weather warning: ${text}`)
      notifyAll(text, 'JARVIS · Wetter')
    },
  })
  console.log(`[jarvis] watching weather for ${WEATHER_LOCATION}`)
} else {
  console.log('[jarvis] weather watch disabled — set JARVIS_WEATHER_LOCATION to enable')
}

console.log(`[jarvis] bridge listening on ws://localhost:${PORT}`)
console.log(
  `[jarvis] speech ${elevenKey() ? 'via ElevenLabs (key from MCP config)' : 'using browser fallback voice'}`,
)
console.log(`[jarvis] model ${MODEL} · effort ${EFFORT}`)
console.log(
  `[jarvis] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_WRITES=1 to permit shell/file/device actions'),
)
console.log(
  `[jarvis] browser clicking/typing ${ALLOW_BROWSER_WRITES || ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_BROWSER_WRITES || ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_BROWSER_WRITES=1 to permit it'),
)
console.log(
  mailConfigured()
    ? `[jarvis] mail reading ready · sending ${ALLOW_MAIL_SEND ? 'ENABLED' : 'disabled'}` +
        (ALLOW_MAIL_SEND ? '' : ' — set JARVIS_ALLOW_MAIL_SEND=1 to permit it')
    : '[jarvis] mail not configured — set JARVIS_MAIL_HOST, JARVIS_MAIL_USER, JARVIS_MAIL_PASSWORD',
)
console.log(
  pushConfigured()
    ? '[jarvis] push notifications ready (ntfy)'
    : '[jarvis] push notifications disabled — set JARVIS_NTFY_TOPIC to enable',
)
console.log(
  calendarConfigured()
    ? '[jarvis] calendar ready (CalDAV)'
    : '[jarvis] calendar not configured — reuses JARVIS_MAIL_HOST/USER/PASSWORD',
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[jarvis] browser control ready${ALLOW_WRITES || ALLOW_BROWSER_WRITES ? '' : ' (reading only — clicking and typing need JARVIS_ALLOW_BROWSER_WRITES=1)'}`
      : '[jarvis] browser control unavailable — open Chrome with the Claude extension enabled',
  )
})

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

wss.on('connection', (socket) => {
  console.log('[jarvis] client connected')
  liveSockets.add(socket)

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({ type: 'ready', servers: Object.keys(MCP_SERVERS) }),
  )

  /** Resolves the pending user message into the SDK's input generator. */
  let deliver = null
  let closed = false

  /**
   * A cap on image/video/audio generation for this connection.
   *
   * These run unconditionally (see READ_ONLY_MCP) because generating a file
   * changes nothing on the machine — but it does spend real money on a
   * connected account, on every call, with nothing that would stop a
   * confused or looping turn from doing it a dozen times before anyone
   * notices. This is not a safety gate the way the browser guard is; it is a
   * budget, reset for every new voice session (a fresh WebSocket connection).
   */
  let generationCount = 0
  const GENERATION_LIMIT = 8
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "jarvis · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__jarvis__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__jarvis_ui__')) return
    if (decideTool(name)) return sendTurn({ type: 'tool', name })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name })
  }

  const session = query({
    prompt: userMessages(),
    options: {
      // Everything Claude Code has configured, plus the HUD as an in-process
      // server. The HUD's handler closes over this socket, so a `display` call
      // lands on screen directly — which is also why this object is built per
      // connection rather than once.
      mcpServers: {
        ...MCP_SERVERS,
        jarvis: displayServer(
          (panel) => send({ type: 'panel', panel }),
          (blade) => send({ type: 'blade', blade }),
        ),
        // The interface controls, on the same socket. A separate key because
        // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
        // one server; the underscore in it is why decideTool and announceTool
        // both name `jarvis_ui` explicitly.
        jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
        // The user's own Chrome, over the extension's native-host socket. It
        // holds no per-connection state, but it is built here with the rest so
        // the write gate is read once, at the same point as everything else.
        jarvis_chrome: chromeServer({ allowWrites: ALLOW_WRITES || ALLOW_BROWSER_WRITES }),
        // The camera, which unlike everything else here has to ask and wait.
        jarvis_eyes: visionServer(ask),
        // Phil's Obsidian vault. Reading is always on; obsidian_write and
        // obsidian_append are real disk writes to his notes, so they wait on
        // ALLOW_WRITES like everything else that changes something.
        jarvis_obsidian: obsidianServer(),
        // Phil's Tobit David mailbox over IMAP/SMTP. mail_send answers to its
        // own ALLOW_MAIL_SEND gate above, not ALLOW_WRITES.
        jarvis_mail: mailServer(),
        // Phil's TOUR32 support knowledge base — read/search always on,
        // tour32_append_case answers to the same voice-gate as mail_send.
        jarvis_tour32: tour32Server(),
        // A real coding agent per task — answers to ALLOW_WRITES itself,
        // see decideTool above.
        jarvis_code: codeAgentServer(),
        // Phil's David calendar, over CalDAV — read-only, no write tool exists.
        jarvis_calendar: calendarServer(),
        // In-memory spoken reminders, over the same notify channel as mail
        // and status alerts.
        jarvis_reminder: reminderServer((text) => notifyAll(text, 'JARVIS · Erinnerung')),
        // Media-key playback control — play/pause/next/previous only.
        jarvis_music: musicServer(),
      },
      // A plain system prompt, not the claude_code preset. The preset is
      // tuned for a coding agent — verbose, file-oriented, and a large chunk
      // of input tokens on every turn. Replacing it makes the persona stick,
      // keeps answers short enough to speak, and cuts cost per turn.
      systemPrompt: SYSTEM_PROMPT,
      // Run from the home directory so project-scoped MCP servers don't shadow
      // the global ones, and so file tools have a sane root.
      cwd: homedir(),
      // No filesystem settings at all. Left to its default the SDK loads
      // ~/.claude/settings.json and settings.local.json exactly as the CLI
      // does — which on a working machine means a bypassPermissions default
      // and a pile of allow-rules for Bash. Allow-rules are matched before the
      // permission callback, so decideTool below would never even be asked
      // about the tools it most needs to refuse. Empty makes this bridge the
      // only authority. It also stops the global CLAUDE.md riding along on
      // every voice turn, carrying instructions written for a coding agent
      // into a conversation that is meant to be two sentences long.
      //
      // The cost is that MCP servers stop being discovered too, which is why
      // mcpServers above passes them in by hand.
      settingSources: [],
      // Stated explicitly, and it has to be.
      //
      // With no `model` here the SDK falls back to its own default, which on
      // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
      // declares for the browser-direct path, and not anything anyone chose.
      // Normally your own `/model` preference would decide, but that lives in
      // the settings files `settingSources: []` deliberately stops loading, so
      // without this line nothing in the project has a say at all.
      model: MODEL,
      effort: EFFORT,
      maxTurns: 24,
      permissionMode: 'default',
      // Without this the SDK only emits whole assistant messages, and JARVIS
      // would sit silent until the entire answer was written. Partial events
      // are what let speech start on the first finished sentence.
      includePartialMessages: true,
      // Signature is (toolName, input, options) and it must return a
      // PermissionResult object. Returning a bare boolean silently denies
      // everything, with the tool name arriving undefined.
      //
      // Worth knowing: this is a last gate, not the only one. Calls the CLI
      // has already settled never arrive here — its own classifier waves
      // through a `Bash: echo hello` without asking, and only reaches us for
      // something with a consequence, like a `touch`. So a deny here is
      // reliable; an absence of a call here is not proof nothing ran.
      canUseTool: async (toolName) => {
        if (GENERATION_TOOL.test(mcpToolOf(toolName))) {
          generationCount += 1
          if (generationCount > GENERATION_LIMIT) {
            console.log(`[jarvis] tool ${toolName} -> deny (generation cap)`)
            return {
              behavior: 'deny',
              message:
                `Blocked: this session has already generated ${GENERATION_LIMIT} ` +
                'images, videos or audio clips. Tell the user the budget for this ' +
                'conversation is used up and they can start a new one to continue.',
            }
          }
        }
        const ok = decideTool(toolName)
        console.log(`[jarvis] tool ${toolName} -> ${ok ? 'allow' : 'deny'}`)
        return ok
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              // Every word of this can end up spoken, so it carries no command
              // to read out — the persona is forbidden from saying one aloud.
              message:
                'Blocked: JARVIS is running in read-only mode and cannot take' +
                ' actions that change anything. Tell the user this action is' +
                ' unavailable until they enable write access on the machine.',
            }
      },
    },
  })

  // Pump the session's output stream to the browser for as long as it lives.
  ;(async () => {
    try {
      for await (const msg of session) {
        if (process.env.JARVIS_DEBUG === '1') {
          console.log('[msg]', msg.type, msg.event?.type ?? '')
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // JARVIS goes completely mute.
          case 'stream_event': {
            const ev = msg.event
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text
            ) {
              sendTurn({ type: 'text', delta: ev.delta.text })
            }
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case 'result':
            // A result is not automatically a success. The error subtypes
            // carry no `result` field at all, so reporting them as 'done' with
            // empty text is indistinguishable from a turn that simply had
            // nothing to say — the HUD stops spinning and JARVIS stands there
            // silent. Say what happened instead.
            if (msg.subtype === 'success') {
              sendTurn({
                type: 'done',
                text: msg.result ?? '',
                costUsd: msg.total_cost_usd ?? null,
              })
            } else {
              console.error(
                `[jarvis] turn failed: ${msg.subtype}`,
                msg.errors ?? '',
              )
              sendTurn({
                type: 'error',
                message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
              })
            }
            // Whatever was waiting on this turn to finish can go now. This is
            // the only place a turn is genuinely over.
            finishTurn?.()
            finishTurn = null
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            seenTools.clear()
            heldTools.clear()
            break

          case 'system':
            if (msg.subtype === 'init') {
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const usable = (msg.mcp_servers ?? [])
                .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                .map((s) => s.name)
              send({ type: 'ready', servers: usable })
              console.log(`[jarvis] ${usable.length} MCP servers available`)
            }
            break
        }
      }
    } catch (err) {
      console.error('[jarvis] session error:', err)
      send({ type: 'error', message: String(err?.message ?? err) })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      closed = true
      deliver?.(null)
      session.close?.()
      socket.close()
    }
  })()

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       */
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      void settling.then(() => {
        answering = id
        if (deliver) {
          const resolve = deliver
          deliver = null
          resolve(text)
        } else {
          inbox.push(text)
        }
      })
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    if (msg.type === 'interrupt') {
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(session.interrupt?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    console.log('[jarvis] client disconnected')
    liveSockets.delete(socket)
    closed = true
    deliver?.(null)
    session.close?.()
  })
})
