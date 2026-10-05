import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readdir } from "node:fs/promises"
import { DEPTH_SHORT_BREAKDOWN_RULE, evaluateDepthShortBreakdown } from "../ui/depth-momentum.js"

const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth")
const candleRoot = path.join(root, "db", "candles")
const showAll = process.argv.includes("--all")
const outputJson = process.argv.includes("--json")
// Keep only setups that reached more than 2% downside before the 0.5% stop.
const targetPct = 2.01
const stopPct = 0.5
const { minimumBreakdownPct: minBreakoutPct, maximumBreakdownPct: maxBreakoutPct, minimumVolumeMultiple: minVolumeMultiple } = DEPTH_SHORT_BREAKDOWN_RULE

const date = (await readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name).sort().at(-1)
if (!date) throw new Error("No dated cash-depth history found")
const dateDir = path.join(depthRoot, date)
const stockDirs = (await readdir(dateDir, { withFileTypes: true })).filter((entry) => entry.isDirectory())

const fmt = (at) => new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(at))

async function* lines(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const reader = readline.createInterface({ input, crlfDelay: Infinity })
  try { for await (const line of reader) if (line.trim()) yield line }
  finally { reader.close(); input.destroy() }
}

function depthMetrics(book) {
  let bid = 0, ask = 0, nearBid = 0, nearAsk = 0
  const bidPrices = [], askPrices = []
  for (let level = 1; level <= 5; level++) {
    const bp = Number(book[`bid_price${level}`]), bq = Number(book[`bid_size${level}`])
    const ap = Number(book[`ask_price${level}`]), aq = Number(book[`ask_size${level}`])
    if (![bp, bq, ap, aq].every(Number.isFinite) || bp <= 0 || ap <= 0 || bq < 0 || aq < 0) return null
    if (level > 1 && (bp > bidPrices.at(-1) || ap < askPrices.at(-1))) return null
    bidPrices.push(bp); askPrices.push(ap)
    bid += bq; ask += aq
    if (level <= 2) { nearBid += bq; nearAsk += aq }
  }
  if (bid + ask === 0 || bidPrices[0] >= askPrices[0]) return null
  return { imbalance: (bid - ask) / (bid + ask), nearImbalance: (nearBid - nearAsk) / (nearBid + nearAsk || 1) }
}

function candleFeatures(candles, index, current, depth) {
  const features = {}
  for (const period of [5, 10, 20, 30, 50]) {
    const start = index - period
    const bars = candles.slice(start, index + 1)
    const contiguous = start >= 0 && bars.length === period + 1 && bars.every((bar, offset) =>
      offset === 0 || bar.minute === bars[offset - 1].minute + 1)
    features[`return${period}`] = contiguous ? (current.close / bars[0].close - 1) * 100 : null
  }
  for (const period of [20, 50]) {
    const start = index - period + 1
    const bars = candles.slice(start, index + 1)
    const contiguous = start >= 0 && bars.length === period && bars.every((bar, offset) =>
      offset === 0 || bar.minute === bars[offset - 1].minute + 1)
    const average = contiguous ? bars.reduce((sum, bar) => sum + bar.close, 0) / period : null
    features[`sma${period}Gap`] = average ? (current.close / average - 1) * 100 : null
  }
  const last15 = candles.slice(index - 14, index + 1)
  const rsiContiguous = last15.length === 15 && last15.every((bar, offset) =>
    offset === 0 || bar.minute === last15[offset - 1].minute + 1)
  if (rsiContiguous) {
    const changes = last15.slice(1).map((bar, offset) => bar.close - last15[offset].close)
    const gains = changes.reduce((sum, change) => sum + Math.max(change, 0), 0) / 14
    const losses = changes.reduce((sum, change) => sum + Math.max(-change, 0), 0) / 14
    features.rsi14 = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses)
  } else features.rsi14 = null
  const last10 = candles.slice(index - 9, index + 1)
  features.redBars10 = last10.length === 10 ? last10.filter((bar) => bar.close < bar.open).length : null
  for (const period of [5, 10]) {
    const rows = Array.from({ length: period }, (_, offset) => depth.get(current.minute - offset))
    features[`depth${period}Full`] = rows.every(Boolean)
      ? rows.reduce((sum, row) => sum + row.imbalance, 0) / period : null
    features[`depth${period}Top2`] = rows.every(Boolean)
      ? rows.reduce((sum, row) => sum + row.nearImbalance, 0) / period : null
  }
  return Object.fromEntries(Object.entries(features).map(([key, value]) => [key, value == null ? null : Number(value.toFixed(4))]))
}

async function readDepth(filename) {
  const byMinute = new Map(), raw = {}
  let lastAt = 0
  for await (const line of lines(filename)) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || new Date(at + 330 * 60_000).toISOString().slice(0, 10) !== date) continue
    if (lastAt && at - lastAt > 90_000) for (const key of Object.keys(raw)) delete raw[key]
    lastAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(raw)) delete raw[key]
      Object.assign(raw, record.data)
    } else if (record.kind === "update") Object.assign(raw, record.data)
    else continue
    const metrics = depthMetrics(raw)
    const priceAt = Date.parse(record.marketContext?.priceAt) || at
    if (!metrics || new Date(priceAt + 330 * 60_000).toISOString().slice(0, 10) !== date) continue
    const minute = Math.floor(priceAt / 60_000)
    const row = byMinute.get(minute) ?? { minute, count: 0, imbalance: 0, nearImbalance: 0 }
    row.count++
    row.imbalance += metrics.imbalance
    row.nearImbalance += metrics.nearImbalance
    byMinute.set(minute, row)
  }
  for (const row of byMinute.values()) {
    row.imbalance /= row.count
    row.nearImbalance /= row.count
  }
  return byMinute
}

