import fs from "node:fs"
import path from "node:path"
import { createDepthMomentumRadar } from "../ui/depth-momentum.js"

const root = process.cwd()
const archiveRoot = path.join(root, "db", "cash-depth")
const latestDate = fs.readdirSync(archiveRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name).sort().at(-1)
const firstArg = process.argv[2]
const firstArgIsDate = /^\d{4}-\d{2}-\d{2}$/.test(firstArg || "")
const selectedSymbol = firstArgIsDate ? "ALL" : firstArg || "ALL"
const date = firstArgIsDate ? firstArg : process.argv[3] || latestDate
if (!date) throw new Error("No dated cash depth archive found")
const depthDateDir = path.join(root, "db", "cash-depth", date)
const candleDir = path.join(root, "db", "candles")
const indiaDate = (at) => new Date(at + 330 * 60_000).toISOString().slice(0, 10)
const formatTime = (iso) => new Date(iso).toLocaleTimeString("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
})

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

  const radar = createDepthMomentumRadar({ now: () => Date.parse(`${date}T04:00:00.000Z`) })
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
    signal.strategy === "Candle + Depth Absorption Breakout")
}

if (!fs.existsSync(depthDateDir)) throw new Error(`Missing cash depth for ${date}`)
const symbols = selectedSymbol === "ALL"
  ? fs.readdirSync(depthDateDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [selectedSymbol]
const signals = symbols.flatMap(replaySymbol).sort((a, b) => a.time.localeCompare(b.time) || a.symbol.localeCompare(b.symbol))
const outcome = signals.reduce((result, signal) => {
  result[signal.status] = (result[signal.status] || 0) + 1
  return result
}, {})
console.log(`Radar engine replay | ${date} | ${symbols.length} stocks | ${signals.length} absorption signals | ${JSON.stringify(outcome)}`)
if (!process.argv.includes("--summary")) console.table(signals.map((signal) => ({
  symbol: signal.symbol, signalAt: formatTime(signal.time), price: signal.price,
  status: signal.status, target: Number(signal.target.toFixed(2)), stop: Number(signal.stop.toFixed(2)),
  depthImbalance: Number(signal.depthImbalance.toFixed(3)), top2Imbalance: Number(signal.top2Imbalance.toFixed(3)),
})))
