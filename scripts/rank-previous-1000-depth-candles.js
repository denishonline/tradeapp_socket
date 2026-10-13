import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { once } from "node:events"

const ROOT = process.cwd()
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const OUTPUT_ROOT = path.join(ROOT, "csv")
const MINUTE = 60_000
const SESSION_OPEN = 9 * 60 + 15
const SESSION_CLOSE = 15 * 60 + 30

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : 0
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)
const indiaDateTime = (at) => `${indiaDate(at)} ${indiaTime(at)}`
const safeStamp = (at) => `${indiaDate(at)}-${indiaTime(at).replace(":", "")}`

function argumentsFrom(commandLine) {
  const result = { cutoff: null, count: 1000, top: 10 }
  const positional = []
  for (let index = 0; index < commandLine.length; index++) {
    const value = commandLine[index]
    if (value === "--cutoff") result.cutoff = commandLine[++index]
    else if (value.startsWith("--cutoff=")) result.cutoff = value.slice("--cutoff=".length)
    else if (value === "--count") result.count = Number(commandLine[++index])
    else if (value.startsWith("--count=")) result.count = Number(value.slice("--count=".length))
    else if (value === "--top") result.top = Number(commandLine[++index])
    else if (value.startsWith("--top=")) result.top = Number(value.slice("--top=".length))
    else positional.push(value)
  }
  if (!result.cutoff && positional.length) result.cutoff = positional.join(" ")
  if (!Number.isInteger(result.count) || result.count < 1) throw new Error("--count must be a positive integer")
  if (!Number.isInteger(result.top) || result.top < 1) throw new Error("--top must be a positive integer")
  return result
}

function cutoffExclusive(raw, now = Date.now()) {
  const latestCompletedMinute = Math.floor(now / MINUTE) * MINUTE - MINUTE
  if (!raw) return latestCompletedMinute + MINUTE
  const input = String(raw).trim()
  let normalized
  if (/^\d{2}:\d{2}$/.test(input)) normalized = `${indiaDate(now)}T${input}:00+05:30`
  else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) normalized = `${input}T15:29:00+05:30`
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(input)) {
    normalized = `${input.replace(" ", "T")}${input.length === 16 ? ":00" : ""}+05:30`
  } else normalized = input
  const candleMinute = Date.parse(normalized)
  if (!Number.isFinite(candleMinute)) {
    throw new Error(`Invalid cutoff '${raw}'. Use an IST value such as 2026-10-13 10:30.`)
  }
  return Math.min(Math.floor(candleMinute / MINUTE) * MINUTE + MINUTE, latestCompletedMinute + MINUTE)
}

function availableDates() {
  if (!fs.existsSync(DEPTH_ROOT)) return []
  return fs.readdirSync(DEPTH_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name).sort()
}

function previousMarketMinutes(dates, exclusiveCutoff, count) {
  const minutes = []
  for (const date of dates) {
    const open = Date.parse(`${date}T09:15:00+05:30`)
    for (let minuteOfDay = SESSION_OPEN; minuteOfDay < SESSION_CLOSE; minuteOfDay++) {
      const at = open + (minuteOfDay - SESSION_OPEN) * MINUTE
      if (at < exclusiveCutoff) minutes.push(at)
    }
  }
  return minutes.slice(-count)
}

function book(data) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bid = { price: Number(data?.[`bid_price${level}`]), size: Number(data?.[`bid_size${level}`]) }
    const ask = { price: Number(data?.[`ask_price${level}`]), size: Number(data?.[`ask_size${level}`]) }
    if (![bid.price, bid.size, ask.price, ask.size].every(Number.isFinite) ||
        bid.price <= 0 || ask.price <= bid.price || bid.size < 0 || ask.size < 0) return null
    bids.push(bid); asks.push(ask)
  }
  const bidSize = bids.reduce((sum, row) => sum + row.size, 0)
  const askSize = asks.reduce((sum, row) => sum + row.size, 0)
  if (!(bidSize + askSize > 0)) return null
  let bidRun = 0, longestBidRun = 0, askRun = 0, longestAskRun = 0
  for (let level = 0; level < 5; level++) {
    bidRun = bids[level].size >= 5 && bids[level].size >= 1.5 * Math.max(1, asks[level].size) ? bidRun + 1 : 0
    askRun = asks[level].size >= 5 && asks[level].size >= 1.5 * Math.max(1, bids[level].size) ? askRun + 1 : 0
    longestBidRun = Math.max(longestBidRun, bidRun)
    longestAskRun = Math.max(longestAskRun, askRun)
  }
  return {
    bestBid: bids[0].price, bestAsk: asks[0].price, bid1: bids[0].size, ask1: asks[0].size,
    bidShare: 100 * bidSize / (bidSize + askSize),
    top2BidShare: 100 * (bids[0].size + bids[1].size) /
      (bids[0].size + bids[1].size + asks[0].size + asks[1].size),
    stackedBid: longestBidRun >= 3, stackedAsk: longestAskRun >= 3,
    mid: (bids[0].price + asks[0].price) / 2,
    spread: asks[0].price - bids[0].price,
  }
}