async function readCandles(symbol) {
  const filename = path.join(candleRoot, `${symbol}.jsonl`)
  const byMinute = new Map()
  if (!fs.existsSync(filename)) return byMinute
  for await (const line of lines(filename)) {
    let candle
    try { candle = JSON.parse(line) } catch { continue }
    const minute = Math.floor(Number(candle.time) / 60)
    if (!Number.isFinite(minute) || new Date(minute * 60_000 + 330 * 60_000).toISOString().slice(0, 10) !== date) continue
    if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every((value) => Number.isFinite(Number(value)))) continue
    byMinute.set(minute, {
      minute, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low),
      close: Number(candle.close), volume: Number(candle.volume),
    })
  }
  return byMinute
}

const signals = []
for (const dir of stockDirs) {
  const symbol = dir.name
  const depthFile = path.join(dateDir, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(depthFile)) continue
  const [depth, candleMap] = await Promise.all([readDepth(depthFile), readCandles(symbol)])
  const candles = [...candleMap.values()].sort((a, b) => a.minute - b.minute)
  let activeSignal = null, lastSignalMinute = -Infinity

  for (let i = 10; i < candles.length; i++) {
    const current = candles[i]
    if (activeSignal) {
      const stopHit = current.high >= activeSignal.stop
      const targetHit = current.low <= activeSignal.target
      if (stopHit || targetHit) {
        activeSignal.outcome = stopHit ? "STOP first" : "TARGET first"
        activeSignal.outcomeBar = fmt((current.minute + 1) * 60_000)
        activeSignal = null
      }
    }

    const previous10 = candles.slice(i - 10, i)
    if (previous10.some((bar, j) => j > 0 && bar.minute !== previous10[j - 1].minute + 1) || current.minute !== previous10.at(-1).minute + 1) continue
    const depthWindow = [current.minute - 2, current.minute - 1, current.minute].map((minute) => depth.get(minute))
    if (depthWindow.some((row) => !row)) continue
    const features = evaluateDepthShortBreakdown(
      { ...current, time: current.minute * 60 },
      previous10.map((bar) => ({ ...bar, time: bar.minute * 60 })),
      depthWindow.map((row) => ({ minute: row.minute, imbalance: row.imbalance, nearImbalance: row.nearImbalance })),
    )
    if (activeSignal || !features || current.minute - lastSignalMinute < DEPTH_SHORT_BREAKDOWN_RULE.cooldownMinutes) continue

    const entry = current.close
    const signal = {
      signalAt: fmt((current.minute + 1) * 60_000), symbol, pattern: features.pattern,
      entry: Number(entry.toFixed(2)), prior5mLow: Number(features.priorLow.toFixed(2)),
      breakoutPct: Number(features.breakoutPct.toFixed(3)), volumeX: Number(features.volumeMultiple.toFixed(2)),
      closeLocation: Number(features.closeLocation.toFixed(2)),
      depthFull: Number(features.depthImbalance.toFixed(3)), depthTop2: Number(features.top2Imbalance.toFixed(3)),
      indicators: candleFeatures(candles, i, current, depth),
      target: Number((entry * (1 - targetPct / 100)).toFixed(2)),
      stop: Number((entry * (1 + stopPct / 100)).toFixed(2)),
      outcome: "open at capture end", outcomeBar: "—",
    }
    signals.push(signal)
    activeSignal = signal
    lastSignalMinute = current.minute
  }
}

signals.sort((a, b) => a.signalAt.localeCompare(b.signalAt) || a.symbol.localeCompare(b.symbol))
if (outputJson) {
  console.log(JSON.stringify(signals))
  process.exit(0)
}
console.log(`Exploratory chronological short depth + candle scan | ${date} | ${stockDirs.length} stocks`)
console.log(`Trigger uses only completed candles and prior depth: bearish close below prior 5-bar low by ${minBreakoutPct}-${maxBreakoutPct}%, close in bottom 30%, volume ≥${minVolumeMultiple}× prior 10-bar average, plus either full/top-2 imbalance ≤−0.20/−0.30 or ≥+0.15/+0.30 (price breakdown despite bid-heavy book).`)
console.log(`Ex-post review target −${targetPct}%, stop +${stopPct}%; active setup blocks repeats until exit, then 10-minute cooldown. Same-candle stop/target counts as stop first.`)
console.log(`Candidates found: ${signals.length}`)
if (signals.length) {
  const outcomes = signals.reduce((counts, signal) => ({ ...counts, [signal.outcome]: (counts[signal.outcome] ?? 0) + 1 }), {})
  const byPattern = Object.fromEntries([...new Set(signals.map((signal) => signal.pattern))].map((pattern) => [
    pattern, signals.filter((signal) => signal.pattern === pattern).reduce((counts, signal) => ({ ...counts, [signal.outcome]: (counts[signal.outcome] ?? 0) + 1 }), {}),
  ]))
  const qualifying = signals.filter((signal) => signal.outcome === "TARGET first")
  console.log(`Signals reaching more than 2% down before +${stopPct}% adverse move: ${qualifying.length}`)
  const rowsToShow = showAll ? signals : qualifying
  if (rowsToShow.length) console.table(rowsToShow.map(({ symbol, signalAt, pattern, entry, target, stop, outcome, outcomeBar }) => ({
    symbol, signalAt, pattern, entry, target, stop, outcome, outcomeAt: outcomeBar,
  })))
  console.log(`Ex-post outcomes: ${JSON.stringify(outcomes)}`)
  console.log(`By pattern: ${JSON.stringify(byPattern)}`)
} else console.log("No signals met the exploratory conditions in the captured data.")
