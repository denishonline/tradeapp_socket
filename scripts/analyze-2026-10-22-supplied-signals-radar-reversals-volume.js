import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-10-19'
const IST = 330 * 60_000
const signals = [
  ['PERSISTENT', '09:16', 'BUY'], ['NCC', '09:17', 'BUY'], ['NIFTYPSUBANK', '09:24', 'BUY'], ['BANKBARODA', '09:26', 'BUY'], ['CANBK', '09:26', 'BUY'], ['BANKINDIA', '09:27', 'BUY'], ['UNIONBANK', '09:27', 'BUY'], ['DIVISLAB', '09:30', 'BUY'], ['SBIN', '09:31', 'BUY'], ['MANKIND', '09:35', 'BUY'], ['EICHERMOT', '09:36', 'BUY'], ['PREMIERENE', '09:41', 'BUY'], ['ULTRACEMCO', '09:51', 'BUY'], ['SHREECEM', '09:53', 'BUY'],
  ['INOXWIND', '09:18', 'SELL'], ['AXISBANK', '09:21', 'SELL'], ['KFINTECH', '09:26', 'SELL'], ['HAVELLS', '09:27', 'SELL'], ['NHPC', '09:27', 'SELL'], ['LTF', '09:28', 'SELL'], ['POLICYBZR', '09:28', 'SELL'], ['BDL', '09:29', 'SELL'], ['SRF', '09:29', 'SELL'], ['CAMS', '09:30', 'SELL'], ['CYIENTDLM', '09:30', 'SELL'], ['HDFCBANK', '09:30', 'SELL'], ['PGEL', '09:30', 'SELL'], ['SAMMAANCAP', '09:30', 'SELL'], ['POLYCAB', '09:31', 'SELL'], ['360ONE', '09:36', 'SELL'], ['OBEROIRLTY', '09:36', 'SELL'], ['IEX', '09:42', 'SELL'], ['COLPAL', '09:44', 'SELL'], ['MFSL', '09:57', 'SELL'], ['ICICIPRULI', '09:58', 'SELL'], ['MOTILALOFS', '09:58', 'SELL'],
]
const minimumTwoReturnPct = 0.15, minimumDepthSharePct = 50, minimumMidpointMovePct = 0.15
const minimumQualifiedReturnPct = 0.35, reversalDeadlineMinute = 600, maximumVolumeRatio = 1.3
const stamp = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const minuteOf = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const timeOf = seconds => stamp(seconds).slice(11)
const dateOf = seconds => stamp(seconds).slice(0, 10)
const pct = (value, base) => 100 * (value / base - 1)
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const trendAngle = values => {
  const n = values.length, meanX = (n - 1) / 2, logs = values.map(Math.log), meanY = logs.reduce((sum, value) => sum + value, 0) / n
  let covariance = 0, variance = 0
  logs.forEach((value, index) => { covariance += (index - meanX) * (value - meanY); variance += (index - meanX) ** 2 })
  return Math.atan(100 * covariance / variance) * 180 / Math.PI
}

function candles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line), minute = minuteOf(timeOf(row.time))
      if (dateOf(row.time) > date || minute < 555 || minute >= 930 || ![row.open, row.high, row.low, row.close, row.volume].every(value => Number.isFinite(+value))) return []
      return [{ time: stamp(row.time), day: dateOf(row.time), minute, open: +row.open, close: +row.close, volume: +row.volume }]
    } catch { return [] }
  }).sort((a, b) => a.time.localeCompare(b.time))
}

function depthByMinute(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  const state = {}, output = new Map()
  if (!fs.existsSync(file)) return output
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line), received = stamp(Date.parse(event.receivedAt) / 1000), minute = minuteOf(received.slice(11))
      if (received.slice(0, 10) !== date || minute < 555 || minute >= 930) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
      Object.assign(state, event.data ?? {})
      let bid = 0, ask = 0, valid = true
      for (let level = 1; level <= 5; level++) {
        const bidPrice = +state[`bid_price${level}`], askPrice = +state[`ask_price${level}`], bidSize = +state[`bid_size${level}`], askSize = +state[`ask_size${level}`]
        if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) || bidPrice <= 0 || askPrice <= bidPrice) { valid = false; break }
        bid += bidSize; ask += askSize
      }
      if (valid) output.set(received, { bidShare: 100 * bid / (bid + ask || 1), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
    } catch { /* Ignore malformed depth events. */ }
  }
  return output
}

