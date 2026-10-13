import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const MINUTE = 60_000
const date = process.argv[2] || new Date(Date.now() + 330 * MINUTE).toISOString().slice(0, 10)
const startTime = process.argv[3] || "09:17"
const throughTime = process.argv[4] || "09:30"
const start = Date.parse(`${date}T${startTime}:00+05:30`)
const through = Date.parse(`${date}T${throughTime}:00+05:30`)
const end = through + MINUTE
if (!Number.isFinite(start) || !Number.isFinite(through) || through < start) {
  throw new Error("Usage: node scripts/rank-opening-minute-depth-footprint.js YYYY-MM-DD HH:MM HH:MM")
}
const parseFrom = start - 90_000
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function parseLines(filename, timeFilter = null) {
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    if (timeFilter) {
      const match = line.match(/"receivedAt":"([^"]+)"/)
      if (!match) return []
      const at = Date.parse(match[1])
      if (!Number.isFinite(at) || at < timeFilter.from || at >= timeFilter.to) return []
    }
    try { return [JSON.parse(line)] } catch { return [] }
  })
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
  return { bestBid: bids[0].price, bestAsk: asks[0].price, bid1: bids[0].size,
    ask1: asks[0].size, bidShare: 100 * bidSize / (bidSize + askSize), dominant,
    dominantLevels: dominant.filter(Boolean).length, maxRun }
}

function scoreMinute(bucket, candle) {
  const samples = bucket.samples
  if (samples.length < 5) return null
  const range = candle.high - candle.low
  const returnPct = pct(candle.close, candle.open)
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
    0.30 * clamp(averageDominantLevels / 3) + 0.20 * clamp((averageBidShare - 50) / 15))
  const deltaUpScore = estimatedDeltaPct > 0 && returnPct > 0
    ? 100 * (0.40 * clamp(estimatedDeltaPct / 40) + 0.25 * clamp(normalizedOfi / 0.35) +
      0.35 * clamp(returnPct / 0.25)) : 0
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
  const absorptionScore = 100 * (0.30 * clamp(sellingShare / 0.50) + 0.35 * closeLocation +
    0.20 * clamp((postLowBidShare - 45) / 20) + 0.15 * clamp((postLowOfi + 0.05) / 0.40))
  const progress = clamp(returnPct / 0.25)
  const distributedScore = 100 * (0.60 * clamp(averageLevelSupport / 0.60) +
    0.40 * clamp(supportedLevels / 5)) * (0.60 + 0.40 * progress)
  return {
    minute: bucket.minute, score: mean([stackedScore, deltaUpScore, closeNearHighScore,
      absorptionScore, distributedScore]),
    stackedScore, deltaUpScore, closeNearHighScore, absorptionScore, distributedScore,
    averageBidShare, estimatedDeltaPct, normalizedOfi, returnPct, volume: candle.volume,
  }
}

function analyze(symbol) {
  const depthFile = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const candleFile = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(depthFile) || !fs.existsSync(candleFile)) return null
  const candleMap = new Map(parseLines(candleFile).flatMap((row) => {
    const at = Number(row.time) * 1000
    if (!Number.isFinite(at) || at < start || at >= end || row.partial) return []
    const candle = { open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) }
    return Object.values(candle).every(Number.isFinite)
      ? [[Math.floor(at / MINUTE) * MINUTE, candle]] : []
  }))
  const buckets = new Map()
  let previous = null
  let lastTradeDirection = 0
  for (const record of parseLines(depthFile, { from: parseFrom, to: end })) {
    const at = Date.parse(record.receivedAt)
    const currentBook = book(record.data)
    const price = Number(record.marketContext?.price)
    const volume = Number(record.marketContext?.cumulativeVolume)
    if (!Number.isFinite(at) || !currentBook || !(price > 0) || !Number.isFinite(volume)) continue
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
      tradedVolume = Math.max(0, volume - previous.volume)
      if (price > previous.price) lastTradeDirection = 1
      else if (price < previous.price) lastTradeDirection = -1
      signedVolume = tradedVolume * lastTradeDirection
    }
    if (at >= start) {
      const minute = Math.floor(at / MINUTE) * MINUTE
      const bucket = buckets.get(minute) || { minute, samples: [], tradedVolume: 0, signedVolume: 0 }
      bucket.samples.push({ at, price, book: currentBook, normalizedOfi, signedVolume })
      bucket.tradedVolume += tradedVolume
      bucket.signedVolume += signedVolume
      buckets.set(minute, bucket)
    }
    previous = { at, price, volume, book: currentBook }
  }
  const minutes = [...buckets.values()].flatMap((bucket) => {
    const candle = candleMap.get(bucket.minute)
    const score = candle ? scoreMinute(bucket, candle) : null
    return score ? [score] : []
  })
  if (minutes.length < 10) return null
  const peak = minutes.reduce((best, row) => row.score > best.score ? row : best)
  return {
    symbol, score: mean(minutes.map((row) => row.score)), minutes: minutes.length,
    stackedScore: mean(minutes.map((row) => row.stackedScore)),
    deltaUpScore: mean(minutes.map((row) => row.deltaUpScore)),
    closeNearHighScore: mean(minutes.map((row) => row.closeNearHighScore)),
    absorptionScore: mean(minutes.map((row) => row.absorptionScore)),
    distributedScore: mean(minutes.map((row) => row.distributedScore)),
    averageBidSharePct: mean(minutes.map((row) => row.averageBidShare)),
    estimatedDeltaPct: mean(minutes.map((row) => row.estimatedDeltaPct)),
    normalizedOfi: mean(minutes.map((row) => row.normalizedOfi)),
    windowReturnPct: pct(candleMap.get(end - MINUTE)?.close, candleMap.get(start)?.open),
    totalVolume: minutes.reduce((sum, row) => sum + row.volume, 0),
    peakMinute: indiaTime(peak.minute), peakScore: peak.score,
  }
}

