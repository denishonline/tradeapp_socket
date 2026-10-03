const DEPTH_FIELD = /^(?:bid|ask)_(?:price|size|order)[1-5]$/

export function marketDepthSession(date = new Date()) {
  const india = new Date(date.getTime() + 330 * 60_000)
  const weekday = india.getUTCDay()
  const seconds = india.getUTCHours() * 3600 + india.getUTCMinutes() * 60 + india.getUTCSeconds()
  return {
    date: `${india.getUTCFullYear()}-${String(india.getUTCMonth() + 1).padStart(2, "0")}-${String(india.getUTCDate()).padStart(2, "0")}`,
    open: weekday >= 1 && weekday <= 5 && seconds >= 9 * 3600 + 15 * 60 && seconds < 15 * 3600 + 15 * 60,
  }
}

export function depthUpdateFields(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) ||
      message.type !== "dp" || typeof message.symbol !== "string") return null
  const fields = new Map()
  for (const [key, raw] of Object.entries(message)) {
    if (!DEPTH_FIELD.test(key)) continue
    if ((typeof raw !== "number" && typeof raw !== "string") ||
        raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return null
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return null
    if (!key.includes("price") && !Number.isInteger(value)) return null
    fields.set(key, value)
  }
  return fields.size ? fields : null
}