function findReversal(symbol, originalSide, originalTime) {
  if (originalSide !== 'SELL') return { symbol, originalSide, originalTime, reversalSide: 'BUY', status: 'outside long-only reversal scope' }
  const rows = candles(symbol), depth = depthByMinute(symbol), originalMinute = minuteOf(originalTime)
  const reversalSide = originalSide === 'BUY' ? 'SELL' : 'BUY', direction = reversalSide === 'BUY' ? 1 : -1
  if (!rows.length) return { symbol, originalSide, originalTime, reversalSide, status: 'no candle data' }
  let ema5 = null
  let firstSecondaryFailure = null
  const diagnostics = { radar: 0, volume: 0, reverseColour: 0, all: 0 }
  for (const row of rows) { ema5 = ema5 == null ? row.close : row.close * (2 / 6) + ema5 * (4 / 6); row.ema5 = ema5 }
  for (let index = 1; index < rows.length; index++) {
    const left = rows[index - 1], right = rows[index]
    if (right.day !== date || right.minute <= originalMinute || right.minute >= reversalDeadlineMinute) continue
    const leftDepth = depth.get(left.time), rightDepth = depth.get(right.time)
    if (!leftDepth || !rightDepth) continue
    const twoMinuteReturnPct = direction * pct(right.close, left.open)
    const directionalSharePct = (direction === 1 ? leftDepth.bidShare + rightDepth.bidShare : (100 - leftDepth.bidShare) + (100 - rightDepth.bidShare)) / 2
    const midpointMovePct = direction * pct(rightDepth.midpoint, leftDepth.midpoint)
    const radarPass = twoMinuteReturnPct >= minimumTwoReturnPct && direction * (right.ema5 - left.ema5) > 0 && direction * (right.close - right.ema5) > 0 && directionalSharePct > minimumDepthSharePct && midpointMovePct > minimumMidpointMovePct
    if (!radarPass) continue
    diagnostics.radar += 1
    const sessionRows = rows.filter(row => row.day === date && row.minute >= 555 && row.minute <= right.minute)
    const lastFive = sessionRows.slice(-5)
    const lastFiveAverageVolume = lastFive.reduce((sum, row) => sum + row.volume, 0) / lastFive.length
    const sessionAverageVolume = sessionRows.reduce((sum, row) => sum + row.volume, 0) / sessionRows.length
    const volumeRatio = lastFiveAverageVolume / sessionAverageVolume
    const volumePass = lastFive.length === 5 && volumeRatio > 1 && volumeRatio < maximumVolumeRatio
    const reverseColourCandles = lastFive.filter(row => direction === 1 ? row.close > row.open : row.close < row.open).length
    const candlePatternPass = reverseColourCandles >= 3
    const secondaryPass = twoMinuteReturnPct >= minimumQualifiedReturnPct && volumePass && candlePatternPass
    if (volumePass) diagnostics.volume += 1
    if (reverseColourCandles >= 3) diagnostics.reverseColour += 1
    if (secondaryPass) diagnostics.all += 1
    const result = {
      symbol, originalSide, originalTime, reversalSide, reversalSignalTime: right.time, entryTime: `${date} ${String(Math.floor((right.minute + 1) / 60)).padStart(2, '0')}:${String((right.minute + 1) % 60).padStart(2, '0')}`,
      status: secondaryPass ? 'reversal and all filters pass' : 'radar reversal, secondary filters failed',
      twoMinuteReturnPct: round(twoMinuteReturnPct), directionalDepthSharePct: round(directionalSharePct), midpointMovePct: round(midpointMovePct), lastFiveAverageVolume: round(lastFiveAverageVolume, 2), sessionAverageVolume: round(sessionAverageVolume, 2), volumeRatio: round(volumeRatio, 3), volumePass, reverseColourCandles, candlePatternPass, diagnostics,
    }
    if (secondaryPass) return result
    if (!firstSecondaryFailure) firstSecondaryFailure = result
  }
  return firstSecondaryFailure ?? { symbol, originalSide, originalTime, reversalSide, status: 'no radar reversal before close', diagnostics }
}

const results = signals.map(([symbol, time, side]) => findReversal(symbol, side, time))
const report = {
  date,
  method: 'Long-only post-SELL EMA-gap radar reversal screen. The radar top-10 EMA-gap candidate-selection gate is excluded because starting signals are user supplied. A BUY reversal must occur before 10:00 IST, have a two-minute up move of at least 0.35%, bid-side depth share above 50%, midpoint increase above 0.15%, at least three bullish candles in the latest five, and a last-five-candle average volume above but below 1.30 times the session average through the signal.',
  radarRules: { minimumTwoReturnPct, ema5TurnsWithDirection: true, closeBeyondEma5: true, minimumDepthSharePct, minimumMidpointMovePct, entry: 'next completed one-minute candle' },
  results,
}
let output = path.join(root, 'reports', `${date}-supplied-buy-sell-signals-radar-reversals-last5-volume.json`), attempt = 2
while (fs.existsSync(output)) output = path.join(root, 'reports', `${date}-supplied-buy-sell-signals-radar-reversals-last5-volume-${attempt++}.json`)
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
const passed = results.filter(row => row.status === 'reversal and all filters pass')
const stageCounts = ['radar', 'volume', 'reverseColour', 'all'].reduce((totals, key) => ({ ...totals, [key]: results.reduce((sum, row) => sum + (row.diagnostics?.[key] || 0), 0) }), {})
console.log(`Passed ${passed.length}/${results.length}`)
console.log(`Radar candidates ${stageCounts.radar} | volume pass ${stageCounts.volume} | 3 reverse-colour candles ${stageCounts.reverseColour} | all ${stageCounts.all}`)
for (const row of results) console.log(row.status === 'reversal and all filters pass' ? `${row.symbol} ${row.originalSide} ${row.originalTime} -> ${row.reversalSide} ${row.reversalSignalTime.slice(11)} entry ${row.entryTime.slice(11)} | last5 ${row.lastFiveAverageVolume} > day ${row.sessionAverageVolume} | candles ${row.reverseColourCandles}/5` : `${row.symbol} ${row.originalSide} ${row.originalTime} -> ${row.status}`)
console.log(`Report: ${output}`)
