import fs from 'node:fs'

const rows = fs.readFileSync('db/candles/BANDHANBNK.jsonl', 'utf8').trim().split(/\r?\n/).map(JSON.parse).sort((a, b) => a.time - b.time)
// Relaxed bounds chosen to include the four observed comparison sessions.
const FILTER = { maxMovePct: 0.2, minRangePct: 1.7, maxRsi14: 40, maxPriceVsEma200Pct: -1, minOpeningGapPct: -1 }
const ist = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = seconds => ist(seconds).slice(0, 10)
const timeOf = seconds => ist(seconds).slice(11)
const round = value => Number.isFinite(value) ? Number(value.toFixed(4)) : null
const pct = (value, base) => 100 * (value / base - 1)
let ema10, ema20, ema50, ema200, previous, gains = [], losses = [], averageGain, averageLoss
const byDate = new Map()
for (const row of rows) {
  const close = Number(row.close), date = dateOf(row.time), time = timeOf(row.time)
  ema10 = ema10 == null ? close : ema10 + 2 / 11 * (close - ema10)
  ema20 = ema20 == null ? close : ema20 + 2 / 21 * (close - ema20)
  ema50 = ema50 == null ? close : ema50 + 2 / 51 * (close - ema50)
  ema200 = ema200 == null ? close : ema200 + 2 / 201 * (close - ema200)
  let rsi14 = null
  if (previous != null) {
    const change = close - previous
    gains.push(Math.max(change, 0)); losses.push(Math.max(-change, 0))
    if (gains.length === 14) { averageGain = gains.reduce((sum, value) => sum + value, 0) / 14; averageLoss = losses.reduce((sum, value) => sum + value, 0) / 14 }
    else if (gains.length > 14) { averageGain = (13 * averageGain + gains.at(-1)) / 14; averageLoss = (13 * averageLoss + losses.at(-1)) / 14 }
    if (averageGain != null) rsi14 = averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss)
  }
  previous = close
  if (time >= '09:15' && time < '15:30') {
    if (!byDate.has(date)) byDate.set(date, { full: [], opening: [] })
    const item = { ...row, ema10, ema20, ema50, ema200, rsi14 }
    byDate.get(date).full.push(item)
    if (time <= '09:29') byDate.get(date).opening.push(item)
  }
}
const dates = [...byDate.keys()].sort()
const sessions = dates.map(date => ({ date, volume: byDate.get(date).full.reduce((sum, row) => sum + Number(row.volume || 0), 0), bars: byDate.get(date).full.length }))
const reports = []
for (const date of dates) {
  const opening = byDate.get(date).opening
  if (opening.length !== 15) continue
  const first = opening[0], last = opening.at(-1), high = Math.max(...opening.map(row => row.high)), low = Math.min(...opening.map(row => row.low))
  const currentVolume = opening.reduce((sum, row) => sum + Number(row.volume || 0), 0)
  const previousSession = rows.filter(row => dateOf(row.time) < date && timeOf(row.time) >= '09:15' && timeOf(row.time) <= '15:29').at(-1)
  const sessionIndex = sessions.findIndex(session => session.date === date), prior = sessions.slice(0, sessionIndex).filter(session => session.bars >= 300).slice(-2)
  const avgPriorVolume = prior.length === 2 ? prior.reduce((sum, session) => sum + session.volume, 0) / 2 : null
  reports.push({ date, openingGapPct: previousSession ? round(pct(first.open, previousSession.close)) : null,
    movePct: round(pct(last.close, first.open)), rangePct: round(pct(high, low)), openingVolume: currentVolume,
    openingVolumeVsPrior2DayPct: avgPriorVolume ? round(pct(currentVolume, avgPriorVolume)) : null,
    up: opening.filter(row => row.close > row.open).length, down: opening.filter(row => row.close < row.open).length,
    rsi14: round(last.rsi14), ema10Vs20Pct: round(pct(last.ema10, last.ema20)),
    priceVsEma200Pct: round(pct(last.close, last.ema200)) })
}
const target = reports.find(row => row.date === '2026-10-23')
const recent = reports.slice(-30)
const gapDownCandidates = recent.filter(row => row.openingGapPct >= FILTER.minOpeningGapPct)
const score = row => {
  return [row.movePct <= FILTER.maxMovePct, row.rangePct >= FILTER.minRangePct, row.rsi14 <= FILTER.maxRsi14,
    row.priceVsEma200Pct <= FILTER.maxPriceVsEma200Pct, row.openingVolumeVsPrior2DayPct < 0,
    row.openingGapPct >= FILTER.minOpeningGapPct].filter(Boolean).length
}
const similar = gapDownCandidates.map(row => ({ ...row, similarity: score(row) })).sort((a, b) => b.similarity - a.similarity || a.date.localeCompare(b.date))
const exactMatches = recent.filter(row => row.movePct <= FILTER.maxMovePct && row.rangePct >= FILTER.minRangePct && row.rsi14 <= FILTER.maxRsi14 && row.priceVsEma200Pct <= FILTER.maxPriceVsEma200Pct && row.openingVolumeVsPrior2DayPct < 0 && row.openingGapPct >= FILTER.minOpeningGapPct)
console.log(JSON.stringify({ target, sessionsAnalyzed: recent.length, filters: { openingMoveAtMostPct: FILTER.maxMovePct, rangeAtLeastPct: FILTER.minRangePct, rsi14AtMost: FILTER.maxRsi14, priceVsEma200AtMostPct: FILTER.maxPriceVsEma200Pct, openingVolumeBelowPriorTwoSessionFullDayAverage: true, openingGapAtLeastPct: FILTER.minOpeningGapPct }, exactMatches, eligibleSessions: gapDownCandidates.length, similar: similar.slice(0, 10) }, null, 2))
