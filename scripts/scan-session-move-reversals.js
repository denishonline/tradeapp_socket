import fs from 'node:fs'
import path from 'node:path'

// Finds an intraday reversal only after the stock first moves +/-2% from the
// 09:15 open.  All tests use completed one-minute candles strictly before the
// requested cutoff. Entry is the close of the next completed one-minute candle.
const root = process.cwd(), candlesDir = path.join(root, 'db', 'candles')
const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const cutoffText = arg('--cutoff'), requestedSymbol = arg('--symbol')?.toUpperCase().replace(/-EQ$/, '')
const match = cutoffText?.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/)
if (!match || (requestedSymbol && !/^[A-Z0-9-]+$/.test(requestedSymbol))) throw new Error('Usage: node scripts/scan-session-move-reversals.js --cutoff "YYYY-MM-DD HH:MM" [--symbol SYMBOL]')
const [, date, hour, minuteText] = match, cutoffMinute = Number(hour) * 60 + Number(minuteText)
if (cutoffMinute < 556 || cutoffMinute > 930) throw new Error('Cutoff must be from 09:16 through 15:30 IST.')

const IST = 330 * 60_000, sessionStart = 555, reversalDeadline = 600
const stamp = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const dayOf = seconds => stamp(seconds).slice(0, 10)
const minuteOf = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
const pct = (value, base) => 100 * (value / base - 1)
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const timeOf = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const csv = value => value == null ? '' : String(value)
const candleCache = new Map(), depthCache = new Map()

function candles(symbol) {
  if (candleCache.has(symbol)) return candleCache.get(symbol)
  const file = path.join(candlesDir, `${symbol}.jsonl`)
  const rows = !fs.existsSync(file) ? [] : fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const raw = JSON.parse(line), day = dayOf(raw.time), minute = minuteOf(stamp(raw.time).slice(11))
      if (day > date || minute < sessionStart || minute >= 930 || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => Number.isFinite(+value))) return []
      return [{ time: stamp(raw.time), day, minute, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume }]
    } catch { return [] }
  }).sort((a, b) => a.time.localeCompare(b.time))
  let ema5
  for (const row of rows) { ema5 = ema5 == null ? row.close : row.close * 2 / 6 + ema5 * 4 / 6; row.ema5 = ema5 }
  candleCache.set(symbol, rows)
  return rows
}

