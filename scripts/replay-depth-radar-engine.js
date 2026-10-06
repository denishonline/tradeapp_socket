import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createDepthMomentumRadar, marketBreadthBelowSma20 } from "../ui/depth-momentum.js"

const root = process.cwd()
const archiveRoot = path.join(root, "db", "cash-depth")
const latestDate = fs.readdirSync(archiveRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name).sort().at(-1)
const firstArg = process.argv[2]
const firstArgIsDate = /^\d{4}-\d{2}-\d{2}$/.test(firstArg || "")
const selectedSymbol = firstArgIsDate ? "ALL" : firstArg || "ALL"
const date = firstArgIsDate ? firstArg : process.argv[3] || latestDate
const includeAllStrategies = process.argv.includes("--all-strategies")
const includeFeatures = process.argv.includes("--features")
let marketBreadthAtMinute = null
if (!date) throw new Error("No dated cash depth archive found")
const depthDateDir = path.join(root, "db", "cash-depth", date)
const candleDir = path.join(root, "db", "candles")
const indiaDate = (at) => new Date(at + 330 * 60_000).toISOString().slice(0, 10)
const formatTime = (iso) => new Date(iso).toLocaleTimeString("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
})

function shortFeatures({ current, history, minuteBuckets, currentMinute }) {
  const candles = [...history, current]
  const feature = {}
  for (const period of [5, 10, 20, 30, 50]) {
    const earlier = candles.at(-(period + 1))
    feature[`return${period}`] = earlier?.time === current.time - period * 60
      ? (current.close / earlier.close - 1) * 100 : null
  }
  for (const period of [10, 20, 50]) {
    const rows = candles.slice(-period)
    const average = rows.length === period ? rows.reduce((sum, row) => sum + row.close, 0) / period : 0
    feature[`sma${period}Gap`] = average > 0 ? (current.close / average - 1) * 100 : null
    feature[`redBars${period}`] = rows.length === period ? rows.filter((row) => row.close < row.open).length : null
  }
  const last15 = candles.slice(-15)
  if (last15.length === 15 && last15[0].time === current.time - 14 * 60) {
    const changes = last15.slice(1).map((row, index) => row.close - last15[index].close)
    const gains = changes.reduce((sum, value) => sum + Math.max(value, 0), 0) / 14
    const losses = changes.reduce((sum, value) => sum + Math.max(-value, 0), 0) / 14
    feature.rsi14 = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses)
  } else feature.rsi14 = null
  const prior5 = history.slice(-5)
  const prior10 = history.slice(-10)
  const prior20 = history.slice(-20)
  for (const [period, rows] of [[5, prior5], [10, prior10], [20, prior20]]) {
    const average = rows.length === period ? rows.reduce((sum, row) => sum + row.volume, 0) / period : 0
    feature[`volumeX${period}`] = average > 0 ? current.volume / average : null
  }
  const ranges = last15.slice(1).map((row, index) => Math.max(row.high - row.low,
    Math.abs(row.high - last15[index].close), Math.abs(row.low - last15[index].close)))
  feature.atr14Pct = ranges.length === 14 ? ranges.reduce((sum, value) => sum + value, 0) / 14 / current.close * 100 : null
  feature.range20Pct = candles.length >= 20
    ? (Math.max(...candles.slice(-20).map((row) => row.high)) /
      Math.min(...candles.slice(-20).map((row) => row.low)) - 1) * 100 : null
  const totalVolume = candles.reduce((sum, row) => sum + row.volume, 0)
  const vwap = totalVolume > 0 ? candles.reduce((sum, row) =>
    sum + (row.high + row.low + row.close) / 3 * row.volume, 0) / totalVolume : null
  feature.vwapGap = vwap ? (current.close / vwap - 1) * 100 : null
  feature.candleRangePct = (current.high / current.low - 1) * 100
  for (const period of [3, 5, 10]) {
    const rows = Array.from({ length: period }, (_, index) => minuteBuckets?.get(currentMinute - index))
    if (rows.some((row) => !row)) continue
    const mean = (name) => rows.reduce((sum, row) => sum + row[name], 0) / period
    feature[`depth${period}Full`] = mean("averageImbalance")
    feature[`depth${period}Top2`] = mean("averageNearImbalance")
    feature[`depth${period}Orders`] = mean("averageOrderImbalance")
    feature[`depth${period}BestQueue`] = mean("averageBestLevelImbalance")
    feature[`depth${period}SpreadPct`] = mean("averageSpreadPct")
    feature[`depth${period}Ofi`] = rows.reduce((sum, row) => sum + row.ofi, 0) /
      (rows.reduce((sum, row) => sum + row.ofiDepth, 0) || 1)
    feature[`depth${period}AskFraction`] = rows.reduce((sum, row) => sum + row.askAbsorptionCount, 0) /
      rows.reduce((sum, row) => sum + row.count, 0)
  }
  return feature
}

