import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { depthUpdateFields, marketDepthSession } from "../ui/market-depth.js"

const argumentsList = process.argv.slice(2)
const date = argumentsList.find((argument) => argument !== "--broad") || marketDepthSession().date
const broad = argumentsList.includes("--broad")
// The filtered cutoffs were selected on 2026-10-06. Keep --broad available
// to compare them with the original chronological candidate scan.
const minimumTrendPct = broad ? 0.5 : 0.6
const minimumVolumeRatio = broad ? 0 : 0.15
const minimumSupportImbalance = broad ? 0.25 : 0.4
const minimumLiveVolumePace = broad ? 1.5 : 1.9
const minimumReturn3Pct = broad ? -Infinity : -0.04
const maximumVolume5Ratio = broad ? Infinity : 0.95
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Pass a date as YYYY-MM-DD")
const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth", date)
const minute = 60_000
const sessionStart = Date.parse(`${date}T09:15:00+05:30`)
const sessionEnd = Date.parse(`${date}T15:15:00+05:30`)
const fmt = (at) => new Date(at + 330 * minute).toISOString().slice(11, 19)
const pct = (current, base) => base > 0 ? (current / base - 1) * 100 : NaN
const average = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length
const round = (value, places = 3) => Number(value.toFixed(places))

function readCandles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const row = JSON.parse(line)
    const at = Number(row.time) * 1000
    if (at < sessionStart || at >= sessionEnd) continue
    // A later FYERS history backfill has no recorded ingestion time. Only a
    // websocket candle proves the scanner could have seen it during the day.
    if (row.source !== "websocket") continue
    rows.set(at, { at, open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: Number(row.volume) })
  }
  return [...rows.values()].sort((a, b) => a.at - b.at)
}

function setup(candles, index) {
  if (index < 9) return null
  const last10 = candles.slice(index - 9, index + 1)
  if (last10.some((row, i) => i > 0 && row.at !== last10[i - 1].at + minute)) return null
  const base = last10.slice(-3)
  const baseHigh = Math.max(...base.map((row) => row.high))
  const baseLow = Math.min(...base.map((row) => row.low))
  const breakoutHigh = Math.max(...last10.map((row) => row.high))
  const trendPct = pct(base.at(-1).close, last10[0].open)
  const return3Pct = pct(base.at(-1).close, base[0].open)
  const baseRangePct = pct(baseHigh, baseLow)
  const volumeRatio = average(base.slice(-2), "volume") / average(last10.slice(-8, -3), "volume")
  const volume5Ratio = average(last10.slice(-5), "volume") / average(last10.slice(0, 5), "volume")
  if (trendPct < minimumTrendPct || trendPct > 4 || return3Pct < minimumReturn3Pct || baseRangePct > 0.6 ||
      volumeRatio > 0.85 || volumeRatio < minimumVolumeRatio ||
      volume5Ratio > maximumVolume5Ratio ||
      baseHigh < breakoutHigh * 0.997) return null
  return { trendPct, return3Pct, baseRangePct, volumeRatio, volume5Ratio, baseHigh, baseLow,
    breakoutHigh, baseVolume: average(base, "volume"), candleAt: base.at(-1).at }
}

function bookMetrics(fields) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const bidSize = Number(fields[`bid_size${level}`])
    const askSize = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    bids.push(bidSize)
    asks.push(askSize)
  }
  const bidSum = bids.reduce((sum, value) => sum + value, 0)
  const askSum = asks.reduce((sum, value) => sum + value, 0)
  return { bid: Number(fields.bid_price1), ask: Number(fields.ask_price1),
    bid1: bids[0], ask1: asks[0], full: (bidSum - askSum) / (bidSum + askSum || 1) }
}

