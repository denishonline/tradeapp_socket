import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const MINUTE = 60_000
const INDIA_OFFSET = 330 * MINUTE
const DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]
const TARGET_PCT = 1
const STOP_PCT = 0.5
const MAX_HOLD_MINUTES = 120
const USE_TRAILING = process.argv.includes("--trail")
const BREAKEVEN_TRIGGER_PCT = 0.5
const TRAIL_DISTANCE_PCT = 0.4

function localEpoch(date, hour, minute) {
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hour, minute) - INDIA_OFFSET
}

function localDate(epoch) {
  return new Date(epoch + INDIA_OFFSET).toISOString().slice(0, 10)
}

function localTime(epoch) {
  return new Date(epoch + INDIA_OFFSET).toISOString().slice(11, 16)
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index), upper = Math.ceil(index)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

function readJsonLines(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function readCandles(symbol) {
  const rows = readJsonLines(path.join(CANDLE_ROOT, `${symbol}.jsonl`))
  const byDate = new Map()
  for (const row of rows) {
    const at = Number(row.time) * 1000
    if (!Number.isFinite(at)) continue
    const date = localDate(at)
    if (!DAYS.includes(date)) continue
    const candle = { at, open: +row.open, high: +row.high, low: +row.low, close: +row.close }
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(candle)
  }
  for (const rowsForDate of byDate.values()) rowsForDate.sort((a, b) => a.at - b.at)
  return byDate
}

function readDepth(symbol, date) {
  const filename = path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)
  const rows = readJsonLines(filename)
  const byMinute = new Map()
  let previousVolume = null
  let previousAsk1 = null
  for (const record of rows) {
    const receivedAt = Date.parse(record.receivedAt)
    const priceAt = Date.parse(record.marketContext?.priceAt) || receivedAt
    if (!Number.isFinite(priceAt) || localDate(priceAt) !== date) continue
    const data = record.data || {}
    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    const ask1 = Number(data.ask_price1)
    const shareParts = []
    let bid = 0, ask = 0, validBook = true
    for (let level = 1; level <= 5; level++) {
      const bp = Number(data[`bid_price${level}`]), ap = Number(data[`ask_price${level}`])
      const bq = Number(data[`bid_size${level}`]), aq = Number(data[`ask_size${level}`])
      if (![bp, ap, bq, aq].every(Number.isFinite) || bp <= 0 || ap <= bp || bq < 0 || aq < 0) {
        validBook = false
        break
      }
      bid += bq; ask += aq
    }
    const minute = Math.floor(priceAt / MINUTE) * MINUTE
    const bucket = byMinute.get(minute) || { volume: 0, askLiftVolume: 0, bidShareSum: 0, bidShareSamples: 0 }
    if (Number.isFinite(cumulativeVolume) && previousVolume !== null && cumulativeVolume >= previousVolume) {
      const executed = cumulativeVolume - previousVolume
      bucket.volume += executed
      if (executed > 0 && Number.isFinite(ask1) && Number.isFinite(previousAsk1) && ask1 > previousAsk1) {
        bucket.askLiftVolume += executed
      }
    }
    if (validBook && bid + ask > 0) {
      bucket.bidShareSum += 100 * bid / (bid + ask)
      bucket.bidShareSamples++
    }
    byMinute.set(minute, bucket)
    if (Number.isFinite(cumulativeVolume)) previousVolume = cumulativeVolume
    if (Number.isFinite(ask1)) previousAsk1 = ask1
  }
  return byMinute
}

function candleWindows(candles, depthByMinute, date) {
  const rows = candles.filter((row) => row.at >= localEpoch(date, 9, 15) && row.at < localEpoch(date, 15, 31))
  const windows = []
  for (let i = 4; i < rows.length; i++) {
    const five = rows.slice(i - 4, i + 1)
    if (five.some((row, index) => index > 0 && row.at !== five[index - 1].at + MINUTE)) continue
    const start = five[0].at
    const end = five.at(-1).at + MINUTE
    const depth = [...Array(5)].map((_, index) => depthByMinute.get(start + index * MINUTE))
    if (depth.some((row) => !row)) continue
    const high = Math.max(...five.map((row) => row.high))
    const low = Math.min(...five.map((row) => row.low))
    const range = high - low
    const volume = depth.reduce((sum, row) => sum + row.volume, 0)
    const askLiftVolume = depth.reduce((sum, row) => sum + row.askLiftVolume, 0)
    const bidSamples = depth.reduce((sum, row) => sum + row.bidShareSamples, 0)
    const bidSum = depth.reduce((sum, row) => sum + row.bidShareSum, 0)
    windows.push({
      date, windowStart: start, confirmedAt: end, volume,
      up: five.filter((row) => row.close > row.open).length,
      candleReturn: 100 * (five.at(-1).close / five[0].open - 1),
      closeLocation: range > 0 ? 100 * (five.at(-1).close - low) / range : 0,
      bodyEfficiency: range > 0 ? 100 * five.reduce((sum, row) => sum + Math.abs(row.close - row.open), 0) / range : 0,
      askLift: volume > 0 ? 100 * askLiftVolume / volume : 0,
      bidShare: bidSamples > 0 ? bidSum / bidSamples : 0,
    })
  }
  return windows
}