const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const results = stocks.map(analyze).filter(Boolean).sort((left, right) => right.score - left.score)
const outputRows = results.map((row, index) => ({ rank: index + 1, symbol: row.symbol,
  score: round(row.score), minutes: row.minutes, stackedScore: round(row.stackedScore),
  deltaUpScore: round(row.deltaUpScore), closeNearHighScore: round(row.closeNearHighScore),
  absorptionScore: round(row.absorptionScore), distributedScore: round(row.distributedScore),
  averageBidSharePct: round(row.averageBidSharePct), estimatedDeltaPct: round(row.estimatedDeltaPct),
  normalizedOfi: round(row.normalizedOfi, 4), windowReturnPct: round(row.windowReturnPct),
  totalVolume: row.totalVolume, peakMinute: row.peakMinute, peakScore: round(row.peakScore),
  bullishEligible: row.windowReturnPct > 0 && row.estimatedDeltaPct > 0 && row.averageBidSharePct > 50,
  bullishRank: null }))
const bullishRows = outputRows.filter((row) => row.bullishEligible)
bullishRows.forEach((row, index) => { row.bullishRank = index + 1 })
const percentile = (value, values) => values.length < 2
  ? 100
  : 100 * values.filter((candidate) => candidate < value).length / (values.length - 1)
const bullishScores = bullishRows.map((row) => row.score)
const bullishDeltas = bullishRows.map((row) => row.estimatedDeltaPct)
for (const row of outputRows) {
  row.combinedScore = row.bullishEligible
    ? round((percentile(row.score, bullishScores) + percentile(row.estimatedDeltaPct, bullishDeltas)) / 2)
    : null
  row.combinedRank = null
}
const combinedRows = bullishRows.slice().sort((left, right) => right.combinedScore - left.combinedScore)
combinedRows.forEach((row, index) => { row.combinedRank = index + 1 })
const columns = Object.keys(outputRows[0] || {})
const csv = [columns.join(","), ...outputRows.map((row) => columns.map((column) => row[column]).join(","))]
const timeSlug = (value) => value.replace(":", "")
const output = path.join(ROOT, "csv", `${date}-${timeSlug(startTime)}-to-${timeSlug(throughTime)}-all-stock-minute-depth-footprint.csv`)
fs.writeFileSync(output, `${csv.join("\n")}\n`)
console.log(JSON.stringify({ date, requestedStocks: stocks.length, stocksScored: outputRows.length,
  bullishEligible: bullishRows.length,
  scoring: `equal-weight mean of five per-minute footprint proxies; stock score is the mean of valid ${startTime}-${throughTime} minute scores; minimum 10 minutes; bullish ranking requires positive window return, positive estimated delta, and average bid share above 50%`,
  combinedRanking: "50% footprint-score percentile plus 50% estimated-delta percentile among bullish-eligible stocks",
  output, top5: combinedRows.slice(0, 5) }, null, 2))