async function scanStock(symbol) {
  const candles = readCandles(symbol)
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { signals: [], candles: candles.length, ticks: 0 }
  const input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  const buckets = new Map()
  const signals = []
  let fields = {}, previous = null, currentMinute = -1, baselineVolume = null
  let candleIndex = -1, cachedSetupKey = "", cachedSetup = null
  let lastSignalAt = -Infinity, lastTickAt = null, ticks = 0
  for await (const line of input) {
    if (!line) continue
    const row = JSON.parse(line)
    const at = Date.parse(row.receivedAt)
    if (at < sessionStart || !Number.isFinite(at)) continue
    if (at >= sessionEnd) { input.close(); break }
    if (lastTickAt != null && at < lastTickAt) continue
    if (previous && at - previous.at > 90_000) { fields = {}; previous = null }
    const update = depthUpdateFields(row.data)
    if (!update) continue
    for (const [key, value] of update) fields[key] = value
    const book = bookMetrics(fields)
    if (!book) continue
    ticks++
    const depthMinute = Math.floor(at / minute) * minute
    if (depthMinute !== currentMinute) {
      baselineVolume = lastTickAt != null && depthMinute - lastTickAt <= 30_000
        ? previous?.volume : null
      currentMinute = depthMinute
      for (const key of buckets.keys()) if (key < depthMinute - 4 * minute) buckets.delete(key)
    }
    const ofi = previous ? (book.bid >= previous.bid ? book.bid1 : 0) -
      (book.bid <= previous.bid ? previous.bid1 : 0) -
      (book.ask <= previous.ask ? book.ask1 : 0) +
      (book.ask >= previous.ask ? previous.ask1 : 0) : 0
    const ofiDepth = previous ? (book.bid1 + book.ask1 + previous.bid1 + previous.ask1) / 2 : 0
    const bucket = buckets.get(depthMinute) || { count: 0, full: 0, positive: 0, ofi: 0, ofiDepth: 0 }
    bucket.count++
    bucket.full += book.full
    bucket.positive += book.full > 0 ? 1 : 0
    bucket.ofi += ofi
    bucket.ofiDepth += ofiDepth
    buckets.set(depthMinute, bucket)
    previous = { ...book, at, volume: Number(row.marketContext?.cumulativeVolume) }
    lastTickAt = at

    while (candleIndex + 1 < candles.length && candles[candleIndex + 1].at + minute + 2000 <= at) candleIndex++
    const setupKey = `${depthMinute}:${candleIndex}`
    if (setupKey !== cachedSetupKey) {
      cachedSetupKey = setupKey
      cachedSetup = setup(candles, candleIndex)
    }
    if (!cachedSetup || at - (cachedSetup.candleAt + minute) > 2 * minute ||
        at - lastSignalAt < 30 * minute || bucket.count < 3 ||
        at - depthMinute < 15_000 || book.bid <= cachedSetup.breakoutHigh) continue
    const price = Number(row.marketContext?.price)
    const priceAt = Date.parse(row.marketContext?.priceAt)
    const volume = Number(row.marketContext?.cumulativeVolume)
    if (!Number.isFinite(priceAt) || at - priceAt > 5000 || price <= cachedSetup.breakoutHigh ||
        !Number.isFinite(volume) || !Number.isFinite(baselineVolume) || volume < baselineVolume) continue
    const flow = bucket.ofi / (bucket.ofiDepth || 1)
    const volumePace = ((volume - baselineVolume) * minute / (at - depthMinute)) / cachedSetup.baseVolume
    const spreadPct = pct(book.ask, book.bid)
    const extensionPct = pct(book.ask, cachedSetup.breakoutHigh)
    if (flow <= 0.1 || volumePace < minimumLiveVolumePace || spreadPct > 0.15 || extensionPct > 0.3) continue
    const support = []
    for (let offset = 3; offset >= 1; offset--) {
      const minuteAt = depthMinute - offset * minute
      const prior = buckets.get(minuteAt)
      if (prior?.count >= 3 && prior.full / prior.count >= minimumSupportImbalance &&
          prior.positive / prior.count >= 0.75) {
        support.push({ minuteAt, full: prior.full / prior.count, positivePct: 100 * prior.positive / prior.count })
      }
    }
    if (!support.length) continue
    const strongest = support.sort((a, b) => b.full - a.full)[0]
    signals.push({ symbol, signalAt: new Date(at).toISOString(), ist: fmt(at), entryAsk: round(book.ask, 2),
      breakoutHigh: cachedSetup.breakoutHigh, supportAt: fmt(strongest.minuteAt).slice(0, 5),
      supportFull: round(strongest.full), trendPct: round(cachedSetup.trendPct),
      return3Pct: round(cachedSetup.return3Pct),
      baseRangePct: round(cachedSetup.baseRangePct), volumeRatio: round(cachedSetup.volumeRatio),
      volume5Ratio: round(cachedSetup.volume5Ratio),
      liveFlow: round(flow), liveVolumePace: round(volumePace), spreadPct: round(spreadPct),
      extensionPct: round(extensionPct) })
    lastSignalAt = at
  }
  return { signals, candles: candles.length, ticks, lastTickAt }
}

