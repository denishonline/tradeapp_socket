import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const symbol = 'UNIONBANK'
const priorDates = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
const tradeDate = '2026-10-19'
const dates = [...priorDates, tradeDate]
const ist = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16)
const round = (value, places = 4) => Number(value.toFixed(places))
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

const unique = new Map()
for (const line of fs.readFileSync(path.join(root, 'db/candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let row
  try { row = JSON.parse(line) } catch { continue }
  const time = ist(Number(row.time))
  if (!dates.includes(time.slice(0, 10)) || time.slice(11) < '09:15' || time.slice(11) > '15:29') continue
  if (![row.open, row.high, row.low, row.close, row.volume].every(value => Number.isFinite(Number(value)))) continue
  unique.set(time, { time, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume })
}
const byDate = Object.fromEntries(dates.map(date => [date, [...unique.values()].filter(row => row.time.startsWith(date)).sort((a, b) => a.time.localeCompare(b.time))]))
for (const date of dates) if (byDate[date].length !== 375) throw new Error(`${date}: expected 375 one-minute candles; found ${byDate[date].length}`)

function fiveMinute(candles) {
  const bars = []
  for (let i = 0; i < candles.length; i += 5) {
    const rows = candles.slice(i, i + 5)
    if (rows.length !== 5 || minutes(rows.at(-1).time.slice(11)) - minutes(rows[0].time.slice(11)) !== 4) continue
    bars.push({ start: rows[0].time, end: rows.at(-1).time, open: rows[0].open, high: Math.max(...rows.map(row => row.high)), low: Math.min(...rows.map(row => row.low)), close: rows.at(-1).close, volume: rows.reduce((sum, row) => sum + row.volume, 0) })
  }
  return bars
}
function cumulativeAt(candles, hhmm) { return candles.filter(row => row.time.slice(11) <= hhmm).reduce((sum, row) => sum + row.volume, 0) }
function vwapAt(candles, hhmm) {
  const rows = candles.filter(row => row.time.slice(11) <= hhmm)
  return rows.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / rows.reduce((sum, row) => sum + row.volume, 0)
}
function depthWindow(date, start, end) {
  const file = path.join(root, 'db/cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const rows = [], state = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const at = new Date(Date.parse(event.receivedAt) + 330 * 60_000).toISOString().slice(0, 16)
    if (at.slice(0, 10) !== date || at.slice(11) > end) continue
    if (event.kind === 'checkpoint') Object.keys(state).forEach(key => delete state[key])
    Object.assign(state, event.data ?? {})
    if (at.slice(11) < start) continue
    const bid = Array.from({ length: 5 }, (_, i) => Number(state[`bid_size${i + 1}`]))
    const ask = Array.from({ length: 5 }, (_, i) => Number(state[`ask_size${i + 1}`]))
    const bestBid = Number(state.bid_price1), bestAsk = Number(state.ask_price1)
    if (![...bid, ...ask, bestBid, bestAsk].every(Number.isFinite) || bestBid <= 0 || bestAsk <= bestBid) continue
    const bidSize = bid.reduce((sum, size) => sum + size, 0), askSize = ask.reduce((sum, size) => sum + size, 0)
    const midpoint = (bestBid + bestAsk) / 2
    rows.push({ at, bidSharePct: 100 * bidSize / (bidSize + askSize), midpoint, spreadBps: 10000 * (bestAsk - bestBid) / midpoint, cumulativeVolume: Number(event.marketContext?.cumulativeVolume) })
  }
  if (!rows.length) return { snapshots: 0 }
  return { snapshots: rows.length, avgBidSharePct: round(mean(rows.map(row => row.bidSharePct)), 2), bidDominantSnapshotPct: round(100 * rows.filter(row => row.bidSharePct > 50).length / rows.length, 2), midpointMovePct: round(100 * (rows.at(-1).midpoint / rows[0].midpoint - 1)), avgSpreadBps: round(mean(rows.map(row => row.spreadBps)), 2), firstMidpoint: round(rows[0].midpoint, 2), lastMidpoint: round(rows.at(-1).midpoint, 2) }
}

const daily = dates.map(date => {
  const candles = byDate[date], bars = fiveMinute(candles)
  const high = Math.max(...candles.map(row => row.high)), low = Math.min(...candles.map(row => row.low))
  return { date, open: candles[0].open, high, low, close: candles.at(-1).close, range: round(high - low, 2), closeLocationPct: round(100 * (candles.at(-1).close - low) / (high - low), 2), totalVolume: candles.reduce((sum, row) => sum + row.volume, 0), first15Volume: cumulativeAt(candles, '09:29'), first30Volume: cumulativeAt(candles, '09:44'), median5mRange: round(median(bars.map(row => row.high - row.low)), 2) }
})
const prior = daily.slice(0, 4), today = byDate[tradeDate], today5m = fiveMinute(today)
const fourDayHigh = Math.max(...prior.map(row => row.high)), fourDayLow = Math.min(...prior.map(row => row.low))
const previousHigh = prior.at(-1).high, previousLow = prior.at(-1).low
const priorBreakoutBehaviour = prior.slice(1).map((row, index) => {
  const previous = prior[index]
  return { date: row.date, previousHigh: previous.high, previousLow: previous.low,
    crossedPreviousHigh: row.high > previous.high, closedAbovePreviousHigh: row.close > previous.high,
    crossedPreviousLow: row.low < previous.low, closedBelowPreviousLow: row.close < previous.low }
})
const volumeCheckTimes = ['09:24', '09:29', '09:44', '10:00']
const relativeVolume = volumeCheckTimes.map(time => {
  const current = cumulativeAt(today, time), baseline = mean(priorDates.map(date => cumulativeAt(byDate[date], time)))
  return { through: time, today: current, priorFourMean: round(baseline, 0), ratio: round(current / baseline, 2) }
})
const first5mAboveFourDayHigh = today5m.find(bar => bar.close > fourDayHigh)
const first5mAbovePreviousHigh = today5m.find(bar => bar.close > previousHigh)

// Exploratory candidate: a completed 5m candle breaks the prior-four-day high; a later
// 1m candle tests the high zone and closes inside/above it; the next completed 1m candle
// is bullish and reclaims the four-day high above a rising session VWAP. Enter at the
// next completed 1m close, only if the known intraday high leaves at least 1.5R gross room.
const breakout = first5mAboveFourDayHigh
const reTestTolerancePct = 0.2
let signalIndex = -1
let retest = null
if (breakout) {
  const firstAfterBreak = today.findIndex(row => row.time === breakout.end) + 1
  for (let i = firstAfterBreak + 1; i < today.length; i++) {
    const priorMinute = today[i - 1], row = today[i]
    const priorHighZoneLow = Math.min(prior[1].high, prior[2].high)
    if (priorMinute.low > fourDayHigh * (1 + reTestTolerancePct / 100) || priorMinute.close < priorHighZoneLow) continue
    const vwap = vwapAt(today, row.time.slice(11))
    if (row.close > row.open && row.close > priorMinute.close && row.close > fourDayHigh && row.close > vwap && vwap > vwapAt(today, breakout.end.slice(11))) {
      signalIndex = i
      retest = priorMinute
      break
    }
  }
}
let trade = null
if (signalIndex >= 0 && signalIndex + 1 < today.length) {
  const signal = today[signalIndex], entryIndex = signalIndex + 1, entry = today[entryIndex]
  // Illustrative invalidation below the two-session high zone and the retest low.
  const priorHighZoneLow = Math.min(prior[1].high, prior[2].high)
  const stop = round(Math.min(retest.low, priorHighZoneLow) - 0.05, 2), risk = round(entry.close - stop, 2)
  const target = Math.ceil((entry.close + 1.5 * risk) * 100 - 1e-9) / 100
  const knownIntradayHighAtSignal = Math.max(...today.slice(0, signalIndex + 1).map(row => row.high))
  const roomToKnownIntradayHighGrossR = round((knownIntradayHighAtSignal - entry.close) / risk, 2)
  if (roomToKnownIntradayHighGrossR < 1.5) throw new Error('First candidate lacks 1.5R gross room to the known intraday high')
  let exit = null
  for (const bar of today.slice(entryIndex + 1)) {
    if (bar.low <= stop && bar.high >= target) { exit = { time: bar.time, reason: 'ambiguous stop and target in same candle' }; break }
    if (bar.low <= stop) { exit = { time: bar.time, reason: 'stop', price: stop }; break }
    if (bar.high >= target) { exit = { time: bar.time, reason: 'target', price: target }; break }
  }
  const endIndex = exit ? today.findIndex(row => row.time === exit.time) : today.length - 1
  const maeLow = Math.min(entry.close, ...today.slice(entryIndex + 1, endIndex + 1).map(row => row.low))
  trade = { setup: 'prior-four-day-high 5m breakout, 1m retest and bullish reclaim', breakout5m: breakout, retest1m: retest, signalTime: signal.time, signalClose: signal.close, beforeFirst15MinutesComplete: true, entryTime: entry.time, entryPrice: entry.close, stop, risk, target, rewardRiskGross: round((target - entry.close) / risk, 3), knownIntradayHighAtSignal, roomToKnownIntradayHighGrossR, signalVWAPApprox: round(vwapAt(today, signal.time.slice(11)), 2), vwapAtBreakoutApprox: round(vwapAt(today, breakout.end.slice(11)), 2), relativeCumulativeVolumeAtSignal: round(cumulativeAt(today, signal.time.slice(11)) / mean(priorDates.map(date => cumulativeAt(byDate[date], signal.time.slice(11)))), 2), depthAtSignalMinute: depthWindow(tradeDate, signal.time.slice(11), signal.time.slice(11)), depthDuringRetest: depthWindow(tradeDate, retest.time.slice(11), retest.time.slice(11)), exit, returnPct: exit?.price ? round(100 * (exit.price / entry.close - 1)) : null, maxAdverseExcursionPct: round(100 * (maeLow / entry.close - 1)) }
}
const report = {
  symbol, priorDates, tradeDate,
  methodology: { candles: 'one-minute FYERS history; IST timestamps; complete five-minute aggregation', vwap: 'session cumulative typical-price × volume / volume proxy, since tick VWAP is unavailable', depth: 'cash book snapshots received no later than each completed signal minute', execution: 'entry at next completed one-minute candle close; stop/target evaluated from subsequent candles, ambiguous same-candle hits unresolved' },
  daily, priorBreakoutBehaviour, referenceLevels: { priorFourDayHigh: fourDayHigh, priorFourDayLow: fourDayLow, previousDayHigh: previousHigh, previousDayLow: previousLow, priorSessionHighZone: [174.87, 175.25], priorSessionLowZone: [170.5, 170.74] },
  relativeVolume, first5mAboveFourDayHigh, first5mAbovePreviousHigh,
  trade,
  statistics: trade ? { tradeCount: 1, winRatePct: trade.returnPct > 0 ? 100 : 0, averageReturnPct: trade.returnPct, totalReturnPct: trade.returnPct, maximumAdverseExcursionPct: trade.maxAdverseExcursionPct, worstDay: { date: tradeDate, returnPct: trade.returnPct } } : { tradeCount: 0, winRatePct: null, averageReturnPct: null, totalReturnPct: 0, maximumAdverseExcursionPct: null, worstDay: null }
}
let suffix = 1, output
do { output = path.join(root, 'reports', `2026-10-19-UNIONBANK-four-day-context${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ daily, priorBreakoutBehaviour, referenceLevels: report.referenceLevels, relativeVolume, first5mAboveFourDayHigh, trade, statistics: report.statistics, output }, null, 2))
