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

      client.on('exists', (data) => {
        if (data.count <= known) {
          known = data.count
          return
        }
        const newCount = data.count
        known = newCount
        client
          .fetchOne(String(newCount), { envelope: true })
          .then((msg) => {
            if (!msg) return
            const from = msg.envelope?.from?.[0]
            onNewMail({
              from: from ? (from.name ? `${from.name} <${from.address}>` : from.address) : 'unbekannt',
              subject: msg.envelope?.subject ?? '(kein Betreff)',
            })
          })
          .catch((err) => console.error('[jarvis] mail watch fetch failed:', err?.message ?? err))
      })

      while (!stopped) {
        await client.idle()
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
