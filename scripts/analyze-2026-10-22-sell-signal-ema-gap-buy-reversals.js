import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-10-22'
const IST = 330 * 60_000
const signals = [
  ['KALYANKJIL', '09:18'], ['SAIL', '09:21'], ['CAMS', '09:22'], ['PETRONET', '09:24'],
  ['POWERINDIA', '09:24'], ['SONACOMS', '09:25'], ['LUPIN', '09:26'], ['ALKEM', '09:27'],
]
const minimumTwoReturnPct = 0.15, minimumDepthSharePct = 50, minimumMidpointMovePct = 0.02
const stamp = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const minuteOf = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
const timeOf = seconds => stamp(seconds).slice(11)
const dateOf = seconds => stamp(seconds).slice(0, 10)
const pct = (value, base) => 100 * (value / base - 1)
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function candles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line), minute = minuteOf(timeOf(row.time))
      if (dateOf(row.time) > date || minute < 555 || minute >= 930 || ![row.open, row.high, row.low, row.close, row.volume].every(value => Number.isFinite(+value))) return []
      return [{ time: stamp(row.time), day: dateOf(row.time), minute, open: +row.open, high: +row.high, low: +row.low, close: +row.close }]
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

function findReversal(symbol, sellTime) {
  const rows = candles(symbol), startMinute = minuteOf(sellTime), depth = depthByMinute(symbol)
  if (!rows.length) return { symbol, sellTime, status: 'no candle data' }
  let ema5 = null
  for (const row of rows) { ema5 = ema5 == null ? row.close : row.close * (2 / 6) + ema5 * (4 / 6); row.ema5 = ema5 }
  for (let index = 1; index < rows.length; index++) {
    const left = rows[index - 1], right = rows[index]
    if (right.day !== date || right.minute <= startMinute) continue
    const leftDepth = depth.get(left.time), rightDepth = depth.get(right.time)
    if (!leftDepth || !rightDepth) continue
    const twoMinuteReturnPct = pct(right.close, left.open)
    const bidSharePct = (leftDepth.bidShare + rightDepth.bidShare) / 2
    const midpointMovePct = pct(rightDepth.midpoint, leftDepth.midpoint)
    if (twoMinuteReturnPct >= minimumTwoReturnPct && right.ema5 > left.ema5 && right.close > right.ema5 && bidSharePct >= minimumDepthSharePct && midpointMovePct > minimumMidpointMovePct) {
      const signalTime = right.time
      const entryMinute = right.minute + 1
      return { symbol, sellTime, status: 'BUY reversal found', signalTime, entryTime: `${date} ${String(Math.floor(entryMinute / 60)).padStart(2, '0')}:${String(entryMinute % 60).padStart(2, '0')}`, twoMinuteReturnPct: round(twoMinuteReturnPct), ema5: round(right.ema5), priorEma5: round(left.ema5), close: right.close, bidSharePct: round(bidSharePct), midpointMovePct: round(midpointMovePct) }
    }
  }
  return { symbol, sellTime, status: 'no radar BUY reversal before close' }
}

const results = signals.map(([symbol, sellTime]) => findReversal(symbol, sellTime))
const report = {
  date,
  method: 'Applied the EMA gap reversal radar post-signal BUY conditions only. The supplied SELL times are the starting points, so the radar top-10 EMA-gap candidate-selection gate is not applied.',
  rules: { minimumTwoReturnPct, ema5Rising: true, closeAboveEma5: true, minimumDepthSharePct, minimumMidpointMovePct, entry: 'next completed one-minute candle' },
  results,
}
let output = path.join(root, 'reports', `${date}-supplied-sell-signals-ema-gap-buy-reversal-check.json`), attempt = 2
while (fs.existsSync(output)) output = path.join(root, 'reports', `${date}-supplied-sell-signals-ema-gap-buy-reversal-check-${attempt++}.json`)
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
for (const row of results) console.log(row.status === 'BUY reversal found' ? `${row.symbol} SELL ${row.sellTime} -> BUY reversal ${row.signalTime.slice(11)} | entry ${row.entryTime.slice(11)} | return ${row.twoMinuteReturnPct}% | depth ${row.bidSharePct}%` : `${row.symbol} SELL ${row.sellTime} -> ${row.status}`)
console.log(`Report: ${output}`)