function replaySymbol(symbol) {
  const depthFile = path.join(depthDateDir, symbol, `${symbol}.jsonl`)
  const candleFile = path.join(candleDir, `${symbol}.jsonl`)
  if (!fs.existsSync(depthFile) || !fs.existsSync(candleFile)) return []

  const candles = []
  for (const line of fs.readFileSync(candleFile, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let candle
    try { candle = JSON.parse(line) } catch { continue }
    if (indiaDate(Number(candle.time) * 1000) !== date) continue
    candles.push({ at: (Number(candle.time) + 60) * 1000 + 1000, candle })
  }
  candles.sort((a, b) => a.at - b.at)

  const radar = createDepthMomentumRadar({
    now: () => Date.parse(`${date}T04:00:00.000Z`),
    marketBreadthAtMinute: (candleTime) => marketBreadthAtMinute?.(candleTime),
    onSignal: includeFeatures ? (signal, context) => {
      if (signal.strategy === "Depth + Candle Short Breakdown") signal.analysis = shortFeatures(context)
    } : undefined,
  })
  const events = []
  for (const line of fs.readFileSync(depthFile, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || indiaDate(at) !== date ||
        !["checkpoint", "update"].includes(record.kind)) continue
    events.push({ at, record })
  }
  events.sort((a, b) => a.at - b.at)

  let candleIndex = 0
  for (const event of events) {
    while (candleIndex < candles.length && candles[candleIndex].at < event.at) {
      radar.observeCandle(symbol, candles[candleIndex].candle)
      candleIndex++
    }
    radar.observeDepth(event.record.data, event.at, event.record.marketContext)
  }
  while (candleIndex < candles.length) {
    radar.observeCandle(symbol, candles[candleIndex].candle)
    candleIndex++
  }
  return radar.snapshot().filter((signal) => signal.symbol === symbol &&
    (includeAllStrategies || signal.strategy === "Candle + Depth Absorption Breakout"))
}

if (!fs.existsSync(depthDateDir)) throw new Error(`Missing cash depth for ${date}`)
const symbols = selectedSymbol === "ALL"
  ? fs.readdirSync(depthDateDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [selectedSymbol]
const universeSymbols = fs.readdirSync(depthDateDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const marketCandles = new Map()
for (const symbol of universeSymbols) {
  const candleFile = path.join(candleDir, `${symbol}.jsonl`)
  if (!fs.existsSync(candleFile)) continue
  const byMinute = new Map()
  for (const line of fs.readFileSync(candleFile, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (indiaDate(Number(row.time) * 1000) !== date) continue
    byMinute.set(Math.floor(Number(row.time) / 60) * 60, { time: Math.floor(Number(row.time) / 60) * 60,
      close: Number(row.close) })
  }
  marketCandles.set(symbol, [...byMinute.values()].sort((a, b) => a.time - b.time))
}
const breadthCache = new Map()
marketBreadthAtMinute = (candleTime) => {
  if (!breadthCache.has(candleTime)) breadthCache.set(candleTime,
    marketBreadthBelowSma20(marketCandles, candleTime, universeSymbols.length))
  return breadthCache.get(candleTime)
}
const signals = symbols.flatMap(replaySymbol).sort((a, b) => a.time.localeCompare(b.time) || a.symbol.localeCompare(b.symbol))
const outcome = signals.reduce((result, signal) => {
  result[signal.status] = (result[signal.status] || 0) + 1
  return result
}, {})
if (includeFeatures) {
  const filename = path.join(os.tmpdir(), `tradeapp-short-signal-features-${date}.json`)
  fs.writeFileSync(filename, JSON.stringify(signals.filter((signal) => signal.strategy === "Depth + Candle Short Breakdown")))
  console.log(`Short-signal features saved: ${filename}`)
}
console.log(`Radar engine replay | ${date} | cash-depth | ${symbols.length} stocks | ${signals.length} ${includeAllStrategies ? "all-strategy" : "absorption"} signals | ${JSON.stringify(outcome)}`)
if (process.argv.includes("--compact")) {
  const strategies = [...new Set(signals.map((signal) => signal.strategy))]
  for (const strategy of strategies) {
    const rows = signals.filter((signal) => signal.strategy === strategy)
    console.log(`\n${strategy} (${rows.length})`)
    for (const status of ["Target reached", "Stopped", "Active", "Paused"]) {
      const matching = rows.filter((signal) => signal.status === status)
      if (matching.length) console.log(`${status} (${matching.length}): ${matching.map((signal) => `${signal.symbol}@${formatTime(signal.time)}`).join(", ")}`)
    }
  }
  process.exit(0)
}
if (!process.argv.includes("--summary")) console.table(signals.map((signal) => ({
  strategy: signal.strategy, symbol: signal.symbol, signalAt: formatTime(signal.time),
  direction: signal.direction, price: signal.price,
  status: signal.status, target: Number(signal.target.toFixed(2)), stop: Number(signal.stop.toFixed(2)),
  depthImbalance: Number(signal.depthImbalance.toFixed(3)), top2Imbalance: Number(signal.top2Imbalance.toFixed(3)),
})))
