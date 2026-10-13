import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = "2026-10-09"
const IST_OFFSET = 330 * 60_000
const WINDOW = 15
const depthRoot = path.join(root, "db", "cash-depth", day)
const candleRoot = path.join(root, "db", "candles")
const output = path.join(root, "csv", "2026-10-09-smooth-one-sided-depth-candle-signals.csv")

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 16)

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
  let bid = NaN, ask = NaN, bid1 = NaN, ask1 = NaN
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(data[`bid_price${level}`])
    const askPrice = Number(data[`ask_price${level}`])
    const currentBidSize = Number(data[`bid_size${level}`])
    const currentAskSize = Number(data[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBidSize, currentAskSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBidSize < 0 || currentAskSize < 0) return null
    if (level === 1) {
      bid = bidPrice; ask = askPrice; bid1 = currentBidSize; ask1 = currentAskSize
    }
    bidSize += currentBidSize
    askSize += currentAskSize
    if (level <= 2) { bid2 += currentBidSize; ask2 += currentAskSize }
  }
  return {
    bid, ask, bid1, ask1, mid: (bid + ask) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bid2 - ask2) / (bid2 + ask2 || 1),
  }
}

function regressionR2(values) {
  const n = values.length
  if (n < 3) return 0
  const meanX = (n - 1) / 2
  const meanY = mean(values)
  let covariance = 0, varianceX = 0, varianceY = 0
  for (let index = 0; index < n; index++) {
    const dx = index - meanX
    const dy = values[index] - meanY
    covariance += dx * dy
    varianceX += dx * dx
    varianceY += dy * dy
  }
  return varianceX && varianceY ? covariance ** 2 / (varianceX * varianceY) : 0
}

function directionalConsistency(values, sign) {
  let aligned = 0, changed = 0
  for (let index = 1; index < values.length; index++) {
    const change = values[index] - values[index - 1]
    if (!change) continue
    changed++
    if (sign * change > 0) aligned++
  }
  return changed ? aligned / changed : 0
}

function efficiency(values, sign) {
  const travel = values.slice(1).reduce((sum, value, index) =>
    sum + Math.abs(value - values[index]), 0)
  return travel ? sign * (values.at(-1) - values[0]) / travel : 0
}

