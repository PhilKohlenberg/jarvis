/**
 * Push notifications to Phil's phone, alongside the spoken alert — for
 * anything that fires with no browser tab open to hear it (see mailwatch.mjs)
 * or that's worth a nudge even when he's away from the desk.
 *
 * ntfy.sh: no account, no API key — a topic name is the whole "credential",
 * and anyone who knows it can read or post to it unless self-hosted. Treated
 * the same as a real secret anyway (user env var, never in project files),
 * since a topic name leaking is a nuisance-message risk, not a nothing.
 */

const SERVER = (process.env.JARVIS_NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/+$/, '')
const TOPIC = process.env.JARVIS_NTFY_TOPIC ?? ''

export const pushConfigured = () => Boolean(TOPIC)

/**
 * Fire-and-forget by design: a push failing must never take down the mail
 * watch or delay the spoken alert that's already the primary channel. Errors
 * are logged, not thrown.
 */
export async function pushNotify(text, { title } = {}) {
  if (!pushConfigured()) return
  try {
    const res = await fetch(`${SERVER}/${encodeURIComponent(TOPIC)}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        ...(title ? { title: String(title).replace(/[\r\n]/g, ' ') } : {}),
      },
      body: String(text ?? ''),
    })
    if (!res.ok) {
      console.error(`[jarvis] push failed: ntfy said ${res.status}`)
    }
  } catch (err) {
    console.error('[jarvis] push failed:', err?.message ?? err)
  }
}
