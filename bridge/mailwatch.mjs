import { ImapFlow } from 'imapflow'

/**
 * A live IMAP IDLE watch on the inbox, independent of any voice
 * conversation — this runs once for the life of the bridge process, not
 * per WebSocket connection, so it keeps watching even with no browser tab
 * open and broadcasts to whichever tabs are connected when mail arrives.
 *
 * One dedicated connection, separate from the request/response ones
 * mail.mjs opens per tool call — IDLE holds a connection open for as long
 * as nothing happens, which is the opposite of that module's
 * connect-do-one-thing-disconnect shape.
 */
export function watchInbox({ host, user, pass, tlsOpts, onNewMail, folder = 'INBOX' }) {
  let stopped = false
  const RETRY_MS = 15_000

  async function runOnce() {
    const client = new ImapFlow({
      host,
      port: 143,
      secure: false,
      auth: { user, pass },
      tls: tlsOpts,
      logger: false,
    })
    try {
      await client.connect()
      await client.mailboxOpen(folder)
      let known = client.mailbox.exists

      /**
       * Fetching from an 'exists' event handler raced client.idle() itself:
       * the event fires the instant idle() resolves, so the next loop
       * iteration was already calling idle() again — re-entering IDLE —
       * while the handler's fetchOne()/download() was still in flight on
       * the same connection. ImapFlow serializes commands on one
       * connection; two callers issuing them at once corrupted the
       * sequence and every fetch failed with a generic "Command failed".
       * Fetching inline, after idle() resolves and before the loop calls
       * it again, keeps everything on this connection strictly ordered.
       */
      while (!stopped) {
        await client.idle()
        const current = client.mailbox.exists
        if (current <= known) {
          known = current
          continue
        }
        const newCount = current
        known = current
        try {
          const msg = await client.fetchOne(String(newCount), { envelope: true })
          if (!msg) continue
          const from = msg.envelope?.from?.[0]
          let bodyPreview = ''
          try {
            const { content } = await client.download(String(newCount), 'TEXT')
            const chunks = []
            for await (const chunk of content) chunks.push(chunk)
            bodyPreview = Buffer.concat(chunks).toString('utf8').slice(0, 2000)
          } catch {
            /* body preview is best-effort — the alert still fires without it */
          }
          onNewMail({
            from: from ? (from.name ? `${from.name} <${from.address}>` : from.address) : 'unbekannt',
            subject: msg.envelope?.subject ?? '(kein Betreff)',
            body: bodyPreview,
          })
        } catch (err) {
          console.error('[jarvis] mail watch fetch failed:', err?.message ?? err)
        }
      }
    } finally {
      await client.logout().catch(() => {})
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        await runOnce()
      } catch (err) {
        if (!stopped) console.error('[jarvis] mail watch connection lost, retrying:', err?.message ?? err)
      }
      if (!stopped) await new Promise((r) => setTimeout(r, RETRY_MS))
    }
  }

  void loop()
  return { stop: () => { stopped = true } }
}
