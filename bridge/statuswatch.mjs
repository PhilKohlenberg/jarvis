/**
 * A plain uptime watch, same shape as mailwatch.mjs's IDLE loop but far
 * simpler: no protocol to speak, just "did something answer". Runs for the
 * life of the bridge process, independent of any voice conversation.
 *
 * Any HTTP response at all — even 401 or 404 — counts as "up". This is a
 * reachability check, not a health check: the point is "is the box on the
 * network and answering", which a login wall or a missing page both already
 * prove. Only a network-level failure (refused, timed out, unreachable)
 * counts as down.
 *
 * Two consecutive failures before reporting "down", one success to report
 * "back up" — the asymmetry is deliberate. A single dropped packet is
 * normal on a LAN; two in a row, on a poll spaced minutes apart, is not. A
 * false "it's down" is the annoying direction to get wrong, so downgrade is
 * the side held to a higher bar; recovery isn't.
 */
export function watchStatus({ url, intervalMs = 5 * 60 * 1000, onChange }) {
  let stopped = false
  let up = true // assume up at boot — a wave of false "recovered" pushes on start is worse than the reverse
  let consecutiveFailures = 0
  const timer = { id: null }

  async function checkOnce() {
    const controller = new AbortController()
    const abort = setTimeout(() => controller.abort(), 10_000)
    try {
      await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'manual' })
      clearTimeout(abort)
      consecutiveFailures = 0
      if (!up) {
        up = true
        onChange({ up: true })
      }
    } catch (err) {
      clearTimeout(abort)
      consecutiveFailures += 1
      if (up && consecutiveFailures >= 2) {
        up = false
        onChange({ up: false, error: err?.message ?? String(err) })
      }
    }
  }

  async function loop() {
    while (!stopped) {
      await checkOnce()
      if (stopped) return
      await new Promise((r) => { timer.id = setTimeout(r, intervalMs) })
    }
  }

  void loop()
  return { stop: () => { stopped = true; if (timer.id) clearTimeout(timer.id) } }
}
