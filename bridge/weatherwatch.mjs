/**
 * A proactive rain warning, same shape as statuswatch.mjs: runs for the
 * life of the bridge process, checks periodically, notifies on the same
 * broadcast+push channel as everything else here. Open-Meteo, because it
 * needs no API key and no account — geocodes the place name once (cached
 * for the life of the process) and then just asks for today's
 * precipitation-probability max.
 *
 * Warns at most once per calendar day, tracked by the date Open-Meteo
 * itself returns (its own timezone-aware "today", not this process's).
 */
export function watchWeather({ location, thresholdPercent = 60, intervalMs = 2 * 60 * 60 * 1000, onWarn }) {
  let stopped = false
  let coords = null
  let warnedForDate = null

  async function resolveCoords() {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=de`,
    )
    const data = await res.json()
    const hit = data?.results?.[0]
    if (!hit) throw new Error(`Ort "${location}" nicht gefunden`)
    return { lat: hit.latitude, lon: hit.longitude }
  }

  async function checkOnce() {
    try {
      if (!coords) coords = await resolveCoords()
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
        '&daily=precipitation_probability_max&timezone=Europe%2FBerlin&forecast_days=1'
      const res = await fetch(url)
      const data = await res.json()
      const date = data?.daily?.time?.[0]
      const probability = data?.daily?.precipitation_probability_max?.[0]
      if (date && typeof probability === 'number' && probability >= thresholdPercent && warnedForDate !== date) {
        warnedForDate = date
        onWarn({ date, probability })
      }
    } catch (err) {
      console.error('[jarvis] weather check failed:', err?.message ?? err)
    }
  }

  async function loop() {
    while (!stopped) {
      await checkOnce()
      if (stopped) return
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }

  void loop()
  return { stop: () => { stopped = true } }
}