async function readBuckets(symbol, dates, wantedMinutes) {
  const buckets = new Map()
  const first = Math.min(...wantedMinutes), lastExclusive = Math.max(...wantedMinutes) + MINUTE
  const wanted = new Set(wantedMinutes)
  for (const date of dates) {
    const filename = path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)
    if (!fs.existsSync(filename)) continue
    const lines = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const at = Date.parse(row.receivedAt)
      if (!Number.isFinite(at) || at < first || at >= lastExclusive) continue
      const minute = Math.floor(at / MINUTE) * MINUTE
      if (!wanted.has(minute)) continue
      const current = book(row.data)
      const price = Number(row.marketContext?.price), volume = Number(row.marketContext?.cumulativeVolume)
      if (!current || !(price > 0) || !Number.isFinite(volume)) continue
      const bucket = buckets.get(minute) || []
      bucket.push({ at, price, volume, book: current })
      buckets.set(minute, bucket)
    }
  }
  return buckets
}

function evaluate(samples, minute) {
  const identity = { candleDate: indiaDate(minute), candleTime: indiaTime(minute) }
  if (!samples?.length) return { ...identity, bullishScore: 0, bearishScore: 0,
    updates: 0, coverageSeconds: 0,
    maximumGapSeconds: 60, dataQualityPct: 0 }
  samples.sort((a, b) => a.at - b.at)
  const gaps = samples.slice(1).map((row, index) => (row.at - samples[index].at) / 1000)
  const coverageSeconds = (samples.at(-1).at - samples[0].at) / 1000
  const maximumGapSeconds = gaps.length ? Math.max(...gaps) : 60
  const updateQuality = clamp(samples.length / 15)
  const coverageQuality = clamp(coverageSeconds / 50)
  const gapQuality = maximumGapSeconds <= 1 ? 1 : clamp((5 - maximumGapSeconds) / 4)
  const dataQuality = mean([updateQuality, coverageQuality, gapQuality])

  const segment = Math.max(1, Math.ceil(samples.length * 0.20))
  const first = samples.slice(0, segment), last = samples.slice(-segment)
  const middle = samples.slice(segment, Math.max(segment + 1, samples.length - segment))
  const finalThird = samples.slice(Math.floor(samples.length * 2 / 3))
  const startingBidShare = mean(first.map((row) => row.book.bidShare))
  const middleBidShare = mean(middle.map((row) => row.book.bidShare))
  const endingBidShare = mean(last.map((row) => row.book.bidShare))
  const endingTop2BidShare = mean(last.map((row) => row.book.top2BidShare))
  const startingAskShare = 100 - startingBidShare
  const middleAskShare = 100 - middleBidShare
  const endingAskShare = 100 - endingBidShare
  const endingTop2AskShare = 100 - endingTop2BidShare
  const bidImprovement = endingBidShare - startingBidShare
  const askImprovement = endingAskShare - startingAskShare
  const fullBidDominance = 100 * samples.filter((row) => row.book.bidShare > 50).length / samples.length
  const finalBidDominance = 100 * finalThird.filter((row) => row.book.bidShare > 50).length / finalThird.length
  const fullAskDominance = 100 * samples.filter((row) => row.book.bidShare < 50).length / samples.length
  const finalAskDominance = 100 * finalThird.filter((row) => row.book.bidShare < 50).length / finalThird.length
  const stackedBidPct = 100 * samples.filter((row) => row.book.stackedBid).length / samples.length
  const stackedAskPct = 100 * samples.filter((row) => row.book.stackedAsk).length / samples.length
  let bidControl = -1, askControl = -1
  for (let index = 0; index <= samples.length - 3; index++) {
    const window = samples.slice(index, index + 3)
    if (bidControl < 0 && window.every((row) => row.book.bidShare > 50)) bidControl = index
    if (askControl < 0 && window.every((row) => row.book.bidShare < 50)) askControl = index
    if (bidControl >= 0 && askControl >= 0) break
  }
  const afterBidControl = bidControl >= 0 ? samples.slice(bidControl) : []
  const afterAskControl = askControl >= 0 ? samples.slice(askControl) : []
  const bidPersistencePct = afterBidControl.length
    ? 100 * afterBidControl.filter((row) => row.book.bidShare > 50).length / afterBidControl.length : 0
  const askPersistencePct = afterAskControl.length
    ? 100 * afterAskControl.filter((row) => row.book.bidShare < 50).length / afterAskControl.length : 0
  const finalThreeBidShare = mean(samples.slice(-3).map((row) => row.book.bidShare))
  const finalThreeAskShare = 100 - finalThreeBidShare
  const secondHalf = samples.slice(Math.floor(samples.length / 2))
  let strongestLateThreeBid = 0, strongestLateThreeAsk = 0
  for (let index = 0; index <= secondHalf.length - 3; index++) {
    const lateBidShare = mean(secondHalf.slice(index, index + 3).map((row) => row.book.bidShare))
    strongestLateThreeBid = Math.max(strongestLateThreeBid, lateBidShare)
    strongestLateThreeAsk = Math.max(strongestLateThreeAsk, 100 - lateBidShare)
  }
  const bidDisappeared = finalThreeBidShare < 50 ||
    finalThreeBidShare < 58 && strongestLateThreeBid - finalThreeBidShare > 12
  const askDisappeared = finalThreeAskShare < 50 ||
    finalThreeAskShare < 58 && strongestLateThreeAsk - finalThreeAskShare > 12

  let tradedVolume = 0, signedVolume = 0, lastDirection = 0
  const ofis = [], bidReplenishments = [], askReplenishments = []
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], current = samples[index]
    const ofi = (current.book.bestBid >= previous.book.bestBid ? current.book.bid1 : 0) -
      (current.book.bestBid <= previous.book.bestBid ? previous.book.bid1 : 0) -
      (current.book.bestAsk <= previous.book.bestAsk ? current.book.ask1 : 0) +
      (current.book.bestAsk >= previous.book.bestAsk ? previous.book.ask1 : 0)
    const visibleDepth = (current.book.bid1 + current.book.ask1 + previous.book.bid1 + previous.book.ask1) / 2
    ofis.push(ofi / Math.max(1, visibleDepth))
    const increment = Math.max(0, current.volume - previous.volume)
    if (current.price > previous.price) lastDirection = 1
    else if (current.price < previous.price) lastDirection = -1
    tradedVolume += increment
    signedVolume += increment * lastDirection
    bidReplenishments.push(current.book.bestBid > previous.book.bestBid ||
      current.book.bestBid === previous.book.bestBid && current.book.bid1 > previous.book.bid1 ? 1 : 0)
    askReplenishments.push(current.book.bestAsk < previous.book.bestAsk ||
      current.book.bestAsk === previous.book.bestAsk && current.book.ask1 > previous.book.ask1 ? 1 : 0)
  }
  const normalizedOfi = mean(ofis)
  const estimatedDeltaPct = tradedVolume > 0 ? 100 * signedVolume / tradedVolume : 0
  const bidReplenishmentPct = 100 * mean(bidReplenishments)
  const askReplenishmentPct = 100 * mean(askReplenishments)
  const priceReturnPct = pct(samples.at(-1).price, samples[0].price)
  const midReturnPct = pct(samples.at(-1).book.mid, samples[0].book.mid)
  const bestBidProgress = samples.at(-1).book.bestBid > samples[0].book.bestBid
  const bestAskProgress = samples.at(-1).book.bestAsk < samples[0].book.bestAsk
  const startingSpread = mean(first.map((row) => row.book.spread / row.book.mid))
  const endingSpread = mean(last.map((row) => row.book.spread / row.book.mid))
  const spreadExpansionPct = startingSpread > 0 ? 100 * (endingSpread / startingSpread - 1) : 0

  const bullishPhaseScore = 5 * clamp((middleBidShare - 45) / 20) + 10 * clamp((endingBidShare - 45) / 25)
  const bullishTopTwoScore = 8 * clamp((endingTop2BidShare - 45) / 25)
  const bullishImprovementScore = 10 * clamp(bidImprovement / 20)
  const bullishDominanceScore = 3 * clamp(fullBidDominance / 70) + 5 * clamp(finalBidDominance / 80)
  const bullishPersistenceScore = 8 * clamp(bidPersistencePct / 80)
  const bullishOfiScore = 10 * clamp(normalizedOfi / 0.15)
  const bullishDeltaScore = 10 * clamp(estimatedDeltaPct / 25)
  const bullishStackedScore = 5 * clamp(stackedBidPct / 25)
  const bullishReplenishmentScore = 6 * clamp((bidReplenishmentPct - 25) / 40) + (bidDisappeared ? 0 : 2)
  const bullishPriceScore = 3 * clamp(midReturnPct / 0.20) + 2 * clamp(priceReturnPct / 0.25) +
    (bestBidProgress ? 3 : 0)
  const spreadScore = 5 * clamp((25 - spreadExpansionPct) / 25)
  const qualityScore = 5 * dataQuality
  const bullishRawScore = bullishPhaseScore + bullishTopTwoScore + bullishImprovementScore +
    bullishDominanceScore + bullishPersistenceScore + bullishOfiScore + bullishDeltaScore +
    bullishStackedScore + bullishReplenishmentScore + bullishPriceScore + spreadScore + qualityScore
  const bullishScore = clamp(bullishRawScore * (0.40 + 0.60 * dataQuality), 0, 100)

  const bearishPhaseScore = 5 * clamp((middleAskShare - 45) / 20) + 10 * clamp((endingAskShare - 45) / 25)
  const bearishTopTwoScore = 8 * clamp((endingTop2AskShare - 45) / 25)
  const bearishImprovementScore = 10 * clamp(askImprovement / 20)
  const bearishDominanceScore = 3 * clamp(fullAskDominance / 70) + 5 * clamp(finalAskDominance / 80)
  const bearishPersistenceScore = 8 * clamp(askPersistencePct / 80)
  const bearishOfiScore = 10 * clamp(-normalizedOfi / 0.15)
  const bearishDeltaScore = 10 * clamp(-estimatedDeltaPct / 25)
  const bearishStackedScore = 5 * clamp(stackedAskPct / 25)
  const bearishReplenishmentScore = 6 * clamp((askReplenishmentPct - 25) / 40) + (askDisappeared ? 0 : 2)
  const bearishPriceScore = 3 * clamp(-midReturnPct / 0.20) + 2 * clamp(-priceReturnPct / 0.25) +
    (bestAskProgress ? 3 : 0)
  const bearishRawScore = bearishPhaseScore + bearishTopTwoScore + bearishImprovementScore +
    bearishDominanceScore + bearishPersistenceScore + bearishOfiScore + bearishDeltaScore +
    bearishStackedScore + bearishReplenishmentScore + bearishPriceScore + spreadScore + qualityScore
  const bearishScore = clamp(bearishRawScore * (0.40 + 0.60 * dataQuality), 0, 100)

  return { ...identity, bullishScore: round(bullishScore), bearishScore: round(bearishScore), updates: samples.length,
    coverageSeconds: round(coverageSeconds), maximumGapSeconds: round(maximumGapSeconds),
    dataQualityPct: round(100 * dataQuality), startingBidSharePct: round(startingBidShare),
    middleBidSharePct: round(middleBidShare), endingBidSharePct: round(endingBidShare),
    startingAskSharePct: round(startingAskShare), middleAskSharePct: round(middleAskShare),
    endingAskSharePct: round(endingAskShare),
    endingTop2BidSharePct: round(endingTop2BidShare), bidShareImprovementPp: round(bidImprovement),
    endingTop2AskSharePct: round(endingTop2AskShare), askShareImprovementPp: round(askImprovement),
    bidDominantUpdatesPct: round(fullBidDominance), finalBidDominancePct: round(finalBidDominance),
    askDominantUpdatesPct: round(fullAskDominance), finalAskDominancePct: round(finalAskDominance),
    bidPersistencePct: round(bidPersistencePct), askPersistencePct: round(askPersistencePct),
    normalizedOfi: round(normalizedOfi, 4), estimatedDeltaPct: round(estimatedDeltaPct),
    stackedBidImbalancesPct: round(stackedBidPct), stackedAskImbalancesPct: round(stackedAskPct),
    bidReplenishmentPct: round(bidReplenishmentPct), askReplenishmentPct: round(askReplenishmentPct),
    bidDisappeared, askDisappeared, midPriceProgressPct: round(midReturnPct), bestBidProgress, bestAskProgress,
    lastPriceProgressPct: round(priceReturnPct), spreadExpansionPct: round(spreadExpansionPct),
    bullishPhaseScore: round(bullishPhaseScore), bullishTopTwoScore: round(bullishTopTwoScore),
    bullishImprovementScore: round(bullishImprovementScore), bullishDominanceScore: round(bullishDominanceScore),
    bullishPersistenceScore: round(bullishPersistenceScore), bullishOfiScore: round(bullishOfiScore),
    bullishDeltaScore: round(bullishDeltaScore), bullishStackedScore: round(bullishStackedScore),
    bullishReplenishmentScore: round(bullishReplenishmentScore), bullishPriceScore: round(bullishPriceScore),
    bearishPhaseScore: round(bearishPhaseScore), bearishTopTwoScore: round(bearishTopTwoScore),
    bearishImprovementScore: round(bearishImprovementScore), bearishDominanceScore: round(bearishDominanceScore),
    bearishPersistenceScore: round(bearishPersistenceScore), bearishOfiScore: round(bearishOfiScore),
    bearishDeltaScore: round(bearishDeltaScore), bearishStackedScore: round(bearishStackedScore),
    bearishReplenishmentScore: round(bearishReplenishmentScore), bearishPriceScore: round(bearishPriceScore),
    spreadScore: round(spreadScore), qualityScore: round(qualityScore) }
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
function csvRow(columns, record) {
  return `${columns.map((column) => csvValue(record[column])).join(",")}\n`
}
async function write(stream, value) {
  if (!stream.write(value)) await once(stream, "drain")
}
function writeCsv(filename, records) {
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))]
  fs.writeFileSync(filename, `${columns.join(",")}\n${records.map((row) =>
    columns.map((column) => csvValue(row[column])).join(",")).join("\n")}\n`)
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  const exclusiveCutoff = cutoffExclusive(options.cutoff)
  const dates = availableDates().filter((date) => Date.parse(`${date}T09:15:00+05:30`) < exclusiveCutoff)
  const candleMinutes = previousMarketMinutes(dates, exclusiveCutoff, options.count)
  if (!candleMinutes.length) throw new Error("No saved market minutes exist before the requested cutoff")
  const relevantDates = [...new Set(candleMinutes.map(indiaDate))]
  const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true })
  const firstMinute = candleMinutes[0], lastMinute = candleMinutes.at(-1)
  const prefix = `${safeStamp(lastMinute)}-previous-${candleMinutes.length}-depth-candles`
  const auditFile = path.join(OUTPUT_ROOT, `${prefix}-audit.csv`)
  const rankingFile = path.join(OUTPUT_ROOT, `${prefix}-ranking.csv`)
  const summaryFile = path.join(OUTPUT_ROOT, `${prefix}-summary.json`)
  const auditColumns = ["symbol", "candleDate", "candleTime", "bullishScore", "bearishScore",
    "updates", "coverageSeconds",
    "maximumGapSeconds", "dataQualityPct", "startingBidSharePct", "middleBidSharePct",
    "endingBidSharePct", "startingAskSharePct", "middleAskSharePct", "endingAskSharePct",
    "endingTop2BidSharePct", "endingTop2AskSharePct", "bidShareImprovementPp", "askShareImprovementPp",
    "bidDominantUpdatesPct", "askDominantUpdatesPct", "finalBidDominancePct", "finalAskDominancePct",
    "bidPersistencePct", "askPersistencePct", "normalizedOfi", "estimatedDeltaPct",
    "stackedBidImbalancesPct", "stackedAskImbalancesPct", "bidReplenishmentPct", "askReplenishmentPct",
    "bidDisappeared", "askDisappeared", "midPriceProgressPct", "bestBidProgress", "bestAskProgress",
    "lastPriceProgressPct", "spreadExpansionPct", "bullishPhaseScore", "bullishTopTwoScore",
    "bullishImprovementScore", "bullishDominanceScore", "bullishPersistenceScore", "bullishOfiScore",
    "bullishDeltaScore", "bullishStackedScore", "bullishReplenishmentScore", "bullishPriceScore",
    "bearishPhaseScore", "bearishTopTwoScore", "bearishImprovementScore", "bearishDominanceScore",
    "bearishPersistenceScore", "bearishOfiScore", "bearishDeltaScore", "bearishStackedScore",
    "bearishReplenishmentScore", "bearishPriceScore", "spreadScore", "qualityScore"]
  const audit = fs.createWriteStream(auditFile, { encoding: "utf8" })
  await write(audit, `${auditColumns.join(",")}\n`)
  const rankings = []

  for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex++) {
    const symbol = symbols[symbolIndex]
    process.stderr.write(`\rScanning ${symbolIndex + 1}/${symbols.length}: ${symbol.padEnd(16)}`)
    const buckets = await readBuckets(symbol, relevantDates, candleMinutes)
    let bullishCumulativeScore = 0, bearishCumulativeScore = 0
    let minutesWithDepth = 0, reliableMinutes = 0, totalDepthObjects = 0
    let bestBullish = null, bestBearish = null
    for (const minute of candleMinutes) {
      const result = evaluate(buckets.get(minute) || [], minute)
      bullishCumulativeScore += result.bullishScore
      bearishCumulativeScore += result.bearishScore
      if (result.updates > 0) minutesWithDepth++
      if (result.dataQualityPct >= 80) reliableMinutes++
      totalDepthObjects += result.updates
      if (!bestBullish || result.bullishScore > bestBullish.bullishScore) bestBullish = result
      if (!bestBearish || result.bearishScore > bestBearish.bearishScore) bestBearish = result
      await write(audit, csvRow(auditColumns, { symbol, ...result }))
    }
    rankings.push({ symbol, bullishCumulativeScore: round(bullishCumulativeScore),
      bearishCumulativeScore: round(bearishCumulativeScore),
      bullishAverageScorePerRequestedCandle: round(bullishCumulativeScore / candleMinutes.length),
      bearishAverageScorePerRequestedCandle: round(bearishCumulativeScore / candleMinutes.length),
      requestedCandleCount: candleMinutes.length, minutesWithDepth,
      missingMinuteCount: candleMinutes.length - minutesWithDepth, reliableMinuteCount: reliableMinutes,
      totalDepthObjects,
      bestBullishCandle: bestBullish ? `${bestBullish.candleDate} ${bestBullish.candleTime}` : "",
      bestBullishCandleScore: bestBullish?.bullishScore ?? 0,
      bestBearishCandle: bestBearish ? `${bestBearish.candleDate} ${bestBearish.candleTime}` : "",
      bestBearishCandleScore: bestBearish?.bearishScore ?? 0 })
  }
  process.stderr.write("\n")
  audit.end()
  await once(audit, "finish")

  const bullishRanking = rankings.slice().sort((a, b) =>
    b.bullishCumulativeScore - a.bullishCumulativeScore ||
    b.bullishAverageScorePerRequestedCandle - a.bullishAverageScorePerRequestedCandle)
  const bearishRanking = rankings.slice().sort((a, b) =>
    b.bearishCumulativeScore - a.bearishCumulativeScore ||
    b.bearishAverageScorePerRequestedCandle - a.bearishAverageScorePerRequestedCandle)
  bullishRanking.forEach((row, index) => { row.bullishRank = index + 1 })
  bearishRanking.forEach((row, index) => { row.bearishRank = index + 1 })
  writeCsv(rankingFile, bullishRanking)
  const topBullish = bullishRanking.slice(0, Math.min(options.top, bullishRanking.length))
  const topBearish = bearishRanking.slice(0, Math.min(options.top, bearishRanking.length))
  const summary = {
    generatedAt: new Date().toISOString(), timezone: "Asia/Calcutta",
    requestedCutoff: options.cutoff || "latest completed minute",
    effectiveLastIncludedCandle: indiaDateTime(lastMinute), firstIncludedCandle: indiaDateTime(firstMinute),
    requestedCandleCount: options.count, actualCandleCount: candleMinutes.length,
    savedTradingDatesUsed: relevantDates, stocksScored: symbols.length,
    scoring: "Every requested one-minute window receives separate 0-100 bullish and exact-reverse bearish depth scores. Missing depth windows score zero. Each cumulative score is the sum of all minute scores; no threshold is applied.",
    topBullish, topBearish, top5Bullish: bullishRanking.slice(0, 5),
    top5Bearish: bearishRanking.slice(0, 5), rankingFile, auditFile,
  }
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ summaryFile, ...summary }, null, 2))
  console.log(`bullish: ${topBullish.map((row) => `NSE:${row.symbol}-EQ`).join(",")}`)
  console.log(`bearish: ${topBearish.map((row) => `NSE:${row.symbol}-EQ`).join(",")}`)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
