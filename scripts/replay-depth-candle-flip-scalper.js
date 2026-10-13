import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const root = typeof nodeRepl === "undefined" ? process.cwd() : nodeRepl.cwd
const day = "2026-10-09"
const IST_OFFSET = 330 * 60_000
const depthRoot = path.join(root, "db", "cash-depth", day)
const candleRoot = path.join(root, "db", "candles")
const output = path.join(root, "csv", "2026-10-09-depth-candle-flip-scalper.csv")

const clamp = (value, low = -1, high = 1) => Math.min(high, Math.max(low, value))
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 19)

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
      bid = bidPrice
      ask = askPrice
      bid1 = currentBidSize
      ask1 = currentAskSize
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

async function readCandles(symbol) {
  const result = []
  for await (const row of records(path.join(candleRoot, `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000
    if (indiaDate(at) !== day) continue
    const candle = { at, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) }
    if (Object.values(candle).every(Number.isFinite)) result.push(candle)
  }
  return result.sort((left, right) => left.at - right.at)
}

async function readDepth(symbol) {
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
    if (!book) continue
    const marketPrice = Number(record.marketContext?.price)
    bySecond.set(Math.floor(at / 1000), { at, ...book,
      price: Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : book.mid })
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
  return samples
}

function ema(values, length) {
  if (!values.length) return NaN
  const alpha = 2 / (length + 1)
  return values.reduce((value, next, index) => index ? alpha * next + (1 - alpha) * value : next)
}

function candleFeatures(candles, at) {
  const completed = candles.filter((row) => row.at + 60_000 <= at)
  if (completed.length < 10) return null
  const recent10 = completed.slice(-10)
  const recent5 = completed.slice(-5)
  const previous5 = completed.slice(-10, -5)
  const recent3 = completed.slice(-3)
  const return3 = pct(recent3.at(-1).close, recent3[0].open)
  const greenCount = recent3.filter((row) => row.close > row.open).length
  const redCount = recent3.filter((row) => row.close < row.open).length
  const volume5 = recent5.reduce((sum, row) => sum + row.volume, 0)
  const previousVolume5 = previous5.reduce((sum, row) => sum + row.volume, 0)
  const volumeRatio = previousVolume5 ? volume5 / previousVolume5 : NaN
  const vwap5 = volume5 ? recent5.reduce((sum, row) =>
    sum + row.volume * (row.high + row.low + row.close) / 3, 0) / volume5 : NaN
  const closes = completed.map((row) => row.close)
  const ema3 = ema(closes, 3)
  const ema8 = ema(closes, 8)
  const emaGap = pct(ema3, ema8)
  const vwapGap = pct(recent5.at(-1).close, vwap5)
  const path = [recent3[0].open, ...recent3.map((row) => row.close)]
  const travel = path.slice(1).reduce((sum, value, index) => sum + Math.abs(value - path[index]), 0)
  const efficiency = travel ? (path.at(-1) - path[0]) / travel : 0
  const greenVolume = recent5.filter((row) => row.close > row.open).reduce((sum, row) => sum + row.volume, 0)
  const redVolume = recent5.filter((row) => row.close < row.open).reduce((sum, row) => sum + row.volume, 0)
  const volumeDirection = volume5 ? (greenVolume - redVolume) / volume5 : 0
  const previousHigh = Math.max(...completed.slice(-3).map((row) => row.high))
  const previousLow = Math.min(...completed.slice(-3).map((row) => row.low))
  return { return3, greenCount, redCount, volumeRatio, emaGap, vwapGap,
    efficiency, volumeDirection, previousHigh, previousLow }
}

function scoreAt(samples, index, candles) {
  const current = samples[index]
  const from = current.at - 15_000
  const window = []
  for (let cursor = index; cursor >= 0 && samples[cursor].at >= from; cursor--) window.push(samples[cursor])
  window.reverse()
  if (window.length < 8 || current.at - window[0].at < 9_000) return null
  if (window.some((row, rowIndex) => rowIndex && row.at - window[rowIndex - 1].at > 2_500)) return null
  const features = candleFeatures(candles, current.at)
  if (!features) return null
  const ofi = mean(window.slice(1).map((row) => row.ofi))
  const top2 = mean(window.map((row) => row.top2))
  const full = mean(window.map((row) => row.full))
  const midReturn = pct(current.mid, window[0].mid)
  const buyAligned = window.filter((row) => row.full > 0 && row.top2 > 0).length / window.length
  const sellAligned = window.filter((row) => row.full < 0 && row.top2 < 0).length / window.length
  const persistence = buyAligned - sellAligned
  const score =
    20 * clamp(ofi / 0.12) +
    15 * clamp(top2 / 0.12) +
    10 * clamp(full / 0.08) +
    10 * clamp(midReturn / 0.08) +
    5 * clamp(persistence / 0.65) +
    10 * clamp(features.return3 / 0.15) +
    8 * clamp(features.emaGap / 0.05) +
    8 * clamp(features.vwapGap / 0.10) +
    8 * clamp(features.volumeDirection / 0.30) +
    6 * clamp(features.efficiency / 0.45)
  return { score, ofi, top2, full, midReturn, buyAligned, sellAligned, ...features }
}

function entrySide(metrics, sample) {
  const common = metrics.volumeRatio >= 1.10
  const buy = metrics.score >= 65 && metrics.ofi >= 0.12 && metrics.top2 >= 0.12 &&
    metrics.full >= 0.08 && metrics.buyAligned >= 0.65 && metrics.midReturn > 0 &&
    metrics.greenCount >= 2 && metrics.return3 > 0.15 && metrics.emaGap > 0 &&
    metrics.vwapGap > 0 && common && metrics.efficiency >= 0.45 && sample.mid > metrics.previousHigh
  const sell = metrics.score <= -65 && metrics.ofi <= -0.12 && metrics.top2 <= -0.12 &&
    metrics.full <= -0.08 && metrics.sellAligned >= 0.65 && metrics.midReturn < 0 &&
    metrics.redCount >= 2 && metrics.return3 < -0.15 && metrics.emaGap < 0 &&
    metrics.vwapGap < 0 && common && metrics.efficiency <= -0.45 && sample.mid < metrics.previousLow
  return buy ? "BUY" : sell ? "SELL" : null
}

function evaluateTrade(samples, metricsByIndex, entryIndex, side) {
  const entrySample = samples[entryIndex]
  const entry = side === "BUY" ? entrySample.ask : entrySample.bid
  const deadline = entrySample.at + 5 * 60_000
  let exitIndex = Math.min(samples.length - 1, entryIndex + 1)
  let weakCount = 0
  let bestProfit = -Infinity
  let worstMove = Infinity
  let bestAt = entrySample.at
  let reason = "5-minute time exit"
  for (let index = entryIndex + 1; index < samples.length && samples[index].at <= deadline; index++) {
    const sample = samples[index]
    const tradable = side === "BUY" ? sample.bid : sample.ask
    const move = side === "BUY" ? pct(tradable, entry) : -pct(tradable, entry)
    if (move > bestProfit) { bestProfit = move; bestAt = sample.at }
    worstMove = Math.min(worstMove, move)
    const metrics = metricsByIndex[index]
    const weak = metrics && (side === "BUY" ? metrics.score < 20 : metrics.score > -20)
    weakCount = weak ? weakCount + 1 : 0
    exitIndex = index
    if (weakCount >= 5) { reason = "direction score exit"; break }
  }
  const exitSample = samples[exitIndex]
  const exit = side === "BUY" ? exitSample.bid : exitSample.ask
  const realized = side === "BUY" ? pct(exit, entry) : -pct(exit, entry)
  return { entry, exit, exitAt: exitSample.at, realized, bestProfit, worstMove, bestAt, reason }
}

async function scanStock(symbol) {
  const [samples, candles] = await Promise.all([readDepth(symbol), readCandles(symbol)])
  const metricsByIndex = samples.map((sample, index) => scoreAt(samples, index, candles))
  let candidateSide = null
  let consecutive = 0
  for (let index = 0; index < samples.length; index++) {
    const metrics = metricsByIndex[index]
    const side = metrics ? entrySide(metrics, samples[index]) : null
    if (side && side === candidateSide && index && samples[index].at - samples[index - 1].at <= 2_500) consecutive++
    else { candidateSide = side; consecutive = side ? 1 : 0 }
    if (side && consecutive >= 8) {
      return { date: day, symbol, side, signalAt: samples[index].at,
        ...metrics, ...evaluateTrade(samples, metricsByIndex, index, side) }
    }
  }
  return null
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
    } catch (error) {
      console.error(`${symbol}: ${error.message}`)
    }
  }
}))
signals.sort((left, right) => right.bestProfit - left.bestProfit || left.signalAt - right.signalAt)

const columns = ["rank", "date", "symbol", "side", "signal_time", "entry", "exit_time", "exit",
  "realized_pct", "max_profit_pct", "max_profit_time", "max_adverse_pct", "exit_reason", "score",
  "ofi_15s", "top2_imbalance_15s", "five_level_imbalance_15s", "aligned_depth_pct",
  "mid_return_15s_pct", "return_3m_pct", "volume_ratio_5v5", "ema3_ema8_gap_pct",
  "vwap5_gap_pct", "candle_efficiency"]
const lines = [columns.join(",")]
signals.forEach((row, index) => lines.push([
  index + 1, row.date, row.symbol, row.side, indiaTime(row.signalAt), round(row.entry),
  indiaTime(row.exitAt), round(row.exit), round(row.realized), round(row.bestProfit),
  indiaTime(row.bestAt), round(row.worstMove), row.reason, round(row.score, 1), round(row.ofi),
  round(row.top2), round(row.full), round((row.side === "BUY" ? row.buyAligned : row.sellAligned) * 100, 1),
  round(row.midReturn), round(row.return3), round(row.volumeRatio), round(row.emaGap),
  round(row.vwapGap), round(row.efficiency),
].join(",")))
await fsp.writeFile(output, `${lines.join("\n")}\n`)

export { readCandles, readDepth, scoreAt, indiaTime, pct, round }

export const result = {
  output, stocksScanned: symbols.length, eligibleStocks: signals.length,
  profitableExits: signals.filter((row) => row.realized > 0).length,
  losingExits: signals.filter((row) => row.realized < 0).length,
  top: signals.slice(0, 20).map((row, index) => ({
    rank: index + 1, symbol: row.symbol, side: row.side, signal: indiaTime(row.signalAt),
    entry: round(row.entry), score: round(row.score, 1), maxProfit: round(row.bestProfit),
    maxProfitTime: indiaTime(row.bestAt), maxAdverse: round(row.worstMove),
    exit: round(row.exit), exitTime: indiaTime(row.exitAt), realized: round(row.realized),
    exitReason: row.reason, ofi: round(row.ofi), top2: round(row.top2), full: round(row.full),
    aligned: round((row.side === "BUY" ? row.buyAligned : row.sellAligned) * 100, 1),
    return3: round(row.return3), volumeRatio: round(row.volumeRatio),
  })),
}

if (typeof nodeRepl === "undefined") console.log(JSON.stringify(result, null, 2))