function depth(symbol) {
  if (depthCache.has(symbol)) return depthCache.get(symbol)
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`), state = {}, out = new Map()
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line), received = stamp(Date.parse(event.receivedAt) / 1000), receivedMinute = minuteOf(received.slice(11))
      if (received.slice(0, 10) !== date || receivedMinute < sessionStart || receivedMinute >= cutoffMinute) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
      Object.assign(state, event.data ?? {})
      let bid = 0, ask = 0, valid = true
      for (let level = 1; level <= 5; level++) {
        const bidPrice = +state[`bid_price${level}`], askPrice = +state[`ask_price${level}`], bidSize = +state[`bid_size${level}`], askSize = +state[`ask_size${level}`]
        if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) || bidPrice <= 0 || askPrice <= bidPrice) { valid = false; break }
        bid += bidSize; ask += askSize
      }
      if (valid) out.set(received, { bidShare: 100 * bid / (bid + ask || 1), midpoint: (+state.bid_price1 + +state.ask_price1) / 2 })
    } catch { /* Ignore malformed depth events. */ }
  }
  depthCache.set(symbol, out)
  return out
}

function firstReversal(symbol) {
  const all = candles(symbol), session = all.filter(row => row.day === date && row.minute >= sessionStart && row.minute < cutoffMinute)
  if (session.length < 7) return null
  const openingPrice = session[0].open, book = depth(symbol), candidates = {}
  for (const row of session) {
    const sessionMovePct = pct(row.close, openingPrice)
    if (!candidates.BUY && sessionMovePct > 2) candidates.BUY = row
    if (!candidates.SELL && sessionMovePct < -2) candidates.SELL = row
  }
  const found = []
  for (const [originalSide, trigger] of Object.entries(candidates)) {
    const reversalSide = originalSide === 'BUY' ? 'SELL' : 'BUY', direction = reversalSide === 'BUY' ? 1 : -1
    for (let index = 1; index < session.length - 1; index++) {
      const left = session[index - 1], right = session[index], entry = session[index + 1]
      // The entry candle must be complete by cutoff; no future candle is used.
      if (right.minute <= trigger.minute || right.minute >= reversalDeadline || entry.minute >= cutoffMinute) continue
      const leftDepth = book.get(left.time), rightDepth = book.get(right.time)
      if (!leftDepth || !rightDepth) continue
      const lastFive = session.slice(Math.max(0, index - 4), index + 1)
      if (lastFive.length !== 5) continue
      const sessionToSignal = session.slice(0, index + 1)
      const lastFiveAverageVolume = lastFive.reduce((sum, row) => sum + row.volume, 0) / 5
      const sessionAverageVolume = sessionToSignal.reduce((sum, row) => sum + row.volume, 0) / sessionToSignal.length
      const volumeRatio = lastFiveAverageVolume / sessionAverageVolume
      const directionalDepthSharePct = direction === 1 ? (leftDepth.bidShare + rightDepth.bidShare) / 2 : ((100 - leftDepth.bidShare) + (100 - rightDepth.bidShare)) / 2
      const midpointMovePct = direction * pct(rightDepth.midpoint, leftDepth.midpoint)
      const twoMinuteMovePct = direction * pct(right.close, left.open)
      const directionalCandles = lastFive.filter(row => direction === 1 ? row.close > row.open : row.close < row.open).length
      if (twoMinuteMovePct <= 0.30 || direction * (right.ema5 - left.ema5) <= 0 || direction * (right.close - right.ema5) <= 0 || directionalDepthSharePct <= 50 || midpointMovePct <= 0.16 || directionalCandles < 3 || volumeRatio <= 1 || volumeRatio >= 1.5) continue
      found.push({ symbol, originalSide, reversalSide, originalTriggerTime: trigger.time, originalTriggerMovePct: sessionMovePctAt(trigger, openingPrice), reversalTime: right.time, entryTime: entry.time, entryPrice: entry.close, stopLossPrice: reversalSide === 'BUY' ? entry.close * 0.992 : entry.close * 1.008, twoMinuteMovePct, directionalDepthSharePct, midpointMovePct, directionalCandles, volumeRatio })
      break
    }
  }
  return found
}

function sessionMovePctAt(row, openingPrice) { return pct(row.close, openingPrice) }

const symbols = requestedSymbol ? [requestedSymbol] : fs.readdirSync(candlesDir).filter(name => name.endsWith('.jsonl') && name !== 'NIFTY50.jsonl').map(name => path.basename(name, '.jsonl'))
const signals = symbols.flatMap(symbol => firstReversal(symbol) ?? []).sort((a, b) => a.reversalTime.localeCompare(b.reversalTime) || a.reversalSide.localeCompare(b.reversalSide) || a.symbol.localeCompare(b.symbol))
let out = path.join(root, 'reports', `${date}-${timeOf(cutoffMinute).replace(':', '')}-session-move-reversal-signals.csv`), suffix = 2
while (fs.existsSync(out)) out = path.join(root, 'reports', `${date}-${timeOf(cutoffMinute).replace(':', '')}-session-move-reversal-signals-${suffix++}.csv`)
const fields = ['date', 'stock', 'original_side', 'original_trigger_time_ist', 'original_trigger_move_pct', 'reversal_side', 'reversal_time_ist', 'entry_time_ist', 'entry_price', 'stop_loss_price', 'two_minute_move_pct', 'directional_depth_share_pct', 'midpoint_move_pct', 'directional_candles_last5', 'volume_ratio_last5_to_session']
const lines = [fields.join(',')]
for (const signal of signals) lines.push([date, signal.symbol, signal.originalSide, signal.originalTriggerTime.slice(11), round(signal.originalTriggerMovePct), signal.reversalSide, signal.reversalTime.slice(11), signal.entryTime.slice(11), round(signal.entryPrice, 2), round(signal.stopLossPrice, 2), round(signal.twoMinuteMovePct), round(signal.directionalDepthSharePct, 2), round(signal.midpointMovePct), signal.directionalCandles, round(signal.volumeRatio)].map(csv).join(','))
fs.writeFileSync(out, `${lines.join('\n')}\n`)
console.log(`Cutoff ${date} ${timeOf(cutoffMinute)} IST | ${signals.length} reversal signals`)
if (signals.length) {
  console.log('STOCK  TIME  SIDE  ENTRY  STOP')
  for (const signal of signals) console.log(`${signal.symbol.padEnd(12)} ${signal.reversalTime.slice(11)}  ${signal.reversalSide.padEnd(4)}  ${round(signal.entryPrice, 2)}  ${round(signal.stopLossPrice, 2)}`)
}
