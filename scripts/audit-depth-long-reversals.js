import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const runtimeArgs = typeof process === "undefined" ? [] : process.argv.slice(2)
const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const defaultDays = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]
const days = runtimeArgs.filter((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg))
const sessions = days.length ? days : defaultDays
const windows = [10, 15, 20, 25, 30]
const IST_OFFSET = 330 * 60_000
const depthRoot = path.join(root, "db", "cash-depth")
const candleRoot = path.join(root, "db", "candles")
const output = path.join(root, "csv", "2026-10-05-to-09-depth-10-to-30m-reversal-audit.csv")

const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 16)
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const slope = (values) => {
  const n = values.length
  if (n < 2) return 0
  const sx = n * (n - 1) / 2
  const sy = values.reduce((sum, value) => sum + value, 0)
  const sxx = (n - 1) * n * (2 * n - 1) / 6
  const sxy = values.reduce((sum, value, index) => sum + index * value, 0)
  const denominator = n * sxx - sx * sx
  return denominator ? (n * sxy - sx * sy) / denominator : 0
}

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final record. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function bookMetrics(data) {
  let bidSize = 0, askSize = 0, bid2 = 0, ask2 = 0
  let bestBid = NaN, bestAsk = NaN
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data[`bid_price${level}`])
    const ask = Number(data[`ask_price${level}`])
    const bidQty = Number(data[`bid_size${level}`])
    const askQty = Number(data[`ask_size${level}`])
    if (![bid, ask, bidQty, askQty].every(Number.isFinite) ||
        bid <= 0 || ask <= bid || bidQty < 0 || askQty < 0) return null
    if (level === 1) { bestBid = bid; bestAsk = ask }
    bidSize += bidQty
    askSize += askQty
    if (level <= 2) { bid2 += bidQty; ask2 += askQty }
  }
  return {
    mid: (bestBid + bestAsk) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bid2 - ask2) / (bid2 + ask2 || 1),
  }
}

async function loadCandles() {
  const result = new Map()
  const files = (await fsp.readdir(candleRoot)).filter((name) => name.endsWith(".jsonl"))
  for (const name of files) {
    const symbol = name.slice(0, -6)
    const rows = []
    for await (const row of records(path.join(candleRoot, name))) {
      const at = Number(row.time) * 1000
      if (!sessions.includes(indiaDate(at))) continue
      rows.push({ at, open: Number(row.open), high: Number(row.high), low: Number(row.low),
        close: Number(row.close), volume: Number(row.volume) })
    }
    rows.sort((left, right) => left.at - right.at)
    result.set(symbol, rows)
  }
  return result
}

async function minuteDepth(day, symbol) {
  const fields = {}
  const minutes = new Map()
  let lastAt = 0
  const filename = path.join(depthRoot, day, symbol, `${symbol}.jsonl`)
  for await (const record of records(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || indiaDate(at) !== day) continue
    if (lastAt && at - lastAt > 90_000) for (const key of Object.keys(fields)) delete fields[key]
    lastAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    const book = bookMetrics(fields)
    if (!book) continue
    const minute = Math.floor(at / 60_000) * 60_000
    const bucket = minutes.get(minute) ?? {
      at: minute, updates: 0, full: 0, top2: 0,
      firstMid: book.mid, lastMid: book.mid,
    }
    bucket.updates++
    bucket.full += book.full
    bucket.top2 += book.top2
    bucket.lastMid = book.mid
    minutes.set(minute, bucket)
  }
  return [...minutes.values()].map((row) => ({ ...row,
    full: row.full / row.updates, top2: row.top2 / row.updates,
  })).sort((left, right) => left.at - right.at)
}

function outcome(candles, index, side) {
  const entryCandle = candles[index + 1]
  const entry = entryCandle.open
  const target = side === "BUY" ? entry * 1.02 : entry * 0.98
  const stop = side === "BUY" ? entry * 0.996 : entry * 1.004
  let status = "Unresolved", resolvedAt = null, maxFavourable = 0, maxAdverse = 0
  for (const candle of candles.slice(index + 1)) {
    if (side === "BUY") {
      maxFavourable = Math.max(maxFavourable, pct(candle.high, entry))
      maxAdverse = Math.min(maxAdverse, pct(candle.low, entry))
      if (candle.low <= stop) { status = "Stop"; resolvedAt = candle.at; break }
      if (candle.high >= target) { status = "Target"; resolvedAt = candle.at; break }
    } else {
      maxFavourable = Math.max(maxFavourable, -pct(candle.low, entry))
      maxAdverse = Math.min(maxAdverse, -pct(candle.high, entry))
      if (candle.high >= stop) { status = "Stop"; resolvedAt = candle.at; break }
      if (candle.low <= target) { status = "Target"; resolvedAt = candle.at; break }
    }
  }
  return { entry, target, stop, status, resolvedAt, maxFavourable, maxAdverse }
}