function followThrough(signal) {
  const file = path.join(root, "db", "candles", `${signal.symbol}.jsonl`)
  const after = Math.floor(Date.parse(signal.signalAt) / minute) * minute + minute
  const bars = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const candle = JSON.parse(line)
    const at = Number(candle.time) * 1000
    if (at >= after && at < sessionEnd) bars.set(at, candle)
  }
  let high = -Infinity, result1 = "Unresolved", result3 = "Unresolved"
  for (const [at, candle] of [...bars].sort(([left], [right]) => left - right)) {
    high = Math.max(high, Number(candle.high))
    const stop = Number(candle.low) <= signal.entryAsk * 0.995
    if (result1 === "Unresolved") {
      if (stop) result1 = `Stopped ${fmt(at).slice(0, 5)}`
      else if (Number(candle.high) >= signal.entryAsk * 1.01) result1 = `+1% ${fmt(at).slice(0, 5)}`
    }
    if (result3 === "Unresolved") {
      if (stop) result3 = `Stopped ${fmt(at).slice(0, 5)}`
      else if (Number(candle.high) >= signal.entryAsk * 1.03) result3 = `+3% ${fmt(at).slice(0, 5)}`
    }
  }
  return { bestLaterPct: Number.isFinite(high) ? round(pct(high, signal.entryAsk), 2) : null,
    result1, result3, lastCandleAt: bars.size ? Math.max(...bars.keys()) : null }
}

const symbols = fs.readdirSync(depthRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
const signals = []
let tickCount = 0, completeCandleStocks = 0, lastTickAt = 0
for (const symbol of symbols) {
  const result = await scanStock(symbol)
  signals.push(...result.signals)
  tickCount += result.ticks
  if (result.candles >= 10) completeCandleStocks++
  lastTickAt = Math.max(lastTickAt, result.lastTickAt || 0)
}
signals.sort((a, b) => a.signalAt.localeCompare(b.signalAt) || a.symbol.localeCompare(b.symbol))
const scored = signals.map((signal) => ({ ...signal, ...followThrough(signal) }))
console.log(`${date}: ${symbols.length} stocks, ${completeCandleStocks} with 10+ websocket candles, ${tickCount} depth ticks`)
console.log(`Latest recorded depth: ${lastTickAt ? `${new Date(lastTickAt).toISOString()} (${fmt(lastTickAt)} IST)` : "none"}`)
console.log(`Latest post-signal candle: ${scored.length ? fmt(Math.max(...scored.map((row) => row.lastCandleAt || 0))) : "none"} IST`)
console.log(`${signals.length} chronological BUY signals (${broad ? "broad baseline" : "filtered"}); 30-minute cooldown per stock`)
console.log("Follow-through uses candles after the signal minute: +1%/+3% targets, -0.5% stop, stop first if both touch in one candle")
console.table(scored.map(({ symbol, ist, entryAsk, breakoutHigh, supportAt, supportFull,
  trendPct, return3Pct, baseRangePct, volumeRatio, volume5Ratio, liveFlow, liveVolumePace, bestLaterPct, result1, result3 }) =>
  ({ symbol, ist, entryAsk, breakoutHigh, supportAt, supportFull, trendPct,
    return3Pct, baseRangePct, volumeRatio, volume5Ratio, liveFlow, liveVolumePace, bestLaterPct, result1, result3 })))
console.log("+1% outcome:", {
  target: scored.filter((row) => row.result1.startsWith("+1%")).length,
  stopped: scored.filter((row) => row.result1.startsWith("Stopped")).length,
  unresolved: scored.filter((row) => row.result1 === "Unresolved").length,
})
