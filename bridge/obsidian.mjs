import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, relative, dirname, sep } from 'node:path'

/**
 * JARVIS's memory: Phil's own Obsidian second brain.
 *
 * Everything else in this bridge is stateless between connections — the
 * agent boots fresh each session with nothing but the system prompt. This is
 * the one place that persists, because it is not really JARVIS's storage at
 * all: it is Phil's existing PARA vault, the same one his other tools and
 * CLAUDE.md instructions already write to. Reading it means JARVIS starts a
 * conversation already knowing the running projects and decisions; writing
 * to it means a fact he mentions out loud is still there next session,
 * without a second, JARVIS-only memory system to keep in sync with the real
 * one.
 *
 * Deliberately thin. This is direct file access to Markdown, not a KB layer
 * — search is grep, not embeddings, because a vault this size does not need
 * more and every added moving part is one more way for a voice answer to be
 * built on stale context.
 */

const VAULT = 'C:\\Users\\phil.hildebrandt\\KS-Obsidian'

/** Keep every path inside the vault. A model-supplied path is untrusted the
 *  same way a URL is — `..` in it must not walk out to the rest of the disk. */
function resolveInVault(relPath) {
  const clean = String(relPath ?? '').replace(/^[/\\]+/, '')
  const full = join(VAULT, clean)
  const rel = relative(VAULT, full)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('path escapes the vault')
  }
  return full
}

async function walk(dir, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await walk(full, out)
    else if (e.name.endsWith('.md')) out.push(full)
  }
}

const LIST_DESCRIPTION = `List notes in Phil's Obsidian vault (PARA: 01 Projekte,
02 Bereiche, 03 Ressourcen, 04 Archiv, 00 Inbox).

Use it to see what exists in a folder before reading — folder names carry
meaning here (Projekte = has a goal and deadline, Bereiche = ongoing area,
Archiv = done). Omit the folder to list the vault root.`

const SEARCH_DESCRIPTION = `Search every note in the vault for a phrase, case-
insensitive. Returns matching notes with the line the phrase was found on.

This is how you find out whether Phil already has a note on something before
answering from memory or creating a duplicate one — check first.`

const READ_DESCRIPTION = `Read one note's full Markdown content.

Path is relative to the vault root, e.g. "01 Projekte/Projekt JARVIS.md" —
get it from obsidian_list or obsidian_search first rather than guessing it.`

const WRITE_DESCRIPTION = `Create a note, or overwrite one that already exists.

Path is relative to the vault root. Creates parent folders if needed. Put a
new note in the PARA folder that matches what it is: 01 Projekte for
something with a goal and a deadline, 02 Bereiche for an ongoing area, 03
Ressourcen for reference material, 00 Inbox/Inbox.md only as a landing spot
when nothing else fits. This overwrites the whole note — use obsidian_append
to add to one without discarding what's there.`

const APPEND_DESCRIPTION = `Add text to the end of an existing note without
touching what's already in it. Creates the note if it does not exist yet.

Use this for a session handoff, a new fact, or a task added to a running
project — anything that should join the note rather than replace it.`