async function readCandles(symbol) {
  const result = []
  for await (const row of records(path.join(candleRoot, `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000
    if (indiaDate(at) !== day) continue
    result.push({ at, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) })
  }
  return result.sort((left, right) => left.at - right.at)
}

async function readMinuteDepth(symbol) {
  const filename = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  const fields = {}
  const bySecond = new Map()
  let lastAt = 0
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
    if (book) bySecond.set(Math.floor(at / 1000), { at, ...book })
  }
  const samples = [...bySecond.values()].sort((left, right) => left.at - right.at)
  let previous = null
  for (const sample of samples) {
    sample.ofi = 0
    if (previous) {
      let flow = sample.bid > previous.bid ? sample.bid1
        : sample.bid === previous.bid ? sample.bid1 - previous.bid1 : -previous.bid1
      flow -= sample.ask < previous.ask ? sample.ask1
        : sample.ask === previous.ask ? sample.ask1 - previous.ask1 : -previous.ask1
      sample.ofi = flow / ((sample.bid1 + sample.ask1 + previous.bid1 + previous.ask1) / 2 || 1)
    }
    previous = sample
  }
  const grouped = new Map()
  for (const sample of samples) {
    const minute = Math.floor(sample.at / 60_000) * 60_000
    if (!grouped.has(minute)) grouped.set(minute, [])
    grouped.get(minute).push(sample)
  }
  return [...grouped].map(([at, rows]) => ({
    at, updates: rows.length, openMid: rows[0].mid, closeMid: rows.at(-1).mid,
    full: mean(rows.map((row) => row.full)), top2: mean(rows.map((row) => row.top2)),
    ofi: mean(rows.slice(1).map((row) => row.ofi)),
    buyAligned: rows.filter((row) => row.full > 0 && row.top2 > 0).length / rows.length,
    sellAligned: rows.filter((row) => row.full < 0 && row.top2 < 0).length / rows.length,
  })).sort((left, right) => left.at - right.at)
}

function scoreWindow(depth, candles, endIndex) {
  const selectedCandles = candles.slice(endIndex - WINDOW + 1, endIndex + 1)
  const depthByMinute = new Map(depth.map((row) => [row.at, row]))
  const selectedDepth = selectedCandles.map((candle) => depthByMinute.get(candle.at))
  if (selectedDepth.some((row) => !row || row.updates < 3)) return null
  const closeValues = selectedCandles.map((row) => row.close)
  const midValues = selectedDepth.map((row) => row.closeMid)
  const candleReturn = pct(selectedCandles.at(-1).close, selectedCandles[0].open)
  const depthReturn = pct(selectedDepth.at(-1).closeMid, selectedDepth[0].openMid)
  if (!candleReturn || !depthReturn || Math.sign(candleReturn) !== Math.sign(depthReturn)) return null
  const sign = candleReturn > 0 ? 1 : -1
  const side = sign > 0 ? "BUY" : "SELL"
  const candleR2 = regressionR2(closeValues)
  const depthR2 = regressionR2(midValues)
  const candleConsistency = directionalConsistency(closeValues, sign)
  const depthConsistency = directionalConsistency(midValues, sign)
  const candleEfficiency = efficiency([selectedCandles[0].open, ...closeValues], sign)
  const depthEfficiency = efficiency([selectedDepth[0].openMid, ...midValues], sign)
  const bookPressure = sign * mean(selectedDepth.map((row) => (row.full + row.top2) / 2))
  const ofi = sign * mean(selectedDepth.map((row) => row.ofi))
  const bookAlignment = mean(selectedDepth.map((row) => sign > 0 ? row.buyAligned : row.sellAligned))
  const sameCandles = selectedCandles.filter((row) => sign > 0
    ? row.close > row.open : row.close < row.open).length / selectedCandles.length
  const volume = selectedCandles.reduce((sum, row) => sum + row.volume, 0)
  const vwap = volume ? selectedCandles.reduce((sum, row) =>
    sum + row.volume * (row.high + row.low + row.close) / 3, 0) / volume : NaN
  const vwapGap = sign * pct(selectedCandles.at(-1).close, vwap)

  // These are the live trigger gates. They use only the completed 15-minute window.
  if (!(Math.abs(candleReturn) >= 0.60 && Math.abs(depthReturn) >= 0.25 &&
      candleR2 >= 0.75 && depthR2 >= 0.70 &&
      candleConsistency >= 0.65 && depthConsistency >= 0.65 &&
      candleEfficiency >= 0.60 && depthEfficiency >= 0.55 &&
      bookAlignment >= 0.45 && bookPressure >= 0.02 && ofi >= -0.02 &&
      sameCandles >= 0.60 && vwapGap >= 0)) return null

  const depthScore = 15 * depthR2 + 15 * depthConsistency + 10 * depthEfficiency +
    5 * clamp(bookAlignment / 0.8, 0, 1) + 5 * clamp((bookPressure + 0.02) / 0.20, 0, 1)
  const candleScore = 15 * candleR2 + 15 * candleEfficiency + 10 * candleConsistency +
    5 * clamp(Math.abs(candleReturn) / 2, 0, 1) + 5 * clamp(sameCandles / 0.8, 0, 1)
  return {
    side, signalAt: selectedCandles.at(-1).at + 60_000,
    depthScore, candleScore, totalScore: depthScore + candleScore,
    candleReturn, depthReturn, candleR2, depthR2, candleConsistency,
    depthConsistency, candleEfficiency, depthEfficiency, bookPressure,
    bookAlignment, ofi, sameCandles, vwapGap,
  }
}

function outcome(candles, signal, entryIndex) {
  const entry = candles[entryIndex].open
  const sign = signal.side === "BUY" ? 1 : -1
  let maxFavourable = 0, maxAdverse = 0, status = "Unresolved", resolvedAt = null
  const target = sign > 0 ? entry * 1.02 : entry * 0.98
  const stop = sign > 0 ? entry * 0.996 : entry * 1.004
  for (const candle of candles.slice(entryIndex)) {
    if (sign > 0) {
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

async function scanStock(symbol) {
  const [depth, candles] = await Promise.all([readMinuteDepth(symbol), readCandles(symbol)])
  let signal = null
  for (let index = WINDOW - 1; index + 1 < candles.length; index++) {
    const candidate = scoreWindow(depth, candles, index)
    if (!candidate) continue
    signal = { date: day, symbol, ...candidate, ...outcome(candles, candidate, index + 1) }
    break
  }
  return signal
}

const symbols = (await fsp.readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const signals = []
let cursor = 0
await Promise.all(Array.from({ length: 12 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try {
      const signal = await scanStock(symbol)
      if (signal) signals.push(signal)
    } catch { /* Continue scanning other stocks. */ }
  }
}))
signals.sort((left, right) => right.totalScore - left.totalScore || left.signalAt - right.signalAt)

const columns = ["rank", "date", "symbol", "side", "signal_time", "entry", "target", "stop",
  "status", "resolved_time", "total_score", "depth_score_50", "candle_score_50",
  "depth_return_15_pct", "candle_return_15_pct", "depth_r2", "candle_r2",
  "depth_direction_consistency_pct", "candle_direction_consistency_pct", "depth_efficiency",
  "candle_efficiency", "book_pressure", "book_alignment_pct", "normalized_ofi",
  "same_side_candles_pct", "vwap_gap_pct", "max_favourable_pct", "max_adverse_pct"]
const lines = [columns.join(",")]
signals.forEach((row, index) => lines.push([
  index + 1, row.date, row.symbol, row.side, indiaTime(row.signalAt), row.entry,
  round(row.target), round(row.stop), row.status, row.resolvedAt ? indiaTime(row.resolvedAt) : "",
  round(row.totalScore, 2), round(row.depthScore, 2), round(row.candleScore, 2),
  round(row.depthReturn), round(row.candleReturn), round(row.depthR2), round(row.candleR2),
  round(row.depthConsistency * 100, 1), round(row.candleConsistency * 100, 1),
  round(row.depthEfficiency), round(row.candleEfficiency), round(row.bookPressure),
  round(row.bookAlignment * 100, 1), round(row.ofi), round(row.sameCandles * 100, 1),
  round(row.vwapGap), round(row.maxFavourable), round(row.maxAdverse),
].join(",")))
await fsp.writeFile(output, `${lines.join("\n")}\n`)

console.log(JSON.stringify({ output, stocksScanned: symbols.length, signals: signals.length,
  outcomes: Object.fromEntries(["Target", "Stop", "Unresolved"].map((status) =>
    [status, signals.filter((row) => row.status === status).length])),
  top: signals.slice(0, 20).map((row, index) => ({
    rank: index + 1, symbol: row.symbol, side: row.side, signal: indiaTime(row.signalAt),
    entry: row.entry, score: round(row.totalScore, 2), depth: round(row.depthScore, 2),
    candles: round(row.candleScore, 2), depthReturn: round(row.depthReturn),
    candleReturn: round(row.candleReturn), depthR2: round(row.depthR2),
    candleR2: round(row.candleR2), bookAlignment: round(row.bookAlignment * 100, 1),
    status: row.status, maxFavourable: round(row.maxFavourable), maxAdverse: round(row.maxAdverse),
  }))
}, null, 2))
