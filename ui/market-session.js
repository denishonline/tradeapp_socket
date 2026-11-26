const IST_OFFSET_MS = 330 * 60_000

export function isWithinLiveMarketSession(now = Date.now()) {
  const india = new Date(now + IST_OFFSET_MS)
  const weekday = india.getUTCDay()
  const minute = india.getUTCHours() * 60 + india.getUTCMinutes()
  return weekday >= 1 && weekday <= 5 && minute >= 9 * 60 + 15 && minute < 15 * 60 + 30
}

export function nextMarketOpen(now = Date.now()) {
  const india = new Date(now + IST_OFFSET_MS)
  for (let offset = 0; offset < 8; offset++) {
    const candidateDate = new Date(Date.UTC(
      india.getUTCFullYear(),
      india.getUTCMonth(),
      india.getUTCDate() + offset,
      9,
      15,
    ))
    const weekday = candidateDate.getUTCDay()
    if (weekday < 1 || weekday > 5) continue
    const candidate = candidateDate.getTime() - IST_OFFSET_MS
    if (candidate > now) return candidate
  }
  throw new Error("Unable to determine the next weekday market open.")
}

export function formatIstDateTime(epochMs) {
  const india = new Date(epochMs + IST_OFFSET_MS).toISOString()
  return `${india.slice(0, 10)} ${india.slice(11, 16)} IST`
}
