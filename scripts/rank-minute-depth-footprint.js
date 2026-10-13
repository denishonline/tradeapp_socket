import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const MINUTE = 60_000
const symbol = String(process.argv[2] || "TATATECH").toUpperCase().replace(/-EQ$/, "")
const date = process.argv[3] || new Date(Date.now() + 330 * MINUTE).toISOString().slice(0, 10)
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function parseLines(filename) {
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function indiaDate(at) {
  return new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
}

function indiaTime(at) {
  return new Date(at + 330 * MINUTE).toISOString().slice(11, 16)
}

function book(data) {
  const bids = []
  const asks = []
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(data?.[`bid_price${level}`])
    const askPrice = Number(data?.[`ask_price${level}`])
    const bidSize = Number(data?.[`bid_size${level}`])
    const askSize = Number(data?.[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    bids.push({ price: bidPrice, size: bidSize })
    asks.push({ price: askPrice, size: askSize })
  }
  const bidSize = bids.reduce((sum, row) => sum + row.size, 0)
  const askSize = asks.reduce((sum, row) => sum + row.size, 0)
  if (!(bidSize + askSize > 0)) return null
  const dominant = bids.map((bid, index) => bid.size >= 5 && bid.size >= 1.5 * Math.max(1, asks[index].size))
  let run = 0
  let maxRun = 0
  for (const value of dominant) {
    run = value ? run + 1 : 0
    maxRun = Math.max(maxRun, run)
  }
  return {
    bids, asks, bestBid: bids[0].price, bestAsk: asks[0].price,
    bid1: bids[0].size, ask1: asks[0].size, bidSize, askSize,
    bidShare: 100 * bidSize / (bidSize + askSize), dominant, dominantLevels: dominant.filter(Boolean).length,
    maxRun,
  }
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const depthFile = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
const candleFile = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
if (!fs.existsSync(depthFile)) throw new Error(`Missing depth file ${depthFile}`)
if (!fs.existsSync(candleFile)) throw new Error(`Missing candle file ${candleFile}`)

const candleMap = new Map(parseLines(candleFile).flatMap((row) => {
  const time = Number(row.time) * 1000
  if (!Number.isFinite(time) || indiaDate(time) !== date || row.partial) return []
  const candle = { time, open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume) }
  return [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
    ? [[Math.floor(time / MINUTE) * MINUTE, candle]] : []
}))

const buckets = new Map()
let previous = null
let lastTradeDirection = 0
for (const record of parseLines(depthFile)) {
  const at = Date.parse(record.receivedAt)
  if (!Number.isFinite(at) || indiaDate(at) !== date) continue
  const currentBook = book(record.data)
  if (!currentBook) continue
  const price = Number(record.marketContext?.price)
  const volume = Number(record.marketContext?.cumulativeVolume)
  if (!(price > 0) || !Number.isFinite(volume)) continue
  if (previous && at - previous.at > 90_000) previous = null
  let normalizedOfi = 0
  let signedVolume = 0
  let tradedVolume = 0
  if (previous) {
    const ofi = (currentBook.bestBid >= previous.book.bestBid ? currentBook.bid1 : 0) -
      (currentBook.bestBid <= previous.book.bestBid ? previous.book.bid1 : 0) -
      (currentBook.bestAsk <= previous.book.bestAsk ? currentBook.ask1 : 0) +
      (currentBook.bestAsk >= previous.book.bestAsk ? previous.book.ask1 : 0)
    const ofiDepth = (currentBook.bid1 + currentBook.ask1 + previous.book.bid1 + previous.book.ask1) / 2
    normalizedOfi = ofi / (ofiDepth || 1)
    const volumeDelta = Math.max(0, volume - previous.volume)
    if (price > previous.price) lastTradeDirection = 1
    else if (price < previous.price) lastTradeDirection = -1
    tradedVolume = volumeDelta
    signedVolume = volumeDelta * lastTradeDirection
  }
  const minute = Math.floor(at / MINUTE) * MINUTE
  const bucket = buckets.get(minute) || { minute, samples: [], tradedVolume: 0, signedVolume: 0 }
  bucket.samples.push({ at, price, volume, book: currentBook, normalizedOfi, signedVolume, tradedVolume })
  bucket.tradedVolume += tradedVolume
  bucket.signedVolume += signedVolume
  buckets.set(minute, bucket)
  previous = { at, price, volume, book: currentBook }
}

const scored = []
for (const bucket of buckets.values()) {
  const candle = candleMap.get(bucket.minute)
  if (!candle || bucket.samples.length < 5) continue
  const samples = bucket.samples
  const range = candle.high - candle.low
  const candleReturn = pct(candle.close, candle.open)
  const closeLocation = range > 0 ? clamp((candle.close - candle.low) / range) : 0.5
  const upperWickShare = range > 0 ? clamp((candle.high - Math.max(candle.open, candle.close)) / range) : 0.5
  const averageBidShare = mean(samples.map((sample) => sample.book.bidShare))
  const stackedTicksPct = 100 * samples.filter((sample) => sample.book.maxRun >= 3).length / samples.length
  const averageDominantLevels = mean(samples.map((sample) => sample.book.dominantLevels))
  const levelSupport = Array.from({ length: 5 }, (_, level) =>
    samples.filter((sample) => sample.book.dominant[level]).length / samples.length)
  const supportedLevels = levelSupport.filter((share) => share >= 0.35).length
  const averageLevelSupport = mean(levelSupport)
  const normalizedOfi = mean(samples.map((sample) => sample.normalizedOfi))
  const estimatedDeltaPct = bucket.tradedVolume > 0 ? 100 * bucket.signedVolume / bucket.tradedVolume : 0

  const stackedScore = 100 * (0.50 * clamp(stackedTicksPct / 40) +
    0.30 * clamp(averageDominantLevels / 3) +
    0.20 * clamp((averageBidShare - 50) / 15))

  const deltaUpScore = estimatedDeltaPct > 0 && candleReturn > 0
    ? 100 * (0.40 * clamp(estimatedDeltaPct / 40) +
      0.25 * clamp(normalizedOfi / 0.35) + 0.35 * clamp(candleReturn / 0.25)) : 0

  const closeNearHighScore = 100 * (0.70 * closeLocation + 0.30 * (1 - upperWickShare))

  let lowIndex = 0
  for (let index = 1; index < samples.length; index++) {
    if (samples[index].price < samples[lowIndex].price) lowIndex = index
  }
  const beforeLow = samples.slice(0, lowIndex + 1)
  const afterLow = samples.slice(lowIndex)
  const sellIntoLow = Math.abs(beforeLow.reduce((sum, sample) => sum + Math.min(0, sample.signedVolume), 0))
  const sellingShare = bucket.tradedVolume > 0 ? sellIntoLow / bucket.tradedVolume : 0
  const postLowBidShare = mean(afterLow.map((sample) => sample.book.bidShare))
  const postLowOfi = mean(afterLow.map((sample) => sample.normalizedOfi))
  const absorptionScore = 100 * (0.30 * clamp(sellingShare / 0.50) +
    0.35 * closeLocation + 0.20 * clamp((postLowBidShare - 45) / 20) +
    0.15 * clamp((postLowOfi + 0.05) / 0.40))

  const progress = clamp(candleReturn / 0.25)
  const distributedScore = 100 * (0.60 * clamp(averageLevelSupport / 0.60) +
    0.40 * clamp(supportedLevels / 5)) * (0.60 + 0.40 * progress)

  const score = mean([stackedScore, deltaUpScore, closeNearHighScore, absorptionScore, distributedScore])
  scored.push({
    time: indiaTime(bucket.minute), score: round(score), ticks: samples.length,
    open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    volume: candle.volume, returnPct: round(candleReturn),
    stackedScore: round(stackedScore), deltaUpScore: round(deltaUpScore),
    closeNearHighScore: round(closeNearHighScore), absorptionScore: round(absorptionScore),
    distributedScore: round(distributedScore), averageBidSharePct: round(averageBidShare),
    stackedTicksPct: round(stackedTicksPct), averageDominantLevels: round(averageDominantLevels),
    estimatedDeltaPct: round(estimatedDeltaPct), normalizedOfi: round(normalizedOfi, 4),
    closeLocationPct: round(100 * closeLocation), upperWickPct: round(100 * upperWickShare),
    sellingIntoLowPct: round(100 * sellingShare), postLowBidSharePct: round(postLowBidShare),
    supportedLevels,
  })
}

scored.sort((left, right) => right.score - left.score)
const columns = Object.keys(scored[0] || {})
const output = path.join(ROOT, "csv", `${date}-${symbol}-minute-depth-footprint.csv`)
fs.writeFileSync(output, `${[columns.join(","), ...scored.map((row) =>
  columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`)
console.log(JSON.stringify({ symbol, date, minutesScored: scored.length, output, top5: scored.slice(0, 5) }, null, 2))
