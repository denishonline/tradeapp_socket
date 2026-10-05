import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readdir } from "node:fs/promises"

const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth")
const candleRoot = path.join(root, "db", "candles")
const targetPct = Number(process.argv[2] ?? 2.01)
const stopPct = 0.5
const showAll = process.argv.includes("--all")
const outputJson = process.argv.includes("--json")
if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct > 20) throw new Error("Usage: node scripts/scan-long-depth-absorption.js [target-percent=2.01] [--all]")
const minBreakoutPct = 0.05
const maxBreakoutPct = 0.15
const minVolumeX10 = 1
const minVolumeX5 = 1.5
const maxDepthFull = 0
const maxDepthTop2 = -0.25

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
  if (bid + ask === 0 || nearBid + nearAsk === 0 || bidPrices[0] >= askPrices[0]) return null
  return { full: (bid - ask) / (bid + ask), top2: (nearBid - nearAsk) / (nearBid + nearAsk) }
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
    const row = byMinute.get(minute) ?? { minute, count: 0, full: 0, top2: 0 }
    row.count++
    row.full += metrics.full
    row.top2 += metrics.top2
    byMinute.set(minute, row)
  }
  for (const row of byMinute.values()) {
    row.full /= row.count
    row.top2 /= row.count
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

function priorFeatures(candles, index, current, depth) {
  const features = {}
  for (const period of [5, 10, 20, 30, 50]) {
    const start = index - period
    const bars = candles.slice(start, index + 1)
    const contiguous = start >= 0 && bars.length === period + 1 && bars.every((bar, offset) =>
      offset === 0 || bar.minute === bars[offset - 1].minute + 1)
    features[`return${period}`] = contiguous ? (current.close / bars[0].close - 1) * 100 : null
  }
  for (const period of [20, 50]) {
    const bars = candles.slice(index - period + 1, index + 1)
    const contiguous = bars.length === period && bars.every((bar, offset) =>
      offset === 0 || bar.minute === bars[offset - 1].minute + 1)
    const sma = contiguous ? bars.reduce((sum, bar) => sum + bar.close, 0) / period : null
    features[`sma${period}Gap`] = sma ? (current.close / sma - 1) * 100 : null
  }
  const last21 = candles.slice(index - 20, index + 1)
  const contiguous21 = last21.length === 21 && last21.every((bar, offset) =>
    offset === 0 || bar.minute === last21[offset - 1].minute + 1)
  if (contiguous21) {
    const moves = last21.slice(1).map((bar, offset) => bar.close - last21[offset].close)
    features.trendEfficiency20 = moves.reduce((sum, move) => sum + move, 0) /
      (moves.reduce((sum, move) => sum + Math.abs(move), 0) || 1)
  } else features.trendEfficiency20 = null
  for (const period of [10, 20]) {
    const bars = candles.slice(index - period + 1, index + 1)
    features[`greenBars${period}`] = bars.length === period ? bars.filter((bar) => bar.close > bar.open).length : null
  }
  const prior10 = candles.slice(index - 10, index)
  const vol10 = prior10.length === 10 ? prior10.reduce((sum, bar) => sum + bar.volume, 0) / 10 : 0
  const vol3 = candles.slice(index - 3, index).reduce((sum, bar) => sum + bar.volume, 0) / 3
  features.prior3VolumeX10 = vol10 > 0 ? vol3 / vol10 : null
  for (const period of [5, 10]) {
    const rows = Array.from({ length: period }, (_, offset) => depth.get(current.minute - offset))
    features[`depth${period}Full`] = rows.every(Boolean) ? rows.reduce((sum, row) => sum + row.full, 0) / period : null
    features[`depth${period}Top2`] = rows.every(Boolean) ? rows.reduce((sum, row) => sum + row.top2, 0) / period : null
  }
  return Object.fromEntries(Object.entries(features).map(([key, value]) => [key, value == null ? null : Number(value.toFixed(4))]))
}

const signals = []
for (const dir of stockDirs) {
  const symbol = dir.name
  const depthFile = path.join(dateDir, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(depthFile)) continue
  const [depth, candleMap] = await Promise.all([readDepth(depthFile), readCandles(symbol)])
  const candles = [...candleMap.values()].sort((a, b) => a.minute - b.minute)
  let active = null, lastSignalMinute = -Infinity
  for (let i = 10; i < candles.length; i++) {
    const current = candles[i]
    if (active) {
      const stopHit = current.low <= active.stop
      const targetHit = current.high >= active.target
      if (stopHit || targetHit) {
        active.outcome = stopHit ? "STOP first" : "TARGET first"
        active.outcomeAt = fmt(current.minute * 60_000)
        active = null
      }
    }
    const previous10 = candles.slice(i - 10, i)
    if (previous10.some((bar, j) => j > 0 && bar.minute !== previous10[j - 1].minute + 1) || current.minute !== previous10.at(-1).minute + 1) continue
    const depthWindow = [current.minute - 2, current.minute - 1, current.minute].map((minute) => depth.get(minute))
    if (depthWindow.some((row) => !row)) continue
    const previous5 = previous10.slice(-5)
    const priorHigh = Math.max(...previous5.map((bar) => bar.high))
    const breakoutPct = (current.close / priorHigh - 1) * 100
    const closeLocation = (current.close - current.low) / (current.high - current.low || 1)
    const avgVol10 = previous10.reduce((sum, bar) => sum + bar.volume, 0) / previous10.length
    const avgVol5 = previous5.reduce((sum, bar) => sum + bar.volume, 0) / previous5.length
    const volumeX10 = avgVol10 > 0 ? current.volume / avgVol10 : 0
    const volumeX5 = avgVol5 > 0 ? current.volume / avgVol5 : 0
    const depthFull = depthWindow.reduce((sum, row) => sum + row.full, 0) / depthWindow.length
    const depthTop2 = depthWindow.reduce((sum, row) => sum + row.top2, 0) / depthWindow.length
    if (active || current.close <= current.open || breakoutPct < minBreakoutPct || breakoutPct > maxBreakoutPct ||
        closeLocation < 0.7 || volumeX10 < minVolumeX10 || volumeX5 < minVolumeX5 ||
        depthFull > maxDepthFull || depthTop2 > maxDepthTop2 || current.minute - lastSignalMinute < 10) continue

    const entry = current.close
    const signal = {
      signalAt: fmt((current.minute + 1) * 60_000), symbol,
      entry: Number(entry.toFixed(2)), target: Number((entry * (1 + targetPct / 100)).toFixed(2)),
      stop: Number((entry * (1 - stopPct / 100)).toFixed(2)),
      breakoutPct: Number(breakoutPct.toFixed(3)), closeLocation: Number(closeLocation.toFixed(2)),
      volumeX10: Number(volumeX10.toFixed(2)), volumeX5: Number(volumeX5.toFixed(2)),
      depthFull: Number(depthFull.toFixed(3)), depthTop2: Number(depthTop2.toFixed(3)),
      indicators: priorFeatures(candles, i, current, depth),
      outcome: "open at capture end", outcomeAt: "—",
    }
    signals.push(signal)
    active = signal
    lastSignalMinute = current.minute
  }
}

signals.sort((a, b) => a.signalAt.localeCompare(b.signalAt) || a.symbol.localeCompare(b.symbol))
if (outputJson) {
  console.log(JSON.stringify(signals))
  process.exit(0)
}
const outcomes = signals.reduce((counts, signal) => ({ ...counts, [signal.outcome]: (counts[signal.outcome] ?? 0) + 1 }), {})
const winners = signals.filter((signal) => signal.outcome === "TARGET first")
console.log(`Exploratory long absorption breakout | ${date} | ${stockDirs.length} stocks`)
console.log(`Rule: 0.05-0.15% close above prior 5-bar high; close in top 30%; volume >=1x prior 10 and >=1.5x prior 5; 3-minute full-depth imbalance <=0 and top-2 <=-0.25.`)
console.log(`Outcomes with +${targetPct}% target / -${stopPct}% stop (same-bar collision = stop first): ${JSON.stringify(outcomes)}`)
console.log(`Target-first signals: ${winners.length}`)
const rowsToShow = showAll ? signals : winners
if (rowsToShow.length) console.table(rowsToShow.map(({ symbol, signalAt, entry, outcome, outcomeAt, volumeX5, depthFull, depthTop2 }) => ({
  symbol, signalAt, entry, outcome, outcomeAt, volumeX5, depthFull, depthTop2,
})))
