import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readdir } from "node:fs/promises"
import { DEPTH_CONTINUATION_RULE, DEPTH_CONTINUATION_SHORT_RULE, DEPTH_MOMENTUM_RULE, evaluateDepthContinuation, evaluateDepthContinuationShort, evaluateDepthMomentum } from "../ui/depth-momentum.js"

const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth")
const candleRoot = path.join(root, "db", "candles")
const reviewOutcomes = process.argv.includes("--review")
const continuationMode = process.argv.includes("--continuation")
const shortMode = process.argv.includes("--short")
if (shortMode && !continuationMode) throw new Error("--short requires --continuation")
const cliArgs = process.argv.slice(2).filter((arg) => !["--review", "--continuation", "--short"].includes(arg))
const rule = shortMode ? DEPTH_CONTINUATION_SHORT_RULE : continuationMode ? DEPTH_CONTINUATION_RULE : DEPTH_MOMENTUM_RULE
const evaluate = shortMode ? evaluateDepthContinuationShort : continuationMode ? evaluateDepthContinuation : evaluateDepthMomentum
const strategyName = shortMode ? "Depth-Supported Sell Continuation" : continuationMode ? "Depth-Supported Continuation" : "Depth + Candle Momentum"
const targetPct = Number(cliArgs[0] ?? (continuationMode ? 1.51 : 2.01))
const stopPct = Number(cliArgs[1] ?? 0.5)
const symbolFilter = String(cliArgs[2] ?? "").toUpperCase()
if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct > 20 || !Number.isFinite(stopPct) || stopPct <= 0 || stopPct > 10) {
  throw new Error("Usage: npm run scan:depth:momentum -- [target-percent] [stop-percent=0.5] [symbol] [--continuation] [--short] [--review]")
}

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

async function readDepth(symbol, filename) {
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
  if (symbolFilter && symbol !== symbolFilter) continue
  const depthFile = path.join(dateDir, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(depthFile)) continue
  const [depth, candlesByMinute] = await Promise.all([readDepth(symbol, depthFile), readCandles(symbol)])
  const candles = [...candlesByMinute.values()].sort((a, b) => a.minute - b.minute)
  let lastSignalAt = -Infinity
  let activeSignal = null
  for (let i = 10; i < candles.length; i++) {
    const current = candles[i]
    if (activeSignal) {
      const stopHit = shortMode ? current.high >= activeSignal.stop : current.low <= activeSignal.stop
      const targetHit = shortMode ? current.low <= activeSignal.target : current.high >= activeSignal.target
      if (stopHit || targetHit) {
        activeSignal.outcome = stopHit ? "STOP first" : "TARGET first"
        activeSignal.outcomeBar = fmt(current.minute * 60_000)
        activeSignal = null
      }
    }
    const previous10 = candles.slice(i - 10, i)
    if (previous10.some((bar, j) => j > 0 && bar.minute !== previous10[j - 1].minute + 1) || current.minute !== previous10.at(-1).minute + 1) continue
    const depthWindow = [current.minute - 2, current.minute - 1, current.minute].map((minute) => depth.get(minute))
    if (depthWindow.some((row) => !row)) continue
    const features = evaluate(
      { ...current, time: current.minute * 60 },
      previous10.map((bar) => ({ ...bar, time: bar.minute * 60 })),
      depthWindow.map((row, index) => ({ minute: current.minute - 2 + index, imbalance: row.imbalance, nearImbalance: row.nearImbalance })),
    )
    if (activeSignal || !features || current.minute - lastSignalAt < rule.cooldownMinutes) continue
    lastSignalAt = current.minute
    const entry = current.close
    const stop = entry * (1 + (shortMode ? stopPct : -stopPct) / 100)
    const target = entry * (1 + (shortMode ? -targetPct : targetPct) / 100)
    const signal = {
      signalAt: fmt((current.minute + 1) * 60_000), symbol, entry: Number(entry.toFixed(2)),
      ...(shortMode ? { prior5mLow: Number(features.priorLow.toFixed(2)) } : { prior5mHigh: Number(features.priorHigh.toFixed(2)) }),
      breakoutPct: Number(features.breakoutPct.toFixed(2)),
      volumeX: Number(features.volumeMultiple.toFixed(2)), closeLocation: Number(features.closeLocation.toFixed(2)),
      depthImbalance: Number(features.depthImbalance.toFixed(2)), top2Imbalance: Number(features.top2Imbalance.toFixed(2)),
      stop: Number(stop.toFixed(2)), target: Number(target.toFixed(2)), outcome: "open at capture end", outcomeBar: "—",
    }
    signals.push(signal)
    activeSignal = signal
  }
}

signals.sort((a, b) => a.signalAt.localeCompare(b.signalAt) || a.symbol.localeCompare(b.symbol))
console.log(`Chronological ${strategyName} scan | ${date} | ${symbolFilter || stockDirs.length} stocks`)
const breakoutRuleText = shortMode
  ? `${rule.minimumBreakoutPct}%-${rule.maximumBreakoutPct}%`
  : continuationMode
  ? `by ${rule.minimumBreakoutPct}%-${rule.maximumBreakoutPct}%`
  : `no more than ${rule.maximumBreakoutPct}%; if below ${rule.shallowBreakoutPct}%, top-2 imbalance must be ≥${rule.minimumShallowBreakoutTop2Imbalance}`
const closeBandPct = Math.round((shortMode ? rule.minimumCloseLocation : 1 - rule.minimumCloseLocation) * 100)
console.log(`Signal rule (all known at candle close): ${shortMode ? `close below prior 5-bar low by ${breakoutRuleText} and below open` : `close above prior 5-bar high ${breakoutRuleText} and above open`}; volume ≥${rule.minimumVolumeMultiple}× prior 10-bar average and ≥${rule.minimumVolume.toLocaleString("en-IN")}; close in ${shortMode ? "bottom" : "top"} ${closeBandPct}% of candle; 3-minute ${shortMode ? "sell-side" : "buy-side"} full-depth and top-2 imbalance averages ≥${rule.minimumDepthImbalance}/${rule.minimumTop2Imbalance}.`)
console.log(`Signals are listed at the candle close in chronological order. Rule inputs use only that candle and earlier data; no repeat entry while a signal is active, then ${rule.cooldownMinutes}-minute cooldown.`)
console.log(`Candidates found: ${signals.length}`)
if (signals.length) {
  const rows = reviewOutcomes ? signals : signals.map(({ outcome, outcomeBar, ...signal }) => signal)
  console.table(rows)
  if (reviewOutcomes) {
    console.log(`Ex-post outcomes (not part of signal rules): target ${shortMode ? "−" : "+"}${targetPct}%, stop ${shortMode ? "+" : "−"}${stopPct}%; a same-bar stop/target counts as stop first.`)
    const outcomes = signals.reduce((counts, signal) => ({ ...counts, [signal.outcome]: (counts[signal.outcome] ?? 0) + 1 }), {})
    console.log(JSON.stringify(outcomes))
    console.log(`Target-first signals: ${signals.filter((signal) => signal.outcome === "TARGET first").map((signal) => `${signal.signalAt} ${signal.symbol} +${targetPct}% target`).join(", ") || "none"}`)
  }
}
else console.log("No signals met all conditions in the captured data.")