function outcome(signal, candles) {
  const future = candles.filter((row) => row.at >= signal.confirmedAt && row.at < signal.confirmedAt + MAX_HOLD_MINUTES * MINUTE)
  if (!future.length) return { result: "NO_DATA" }
  const entry = future[0].open
  const target = entry * (1 + TARGET_PCT / 100)
  let stop = entry * (1 - STOP_PCT / 100)
  let highWater = entry
  let reachedTarget = false
  if (USE_TRAILING) {
    for (const row of future) {
      // Check the active stop before updating the high-water mark. This is conservative
      // when a candle touches both the stop and a new high.
      if (row.low <= stop) {
        return {
          result: reachedTarget ? "TRAIL" : "STOP",
          reachedTarget, entry, target, stop, exitAt: row.at,
          returnPct: 100 * (stop / entry - 1),
        }
      }
      highWater = Math.max(highWater, row.high)
      if (highWater >= entry * (1 + BREAKEVEN_TRIGGER_PCT / 100)) {
        stop = Math.max(stop, entry)
      }
      if (highWater >= target) {
        reachedTarget = true
        stop = Math.max(stop, entry, highWater * (1 - TRAIL_DISTANCE_PCT / 100))
      }
    }
    return { result: reachedTarget ? "TARGET_TIME" : "TIME", reachedTarget, entry, target, stop,
      exitAt: future.at(-1).at, returnPct: 100 * (future.at(-1).close / entry - 1) }
  }
  for (const row of future) {
    const hitTarget = row.high >= target
    const hitStop = row.low <= stop
    if (hitStop || hitTarget) {
      return {
        result: hitStop ? "STOP" : "TARGET", reachedTarget: !hitStop && hitTarget,
        entry, target, stop, exitAt: row.at,
        returnPct: hitStop ? -STOP_PCT : TARGET_PCT,
      }
    }
  }
  return { result: "TIME", reachedTarget: false, entry, target, stop, exitAt: future.at(-1).at,
    returnPct: 100 * (future.at(-1).close / entry - 1) }
}

const stocks = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
const symbolData = new Map()
const allWindows = []
for (const rawSymbol of stocks) {
  const symbol = String(rawSymbol).trim().toUpperCase().replace(/-EQ$/, "")
  const candlesByDate = readCandles(symbol)
  const windows = []
  for (const date of DAYS) {
    const candles = candlesByDate.get(date) || []
    if (!candles.length) continue
    windows.push(...candleWindows(candles, readDepth(symbol, date), date).map((row) => ({ ...row, symbol })))
  }
  symbolData.set(symbol, candlesByDate)
  allWindows.push(...windows)
}

const bySymbol = new Map()
for (const row of allWindows) {
  if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, [])
  bySymbol.get(row.symbol).push(row.volume)
}
const p75 = new Map([...bySymbol].map(([symbol, values]) => [symbol, percentile(values, .75)]))
const firstSignals = []
for (const row of allWindows.sort((a, b) => a.confirmedAt - b.confirmedAt || a.symbol.localeCompare(b.symbol))) {
  if (row.up < 3 || row.candleReturn <= 0 || row.closeLocation < 80 || row.bodyEfficiency < 80 ||
      row.volume < (p75.get(row.symbol) || Infinity) || row.askLift < 50 || row.bidShare <= 50) continue
  if (firstSignals.some((signal) => signal.date === row.date && signal.symbol === row.symbol)) continue
  const exit = outcome(row, (symbolData.get(row.symbol)?.get(row.date) || []).filter((candle) => candle.at >= localEpoch(row.date, 9, 15)))
  firstSignals.push({ ...row, ...exit })
}

const selected = firstSignals.filter((row) => USE_TRAILING
  ? row.reachedTarget && row.returnPct > TARGET_PCT
  : row.result === "TARGET")
const counts = Object.fromEntries(DAYS.map((date) => [date, selected.filter((row) => row.date === date).length]))
if (process.argv.includes("--compact")) {
  console.log(JSON.stringify({
    scannedSignals: firstSignals.length,
    strategy: USE_TRAILING ? "trailing target" : "fixed target",
    outcomes: Object.fromEntries([...new Set(["TARGET", "TARGET_TIME", "TRAIL", "STOP", "TIME", "NO_DATA"])].map((key) => [key, firstSignals.filter((row) => row.result === key).length])),
    selectedByDate: counts,
    signals: selected.sort((a, b) => a.confirmedAt - b.confirmedAt).map((row) => `${row.date} ${localTime(row.confirmedAt)} ${row.symbol} ${row.returnPct >= 0 ? "+" : ""}${row.returnPct.toFixed(2)}%`),
  }, null, 2))
  process.exit(0)
}
console.log(JSON.stringify({
  assumptions: { strategy: USE_TRAILING ? "trailing target" : "fixed target", targetPct: TARGET_PCT, stopPct: STOP_PCT, breakevenTriggerPct: USE_TRAILING ? BREAKEVEN_TRIGGER_PCT : null, trailDistancePct: USE_TRAILING ? TRAIL_DISTANCE_PCT : null, maxHoldMinutes: MAX_HOLD_MINUTES, sameBar: "stop-first", entry: "first candle open at/after confirmation" },
  scannedSignals: firstSignals.length,
  outcomes: Object.fromEntries(["TARGET", "STOP", "TIME", "NO_DATA"].map((key) => [key, firstSignals.filter((row) => row.result === key).length])),
  selectedByDate: counts,
  selected: selected.sort((a, b) => a.confirmedAt - b.confirmedAt).map((row) => ({
    date: row.date, symbol: row.symbol, signal: localTime(row.confirmedAt), entry: Number(row.entry.toFixed(2)),
    target: Number(row.target.toFixed(2)), stop: Number(row.stop.toFixed(2)), returnPct: row.returnPct,
    volume: Math.round(row.volume), up: row.up, askLift: Number(row.askLift.toFixed(1)), bidShare: Number(row.bidShare.toFixed(1)),
  })),
}, null, 2))
