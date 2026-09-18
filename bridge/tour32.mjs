import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFile, writeFile, appendFile, readdir, stat } from 'node:fs/promises'
import { join, relative, extname, sep } from 'node:path'

/**
 * Phil's existing TOUR32 support knowledge base — a folder of case mail
 * (.eml) organized per customer, plus a hand-maintained Markdown file
 * (Wissensbasis_TOUR32.md) that already holds the running case log in a
 * fixed schema. This didn't start as a JARVIS thing; JARVIS is a new reader
 * and writer of something Phil already maintains, same relationship this
 * bridge has to the Obsidian vault.
 *
 * Search walks the whole folder rather than indexing it, same tradeoff as
 * obsidian.mjs's grep-not-embeddings call — but 12,000+ .eml files is a much
 * bigger tree than the vault, so this caps how much it will ever walk in one
 * search rather than assuming a vault-sized folder.
 */

const ROOT = 'D:\\Meine Ablage\\TOUR32SupportWissen'
const WISSENSBASIS = join(ROOT, 'Wissensbasis_TOUR32.md')
const SEARCHABLE_EXT = new Set(['.eml', '.md', '.txt', '.html', '.htm'])
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_FILES_WALKED = 8000
const MAX_HITS = 25

/** Keeps every path inside the folder — a model-supplied path is untrusted
 *  the same way a URL is, same reasoning as obsidian.mjs's resolveInVault. */
function resolveInRoot(relPath) {
  const clean = String(relPath ?? '').replace(/^[/\\]+/, '')
  const full = join(ROOT, clean)
  const rel = relative(ROOT, full)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('path escapes the TOUR32 folder')
  }
  return full
}

async function walk(dir, out, budget) {
  if (out.length >= budget.filesWalked) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= budget.filesWalked) return
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      await walk(full, out, budget)
    } else if (SEARCHABLE_EXT.has(extname(e.name).toLowerCase())) {
      out.push(full)
    }
  }
}

/** Strips the raw MIME structure out of a .eml so search and read return
 *  something readable rather than base64 blobs and boundary markers. Not a
 *  full parser — just enough to find the headers and the first text part. */
function extractEmlText(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n') !== -1 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n')
  const headerBlock = raw.slice(0, headerEnd === -1 ? raw.length : headerEnd)
  const headers = {}
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = /^(From|To|Subject|Date):\s*(.*)$/i.exec(line)
    if (m) headers[m[1].toLowerCase()] = m[2]
  }
  let rest = headerEnd === -1 ? '' : raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '')
  // Multipart: grab the first text/plain (or text/html, stripped) section.
  const boundaryMatch = /boundary="?([^"\r\n;]+)"?/i.exec(headerBlock)
  if (boundaryMatch) {
    const parts = rest.split(`--${boundaryMatch[1]}`)
    const textPart = parts.find((p) => /content-type:\s*text\/plain/i.test(p)) ?? parts.find((p) => /content-type:\s*text\/html/i.test(p))
    if (textPart) {
      const partHeaderEnd = textPart.indexOf('\r\n\r\n') !== -1 ? textPart.indexOf('\r\n\r\n') : textPart.indexOf('\n\n')
      rest = partHeaderEnd === -1 ? textPart : textPart.slice(partHeaderEnd).replace(/^\r?\n\r?\n/, '')
      if (/content-transfer-encoding:\s*base64/i.test(textPart)) {
        try {
          rest = Buffer.from(rest.replace(/\s+/g, ''), 'base64').toString('utf8')
        } catch {
          /* leave as-is if it doesn't decode */
        }
      } else if (/content-transfer-encoding:\s*quoted-printable/i.test(textPart)) {
        rest = rest.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      }
    }
  }
  return { headers, body: rest.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim() }
}

async function readSearchableFile(full) {
  const ext = extname(full).toLowerCase()
  const raw = await readFile(full, 'utf8').catch(() => readFile(full, 'latin1'))
  if (ext === '.eml') {
    const { headers, body } = extractEmlText(raw)
    return `Von: ${headers.from ?? ''}\nAn: ${headers.to ?? ''}\nBetreff: ${headers.subject ?? ''}\nDatum: ${headers.date ?? ''}\n\n${body}`
  }
  if (ext === '.html' || ext === '.htm') {
    return raw.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim()
  }
  return raw
}

const LIST_DESCRIPTION = `List files and customer folders under Phil's TOUR32
support knowledge base. Omit the folder to see the top level — one folder per
customer, plus Wissensbasis_TOUR32.md (the central case log) and
Wissensbasis_TOUR32_Web-Hilfe.html at the root.`

const SEARCH_DESCRIPTION = `Search the whole TOUR32 knowledge base — the central
Wissensbasis_TOUR32.md case log, the web-help file, and every customer's saved
support emails (.eml) — for a phrase, case-insensitive. Returns matching files
with the line the phrase was found on. This is THE tool for "search the folder
for a solution to this email" — always check here before answering a support
question from memory or guessing at a fix.`

const READ_DESCRIPTION = `Read one file from the TOUR32 knowledge base in full —
the case log, the web-help file, or one customer's saved email. For a .eml this
returns the decoded sender, subject, date and body, not the raw MIME. Path is
relative to the TOUR32SupportWissen folder, e.g. "Geoplan/AER Schnittstelle.eml"
— get it from tour32_list or tour32_search rather than guessing it.`