async function scanStock(day, symbol, candleMap) {
  const depth = await minuteDepth(day, symbol)
  const candles = (candleMap.get(symbol) ?? []).filter((row) => indiaDate(row.at) === day)
  const candleIndex = new Map(candles.map((row, index) => [row.at, index]))
  const found = []
  for (const windowMinutes of windows) {
    const priorLength = Math.ceil(windowMinutes * 0.6)
    const recentLength = windowMinutes - priorLength
    let lastSignal = { BUY: 0, SELL: 0 }
    for (let index = windowMinutes - 1; index < depth.length; index++) {
      const window = depth.slice(index - windowMinutes + 1, index + 1)
      if (window.some((row, offset) => offset && row.at !== window[offset - 1].at + 60_000) ||
          window.some((row) => row.updates < 3)) continue
      const prior = window.slice(0, priorLength)
      const recent = window.slice(priorLength)
      const priorFull = mean(prior.map((row) => row.full))
      const recentFull = mean(recent.map((row) => row.full))
      const fullChange = recentFull - priorFull
      const top2Change = mean(recent.map((row) => row.top2)) - mean(prior.map((row) => row.top2))
      const side = fullChange >= 0 ? "BUY" : "SELL"
      const sign = side === "BUY" ? 1 : -1
      const alignedMinutes = recent.filter((row) => sign * row.full > 0 && sign * row.top2 > 0).length
      const persistence = alignedMinutes / recent.length
      const recentSlope = sign * slope(recent.map((row) => row.full))
      const depthMidMove = sign * pct(recent.at(-1).lastMid, recent[0].firstMid)
      if (!(sign * priorFull < 0 && sign * recentFull >= 0.05 &&
          sign * fullChange >= 0.25 && sign * top2Change >= 0.15 &&
          persistence >= 0.60 && recentSlope > 0 && depthMidMove >= 0.03)) continue
      const atIndex = candleIndex.get(depth[index].at)
      if (atIndex == null || atIndex < 9 || atIndex + 1 >= candles.length) continue
      const recentCandles = candles.slice(atIndex - 4, atIndex + 1)
      const candleReturn = sign * pct(recentCandles.at(-1).close, recentCandles[0].open)
      const sameCandles = recentCandles.filter((row) => side === "BUY"
        ? row.close > row.open : row.close < row.open).length
      const volume = recentCandles.reduce((sum, row) => sum + row.volume, 0)
      const vwap = volume ? recentCandles.reduce((sum, row) =>
        sum + row.volume * (row.high + row.low + row.close) / 3, 0) / volume : NaN
      const vwapGap = sign * pct(recentCandles.at(-1).close, vwap)
      const previousVolume = mean(candles.slice(atIndex - 9, atIndex - 4).map((row) => row.volume))
      const volumeRatio = previousVolume > 0 ? mean(recentCandles.map((row) => row.volume)) / previousVolume : NaN
      if (!(candleReturn >= 0.15 && sameCandles >= 3 && vwapGap >= 0 && volumeRatio >= 0.80)) continue
      const signalAt = depth[index].at + 60_000
      if (lastSignal[side] > signalAt - 15 * 60_000) continue
      lastSignal[side] = signalAt
      found.push({ date: day, symbol, side, windowMinutes, priorMinutes: priorLength,
        recentMinutes: recentLength, signalAt, priorFull, recentFull,
        fullShift: sign * fullChange, top2Shift: sign * top2Change,
        persistence, recentSlope, depthMidMove, candleReturn,
        sameCandles, vwapGap, volumeRatio, ...outcome(candles, atIndex, side) })
    }
  }
  return found
}

const candleMap = await loadCandles()
const signals = []
for (const day of sessions) {
  const symbols = (await fsp.readdir(path.join(depthRoot, day), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  let cursor = 0
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (cursor < symbols.length) {
      const symbol = symbols[cursor++]
      try { signals.push(...await scanStock(day, symbol, candleMap)) } catch { /* Continue the audit. */ }
    }
  }))
  console.log(JSON.stringify({ day, signals: signals.filter((row) => row.date === day).length }))
}

signals.sort((left, right) => left.signalAt - right.signalAt ||
  left.symbol.localeCompare(right.symbol) || left.windowMinutes - right.windowMinutes)
const columns = ["date", "symbol", "side", "window_minutes", "prior_minutes", "recent_minutes",
  "signal_time", "entry", "target", "stop", "status", "resolved_time", "prior_full", "recent_full",
  "full_shift", "top2_shift", "persistent_depth_share", "recent_depth_slope", "depth_mid_move_pct",
  "candle_return_5_pct", "same_side_candles", "vwap_gap_pct", "volume_ratio",
  "max_favourable_pct", "max_adverse_pct"]
const lines = [columns.join(",")]
for (const row of signals) lines.push([
  row.date, row.symbol, row.side, row.windowMinutes, row.priorMinutes, row.recentMinutes,
  indiaTime(row.signalAt), row.entry, round(row.target), round(row.stop), row.status,
  row.resolvedAt ? indiaTime(row.resolvedAt) : "", round(row.priorFull), round(row.recentFull),
  round(row.fullShift), round(row.top2Shift), round(row.persistence), round(row.recentSlope),
  round(row.depthMidMove), round(row.candleReturn), row.sameCandles, round(row.vwapGap),
  round(row.volumeRatio), round(row.maxFavourable), round(row.maxAdverse),
].join(","))
await fsp.writeFile(output, `${lines.join("\n")}\n`)

const statuses = ["Target", "Stop", "Unresolved"]
const outcomeCounts = (rows) => Object.fromEntries(statuses.map((status) =>
  [status, rows.filter((row) => row.status === status).length]))
console.log(JSON.stringify({ output, total: signals.length,
  byWindow: Object.fromEntries(windows.map((window) =>
    [window, outcomeCounts(signals.filter((row) => row.windowMinutes === window))])),
  byDay: Object.fromEntries(sessions.map((day) =>
    [day, outcomeCounts(signals.filter((row) => row.date === day))])),
}, null, 2))