export function obsidianServer() {
  return createSdkMcpServer({
    name: 'jarvis_obsidian',
    version: '1.0.0',
    instructions:
      "Phil's own Obsidian second brain, at " +
      VAULT +
      '. Reach for it whenever a question is really "what do I already know ' +
      'about this" or "where did we leave this" — search or read before ' +
      'answering from memory. Write to it, unasked, when Phil shares something ' +
      'worth keeping: a real decision, a task with a goal, a fact to remember. ' +
      'Say in one short sentence what you saved and where — do not stay silent ' +
      'about it, and do not narrate the mechanics of doing it.',
    alwaysLoad: true,
    tools: [
      tool(
        'obsidian_list',
        LIST_DESCRIPTION,
        {
          folder: z
            .string()
            .optional()
            .catch(undefined)
            .describe('Folder relative to the vault root, e.g. "01 Projekte". Omit for the root.'),
        },
        async (args) => {
          const dir = resolveInVault(args.folder ?? '')
          let entries
          try {
            entries = await readdir(dir, { withFileTypes: true })
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Could not list that folder: ${err?.message ?? err}` }],
            }
          }
          const lines = entries
            .filter((e) => !e.name.startsWith('.'))
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
          return {
            content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(empty)' }],
          }
        },
      ),

      tool(
        'obsidian_search',
        SEARCH_DESCRIPTION,
        {
          query: z.string().describe('Text to search for, case-insensitive.'),
        },
        async (args) => {
          // Fuzzy in the one sense that actually helps a spoken query: word
          // order and exact phrasing don't matter, so "JARVIS Push-to-talk"
          // finds a line that says "Push-to-talk bei JARVIS" too. Each query
          // word still has to appear whole — this is not typo-tolerant, just
          // not phrase-exact.
          const words = String(args.query ?? '')
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean)
          if (!words.length) {
            return { isError: true, content: [{ type: 'text', text: 'Empty query.' }] }
          }
          const files = []
          await walk(VAULT, files)
          const hits = []
          for (const full of files) {
            let text
            try {
              text = await readFile(full, 'utf8')
            } catch {
              continue
            }
            const lines = text.split('\n')
            const lineIdx = lines.findIndex((l) => {
              const lower = l.toLowerCase()
              return words.every((w) => lower.includes(w))
            })
            if (lineIdx === -1) continue
            const rel = relative(VAULT, full).replace(/\\/g, '/')
            const line = lines[lineIdx].trim().slice(0, 160)
            hits.push(`${rel}: ${line}`)
            if (hits.length >= 25) break
          }
          return {
            content: [{ type: 'text', text: hits.length ? hits.join('\n') : 'No notes matched.' }],
          }
        },
      ),

      tool(
        'obsidian_read',
        READ_DESCRIPTION,
        {
          path: z.string().describe('Note path relative to the vault root, including .md.'),
        },
        async (args) => {
          let full
          try {
            full = resolveInVault(args.path)
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: err.message }] }
          }
          try {
            const text = await readFile(full, 'utf8')
            return { content: [{ type: 'text', text }] }
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Could not read that note: ${err?.message ?? err}` }],
            }
          }
        },
      ),

      tool(
        'obsidian_write',
        WRITE_DESCRIPTION,
        {
          path: z.string().describe('Note path relative to the vault root, including .md.'),
          content: z.string().describe('Full Markdown content. Replaces the whole note if it exists.'),
        },
        async (args) => {
          let full
          try {
            full = resolveInVault(args.path)
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: err.message }] }
          }
          try {
            await mkdir(dirname(full), { recursive: true })
            await writeFile(full, String(args.content ?? ''), 'utf8')
            return { content: [{ type: 'text', text: `Saved ${args.path}.` }] }
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Could not save that note: ${err?.message ?? err}` }],
            }
          }
        },
      ),

      tool(
        'obsidian_append',
        APPEND_DESCRIPTION,
        {
          path: z.string().describe('Note path relative to the vault root, including .md.'),
          content: z.string().describe('Markdown to add. A leading newline is added automatically.'),
        },
        async (args) => {
          let full
          try {
            full = resolveInVault(args.path)
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: err.message }] }
          }
          try {
            await mkdir(dirname(full), { recursive: true })
            let existing = ''
            try {
              existing = await readFile(full, 'utf8')
            } catch {
              /* new note */
            }
            const sep2 = existing && !existing.endsWith('\n') ? '\n' : ''
            await writeFile(full, existing + sep2 + String(args.content ?? '') + '\n', 'utf8')
            return { content: [{ type: 'text', text: `Added to ${args.path}.` }] }
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Could not update that note: ${err?.message ?? err}` }],
            }
          }
        },
      ),
    ],
  })
}