const APPEND_CASE_DESCRIPTION = `Add a new support case, or a solution to an
existing one, to Wissensbasis_TOUR32.md — the central case log. Real,
irreversible — it lands in Phil's actual working knowledge base. Only call this
after Phil has said out loud, in this conversation, to record it.

Follow the file's own schema exactly (read it first if you haven't this
session): a single bullet line under "## Aktive / offene Fälle" —
"- **[kurzer Titel]:** Datum: ... | Bearbeiter: ... | Kunde/Fall: ... |
Kategorie/Tag: ... | Fehlerbild/Frage: ... | Lösung: ... | Quelle: ..." — all on
one line, pipe-separated, matching the tone and level of detail of the
existing entries. Pass the complete bullet line as \`entryMarkdown\`; it is
appended as a new line under that heading, above the older entries.`

export function tour32Server() {
  return createSdkMcpServer({
    name: 'jarvis_tour32',
    version: '1.0.0',
    instructions:
      "Phil's TOUR32 support knowledge base, at " +
      ROOT +
      '. tour32_search whenever a new support email needs a known fix — search ' +
      'before answering from memory. tour32_append_case only when Phil has asked ' +
      'for a case or solution to be recorded, and only in the schema the file ' +
      'already uses.',
    alwaysLoad: true,
    tools: [
      tool(
        'tour32_list',
        LIST_DESCRIPTION,
        {
          folder: z.string().optional().catch(undefined).describe('Folder relative to the TOUR32SupportWissen root. Omit for the root.'),
        },
        async (args) => {
          let dir
          try {
            dir = resolveInRoot(args.folder ?? '')
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: err.message }] }
          }
          let entries
          try {
            entries = await readdir(dir, { withFileTypes: true })
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Could not list that folder: ${err?.message ?? err}` }] }
          }
          const lines = entries
            .filter((e) => !e.name.startsWith('.'))
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
          return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '(empty)' }] }
        },
      ),

      tool(
        'tour32_search',
        SEARCH_DESCRIPTION,
        {
          query: z.string().describe('Text to search for, case-insensitive.'),
        },
        async (args) => {
          const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
          if (!words.length) return { isError: true, content: [{ type: 'text', text: 'Empty query.' }] }
          const files = []
          await walk(ROOT, files, { filesWalked: MAX_FILES_WALKED })
          const hits = []
          let scanned = 0
          for (const full of files) {
            scanned += 1
            let text
            try {
              const stat = await import('node:fs/promises').then((m) => m.stat(full))
              if (stat.size > MAX_FILE_BYTES) continue
              text = await readSearchableFile(full)
            } catch {
              continue
            }
            const lower = text.toLowerCase()
            if (!words.every((w) => lower.includes(w))) continue
            const lineIdx = text.split('\n').findIndex((l) => {
              const ll = l.toLowerCase()
              return words.some((w) => ll.includes(w))
            })
            const line = lineIdx === -1 ? text.slice(0, 160) : text.split('\n')[lineIdx].trim().slice(0, 160)
            const rel = relative(ROOT, full).replace(/\\/g, '/')
            hits.push(`${rel}: ${line}`)
            if (hits.length >= MAX_HITS) break
          }
          const note = files.length >= MAX_FILES_WALKED ? `\n(stopped after ${MAX_FILES_WALKED} files — narrow the query if the answer isn't here)` : ''
          return { content: [{ type: 'text', text: (hits.length ? hits.join('\n') : 'No files matched.') + note }] }
        },
      ),

      tool(
        'tour32_read',
        READ_DESCRIPTION,
        {
          path: z.string().describe('File path relative to the TOUR32SupportWissen root.'),
        },
        async (args) => {
          let full
          try {
            full = resolveInRoot(args.path)
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: err.message }] }
          }
          try {
            const text = await readSearchableFile(full)
            return { content: [{ type: 'text', text }] }
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Could not read that file: ${err?.message ?? err}` }] }
          }
        },
      ),

      tool(
        'tour32_append_case',
        APPEND_CASE_DESCRIPTION,
        {
          entryMarkdown: z.string().describe('The complete bullet line to add, matching the existing schema exactly.'),
        },
        async (args) => {
          const entry = String(args.entryMarkdown ?? '').trim()
          if (!entry.startsWith('- ')) {
            return { isError: true, content: [{ type: 'text', text: 'entryMarkdown must be a single "- **...**: ..." bullet line.' }] }
          }
          try {
            const current = await readFile(WISSENSBASIS, 'utf8')
            const marker = '## Aktive / offene Fälle\n'
            const idx = current.indexOf(marker)
            if (idx === -1) {
              await appendFile(WISSENSBASIS, `\n${entry}\n`, 'utf8')
            } else {
              const insertAt = idx + marker.length
              const updated = current.slice(0, insertAt) + entry + '\n' + current.slice(insertAt)
              await import('node:fs/promises').then((m) => m.writeFile(WISSENSBASIS, updated, 'utf8'))
            }
            return { content: [{ type: 'text', text: 'Case added to Wissensbasis_TOUR32.md.' }] }
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Could not update the case log: ${err?.message ?? err}` }] }
          }
        },
      ),
    ],
  })
}
