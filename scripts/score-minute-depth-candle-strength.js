import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const MINUTE = 60_000
const symbol = String(process.argv[2] || "TATATECH").toUpperCase().replace(/-EQ$/, "")
const date = process.argv[3] || new Date(Date.now() + 330 * MINUTE).toISOString().slice(0, 10)
const startTime = process.argv[4] || "09:17"
const throughTime = process.argv[5] || "09:30"
const compactOutput = process.argv.includes("--compact")
const skipCsv = process.argv.includes("--no-csv")
const bearish = process.argv.includes("--bearish")
const side = bearish ? "bearish" : "bullish"
const direction = bearish ? -1 : 1
const start = Date.parse(`${date}T${startTime}:00+05:30`)
const through = Date.parse(`${date}T${throughTime}:00+05:30`)
const end = through + MINUTE

if (!Number.isFinite(start) || !Number.isFinite(through) || through < start) {
  throw new Error("Usage: node scripts/score-minute-depth-candle-strength.js SYMBOL YYYY-MM-DD HH:MM HH:MM")
}

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const median = (values) => {
  if (!values.length) return NaN
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaTime = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)

function parseLines(filename, from = -Infinity, to = Infinity) {
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    const match = line.match(/"receivedAt":"([^"]+)"/)
    if (match) {
      const at = Date.parse(match[1])
      if (!Number.isFinite(at) || at < from || at >= to) return []
    }
    try { return [JSON.parse(line)] } catch { return [] }
  })
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
  const askDominant = asks.map((ask, index) => ask.size >= 5 && ask.size >= 1.5 * Math.max(1, bids[index].size))
  const longestRun = (values) => {
    let run = 0
    let maximum = 0
    for (const value of values) {
      run = value ? run + 1 : 0
      maximum = Math.max(maximum, run)
    }
    return maximum
  }
  const maxBidLevelShare = Math.max(...bids.map((row) => row.size)) / bidSize
  const maxAskLevelShare = Math.max(...asks.map((row) => row.size)) / askSize
  return {
    bids, asks, bestBid: bids[0].price, bestAsk: asks[0].price,
    bid1: bids[0].size, ask1: asks[0].size, bidSize, askSize,
    bidShare: 100 * bidSize / (bidSize + askSize), dominant, askDominant,
    dominantLevels: dominant.filter(Boolean).length, askDominantLevels: askDominant.filter(Boolean).length,
    maxRun: longestRun(dominant), maxAskRun: longestRun(askDominant),
    maxBidLevelShare, maxAskLevelShare,
    spread: asks[0].price - bids[0].price,
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

const allCandles = parseLines(candleFile).flatMap((row) => {
  const at = Number(row.time) * 1000
  if (!Number.isFinite(at) || row.partial) return []
  const candle = {
    at: Math.floor(at / MINUTE) * MINUTE, open: Number(row.open), high: Number(row.high),
    low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  }
  return [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
    ? [candle] : []
}).sort((left, right) => left.at - right.at)
const candleMap = new Map(allCandles.map((candle) => [candle.at, candle]))

const buckets = new Map()
let previous = null
let lastTradeDirection = 0
for (const record of parseLines(depthFile, start - 90_000, end)) {
  const at = Date.parse(record.receivedAt)
  const currentBook = book(record.data)
  const price = Number(record.marketContext?.price)
  const volume = Number(record.marketContext?.cumulativeVolume)
  if (!Number.isFinite(at) || !currentBook || !(price > 0) || !Number.isFinite(volume)) continue
  if (previous && at - previous.at > 90_000) previous = null
  let normalizedOfi = 0
  let tradedVolume = 0
  let signedVolume = 0
  if (previous) {
    const ofi = (currentBook.bestBid >= previous.book.bestBid ? currentBook.bid1 : 0) -
      (currentBook.bestBid <= previous.book.bestBid ? previous.book.bid1 : 0) -
      (currentBook.bestAsk <= previous.book.bestAsk ? currentBook.ask1 : 0) +
      (currentBook.bestAsk >= previous.book.bestAsk ? previous.book.ask1 : 0)
    const depth = (currentBook.bid1 + currentBook.ask1 + previous.book.bid1 + previous.book.ask1) / 2
    normalizedOfi = ofi / (depth || 1)
    tradedVolume = Math.max(0, volume - previous.volume)
    if (price > previous.price) lastTradeDirection = 1
    else if (price < previous.price) lastTradeDirection = -1
    signedVolume = tradedVolume * lastTradeDirection
  }
  if (at >= start) {
    const minute = Math.floor(at / MINUTE) * MINUTE
    const bucket = buckets.get(minute) || { minute, samples: [], tradedVolume: 0, signedVolume: 0 }
    bucket.samples.push({ at, price, book: currentBook, normalizedOfi, tradedVolume, signedVolume })
    bucket.tradedVolume += tradedVolume
    bucket.signedVolume += signedVolume
    buckets.set(minute, bucket)
  }
  previous = { at, price, volume, book: currentBook }
}

const outputRows = []
for (let minute = start; minute < end; minute += MINUTE) {
  const candle = candleMap.get(minute)
  const bucket = buckets.get(minute)
  if (!candle || !bucket) {
    outputRows.push({ time: indiaTime(minute), finalScore: 0, qualified: false,
      gateFailures: !candle ? "missing candle" : "missing depth" })
    continue
  }
  const samples = bucket.samples
  const gaps = samples.slice(1).map((sample, index) => (sample.at - samples[index].at) / 1000)
  const maxGapSec = gaps.length ? Math.max(...gaps) : 60
  const range = candle.high - candle.low
  const candleReturnPct = pct(candle.close, candle.open)
  const closeLocation = range > 0 ? clamp((candle.close - candle.low) / range) : 0.5
  const upperWickShare = range > 0 ? clamp((candle.high - Math.max(candle.open, candle.close)) / range) : 0.5
  const lowerWickShare = range > 0 ? clamp((Math.min(candle.open, candle.close) - candle.low) / range) : 0.5
  const directionalReturnPct = direction * candleReturnPct
  const directionalCloseLocation = bearish ? 1 - closeLocation : closeLocation
  const adverseWickShare = bearish ? lowerWickShare : upperWickShare
  const priorVolumes = allCandles.filter((row) => row.at < minute && row.at >= Date.parse(`${date}T09:15:00+05:30`))
    .slice(-10).map((row) => row.volume)
  const baselineVolume = median(priorVolumes)
  const volumeRatio = Number.isFinite(baselineVolume) && baselineVolume > 0 ? candle.volume / baselineVolume : NaN
  const averageBidShare = mean(samples.map((sample) => sample.book.bidShare))
  const averageSideShare = bearish ? 100 - averageBidShare : averageBidShare
  const sideDominantTicksPct = 100 * samples.filter((sample) =>
    bearish ? sample.book.bidShare < 50 : sample.book.bidShare > 50).length / samples.length
  const stackedTicksPct = 100 * samples.filter((sample) =>
    (bearish ? sample.book.maxAskRun : sample.book.maxRun) >= 3).length / samples.length
  const averageDominantLevels = mean(samples.map((sample) =>
    bearish ? sample.book.askDominantLevels : sample.book.dominantLevels))
  const normalizedOfi = mean(samples.map((sample) => sample.normalizedOfi))
  const directionalOfi = direction * normalizedOfi
  const estimatedDeltaPct = bucket.tradedVolume > 0 ? 100 * bucket.signedVolume / bucket.tradedVolume : 0
  const directionalDeltaPct = direction * estimatedDeltaPct
  const quarter = Math.max(1, Math.ceil(samples.length / 4))
  const half = Math.max(1, Math.ceil(samples.length / 2))
  const firstHalf = samples.slice(0, half)
  const secondHalf = samples.slice(half)
  const lastQuarter = samples.slice(-quarter)
  const firstOfi = mean(firstHalf.map((sample) => sample.normalizedOfi))
  const secondOfi = mean(secondHalf.map((sample) => sample.normalizedOfi))
  const closingBidShare = mean(lastQuarter.map((sample) => sample.book.bidShare))
  const closingSideShare = bearish ? 100 - closingBidShare : closingBidShare
  const firstSigned = firstHalf.reduce((sum, sample) => sum + sample.signedVolume, 0)
  const secondSigned = secondHalf.reduce((sum, sample) => sum + sample.signedVolume, 0)
  const firstTraded = firstHalf.reduce((sum, sample) => sum + sample.tradedVolume, 0)
  const secondTraded = secondHalf.reduce((sum, sample) => sum + sample.tradedVolume, 0)
  const firstDeltaPct = firstTraded > 0 ? 100 * firstSigned / firstTraded : 0
  const secondDeltaPct = secondTraded > 0 ? 100 * secondSigned / secondTraded : 0
  const directionalFirstDeltaPct = direction * firstDeltaPct
  const directionalSecondDeltaPct = direction * secondDeltaPct
  let extremeIndex = 0
  for (let index = 1; index < samples.length; index++) {
    if (bearish
      ? samples[index].price > samples[extremeIndex].price
      : samples[index].price < samples[extremeIndex].price) extremeIndex = index
  }
  const beforeExtreme = samples.slice(0, extremeIndex + 1)
  const afterExtreme = samples.slice(extremeIndex)
  const absorbedFlow = Math.abs(beforeExtreme.reduce((sum, sample) => sum +
    (bearish ? Math.max(0, sample.signedVolume) : Math.min(0, sample.signedVolume)), 0))
  const absorptionFlowPct = bucket.tradedVolume > 0 ? 100 * absorbedFlow / bucket.tradedVolume : 0
  const postExtremeSideShare = mean(afterExtreme.map((sample) =>
    bearish ? 100 - sample.book.bidShare : sample.book.bidShare))
  const tickSizes = samples.flatMap((sample) => sample.book.bids.slice(1)
    .map((row, index) => sample.book.bids[index].price - row.price)).filter((value) => value > 0)
  const tickSize = median(tickSizes)
  const priceProgressTicks = tickSize > 0 ? direction * (candle.close - candle.open) / tickSize : 0
  const spreadBps = samples.map((sample) => 10_000 * sample.book.spread /
    ((sample.book.bestBid + sample.book.bestAsk) / 2))
  const firstSpread = mean(spreadBps.slice(0, quarter))
  const finalSpread = mean(spreadBps.slice(-quarter))
  const spreadExpansionPct = firstSpread > 0 ? 100 * (finalSpread / firstSpread - 1) : 0
  const averageLevelConcentrationPct = 100 * mean(samples.map((sample) =>
    bearish ? sample.book.maxAskLevelShare : sample.book.maxBidLevelShare))
  let vanishes = 0
  for (let index = 1; index < samples.length; index++) {
    const prior = samples[index - 1]
    const current = samples[index]
    if (bearish
      ? current.book.askSize < prior.book.askSize * 0.5 && current.price >= prior.price
      : current.book.bidSize < prior.book.bidSize * 0.5 && current.price <= prior.price) vanishes++
  }
  const sideVanishPct = samples.length > 1 ? 100 * vanishes / (samples.length - 1) : 0

  const priceScore = 20 * (0.40 * clamp(directionalReturnPct / 0.20) +
    0.35 * directionalCloseLocation + 0.25 * (1 - adverseWickShare))
  const deltaScore = 20 * clamp(directionalDeltaPct / 40)
  const persistentSideScore = 15 * (0.50 * clamp((averageSideShare - 50) / 15) +
    0.30 * clamp(sideDominantTicksPct / 70) + 0.20 * clamp((closingSideShare - 50) / 15))
  const stackedSideScore = 15 * (0.60 * clamp(stackedTicksPct / 50) +
    0.40 * clamp(averageDominantLevels / 3))
  const ofiScore = 10 * (0.70 * clamp(directionalOfi / 0.25) +
    0.30 * clamp(direction * (secondOfi - firstOfi) / 0.25))
  const relativeVolumeScore = 10 * clamp(volumeRatio / 2)
  const absorptionScore = 5 * (0.45 * clamp(absorptionFlowPct / 40) +
    0.35 * clamp((postExtremeSideShare - 45) / 20) + 0.20 * directionalCloseLocation)
  const spreadStabilityScore = 5 * (0.60 * (1 - clamp(Math.max(0, spreadExpansionPct) / 50)) +
    0.40 * (1 - clamp(sideVanishPct / 25)))
  const baseScore = priceScore + deltaScore + persistentSideScore + stackedSideScore + ofiScore +
    relativeVolumeScore + absorptionScore + spreadStabilityScore

  const earlyPriceNearExtreme = range > 0 && (bearish
    ? Math.max(...firstHalf.map((sample) => sample.price)) >= candle.high - 0.25 * range
    : Math.min(...firstHalf.map((sample) => sample.price)) <= candle.low + 0.25 * range)
  const closeMovedFromExtreme = bearish ? candle.close < candle.high : candle.close > candle.low
  const sequenceChecks = [
    direction * firstSigned < 0 && earlyPriceNearExtreme,
    closeMovedFromExtreme && postExtremeSideShare >= 50,
    stackedTicksPct >= 30,
    directionalFirstDeltaPct <= 0 && directionalSecondDeltaPct > 0,
    priceProgressTicks >= 2,
    directionalCloseLocation >= 0.80,
    closingSideShare > 50,
  ]
  const confirmationCount = sequenceChecks.filter(Boolean).length
  const sequenceScore = 100 * confirmationCount / sequenceChecks.length

  const conflicts = []
  let conflictPenalty = 0
  if (directionalDeltaPct > 0 && directionalReturnPct < 0.03) { conflicts.push("delta without price progress"); conflictPenalty += 8 }
  if (directionalReturnPct > 0 && directionalOfi < 0) { conflicts.push("price/OFI disagreement"); conflictPenalty += 8 }
  if (closingSideShare < 50) { conflicts.push(`closing depth ${bearish ? "bid" : "ask"}-dominant`); conflictPenalty += 6 }
  if (sideVanishPct >= 20) { conflicts.push(`large ${bearish ? "asks" : "bids"} vanished`); conflictPenalty += 8 }
  if (adverseWickShare > 0.30) { conflicts.push(`large ${bearish ? "lower" : "upper"} wick`); conflictPenalty += 8 }
  if (averageLevelConcentrationPct > 60) { conflicts.push(`${bearish ? "asks" : "bids"} concentrated at one level`); conflictPenalty += 5 }
  if (spreadExpansionPct > 50) { conflicts.push("spread expanded"); conflictPenalty += 5 }

  const gateFailures = []
  if (samples.length < 10) gateFailures.push("fewer than 10 depth updates")
  if (maxGapSec > 15) gateFailures.push("depth gap above 15 seconds")
  if (!(directionalReturnPct > 0)) gateFailures.push(bearish ? "non-negative candle" : "non-positive candle")
  if (!(directionalDeltaPct > 0)) gateFailures.push(bearish ? "non-negative estimated delta" : "non-positive estimated delta")
  if (!(averageSideShare > 50)) gateFailures.push(`average ${bearish ? "ask" : "bid"} share not above 50%`)
  if (priorVolumes.length < 2) gateFailures.push("insufficient volume baseline")
  else if (!(volumeRatio >= 1)) gateFailures.push("volume below recent median")
  const qualified = gateFailures.length === 0
  const scoredBeforeGate = clamp(0.85 * baseScore + 0.15 * sequenceScore - conflictPenalty, 0, 100)
  const finalScore = qualified ? scoredBeforeGate : 0

  outputRows.push({
    time: indiaTime(minute), side, finalScore: round(finalScore), diagnosticScore: round(scoredBeforeGate), qualified,
    gateFailures: gateFailures.join("; "), conflictPenalty, conflicts: conflicts.join("; "),
    updates: samples.length, maxGapSec: round(maxGapSec, 1), candleOpen: candle.open, candleClose: candle.close,
    candleReturnPct: round(candleReturnPct),
    directionalReturnPct: round(directionalReturnPct), closeLocationPct: round(100 * closeLocation),
    directionalCloseLocationPct: round(100 * directionalCloseLocation),
    upperWickPct: round(100 * upperWickShare), lowerWickPct: round(100 * lowerWickShare),
    adverseWickPct: round(100 * adverseWickShare),
    volume: candle.volume, volumeBaseline: round(baselineVolume), volumeRatio: round(volumeRatio),
    estimatedDeltaPct: round(estimatedDeltaPct), directionalDeltaPct: round(directionalDeltaPct),
    averageBidSharePct: round(averageBidShare), averageSideSharePct: round(averageSideShare),
    closingBidSharePct: round(closingBidShare), closingSideSharePct: round(closingSideShare),
    sideDominantTicksPct: round(sideDominantTicksPct),
    stackedTicksPct: round(stackedTicksPct), averageDominantLevels: round(averageDominantLevels),
    normalizedOfi: round(normalizedOfi, 4), directionalOfi: round(directionalOfi, 4),
    firstHalfDeltaPct: round(firstDeltaPct), secondHalfDeltaPct: round(secondDeltaPct),
    firstHalfDirectionalDeltaPct: round(directionalFirstDeltaPct),
    secondHalfDirectionalDeltaPct: round(directionalSecondDeltaPct),
    absorptionFlowPct: round(absorptionFlowPct), postExtremeSideSharePct: round(postExtremeSideShare),
    priceProgressTicks: round(priceProgressTicks), sideVanishPct: round(sideVanishPct),
    spreadExpansionPct: round(spreadExpansionPct),
    confirmationCount, baseScore: round(baseScore), sequenceScore: round(sequenceScore),
    priceScore: round(priceScore), deltaScore: round(deltaScore),
    persistentSideScore: round(persistentSideScore), stackedSideScore: round(stackedSideScore),
    ofiScore: round(ofiScore), relativeVolumeScore: round(relativeVolumeScore),
    absorptionScore: round(absorptionScore), spreadStabilityScore: round(spreadStabilityScore),
  })
}

for (let index = 0; index < outputRows.length; index++) {
  const row = outputRows[index]
  const futureRows = outputRows.slice(index + 1, index + 3)
    .filter((candidate) => Number.isFinite(candidate.candleClose) && Number.isFinite(row.candleClose))
  const followThroughPct = futureRows.length
    ? Math.max(...futureRows.map((candidate) => direction * pct(candidate.candleClose, row.candleClose)))
    : NaN
  row.followThroughPct = round(followThroughPct)
  row.cleanContinuation = Boolean(row.qualified && row.conflictPenalty === 0 &&
    row.directionalReturnPct >= 0.05 && row.adverseWickPct <= 30 && followThroughPct >= 0.05)
}

const columns = [...new Set(outputRows.flatMap((row) => Object.keys(row)))]
const slug = (value) => value.replace(":", "")
const output = path.join(ROOT, "csv", `${date}-${symbol}-${slug(startTime)}-to-${slug(throughTime)}-${side}-depth-candle-strength.csv`)
const csv = [columns.join(","), ...outputRows.map((row) => columns.map((column) => csvValue(row[column])).join(","))]
if (!skipCsv) fs.writeFileSync(output, `${csv.join("\n")}\n`)
const qualifiedRows = outputRows.filter((row) => row.qualified)
  .sort((left, right) => right.finalScore - left.finalScore)
const topCandidates = outputRows.slice().sort((left, right) =>
  (right.diagnosticScore || 0) - (left.diagnosticScore || 0)).slice(0, 5)
const availableRows = outputRows.filter((row) => Number.isFinite(row.diagnosticScore))
const metricThresholds = {
  bullishScore: 70,
  candleReturnPct: 0.05,
  priceProgressTicks: 2,
  relativeVolumeRatio: 1,
  estimatedDeltaPct: 0,
  averageBidSharePct: 50,
  normalizedOfi: 0,
  bidDominantUpdatesPct: 60,
}
const metricPassCounts = !bearish ? {
  bullishScore: availableRows.filter((row) => row.diagnosticScore >= metricThresholds.bullishScore).length,
  candleReturn: availableRows.filter((row) => row.candleReturnPct >= metricThresholds.candleReturnPct).length,
  priceProgress: availableRows.filter((row) => row.priceProgressTicks >= metricThresholds.priceProgressTicks).length,
  relativeVolume: availableRows.filter((row) => row.volumeRatio >= metricThresholds.relativeVolumeRatio).length,
  estimatedDelta: availableRows.filter((row) => row.estimatedDeltaPct > metricThresholds.estimatedDeltaPct).length,
  averageBidShare: availableRows.filter((row) => row.averageBidSharePct > metricThresholds.averageBidSharePct).length,
  normalizedOfi: availableRows.filter((row) => row.normalizedOfi > metricThresholds.normalizedOfi).length,
  bidDominantUpdates: availableRows.filter((row) => row.sideDominantTicksPct >= metricThresholds.bidDominantUpdatesPct).length,
} : null
const allMetricPassRows = !bearish ? availableRows.filter((row) =>
  row.diagnosticScore >= metricThresholds.bullishScore &&
  row.candleReturnPct >= metricThresholds.candleReturnPct &&
  row.priceProgressTicks >= metricThresholds.priceProgressTicks &&
  row.volumeRatio >= metricThresholds.relativeVolumeRatio &&
  row.estimatedDeltaPct > metricThresholds.estimatedDeltaPct &&
  row.averageBidSharePct > metricThresholds.averageBidSharePct &&
  row.normalizedOfi > metricThresholds.normalizedOfi &&
  row.sideDominantTicksPct >= metricThresholds.bidDominantUpdatesPct) : []
if (metricPassCounts) metricPassCounts.allEight = allMetricPassRows.length
const cleanContinuationRows = outputRows.filter((row) => row.cleanContinuation)
  .sort((left, right) => right.finalScore - left.finalScore)
const reversalCandidateRows = bearish ? outputRows.slice(0, -3).filter((row) =>
  Number.isFinite(row.diagnosticScore) && row.directionalReturnPct >= 0.03 && row.directionalDeltaPct > 0) : []
const reversalPressure = reversalCandidateRows.sort((left, right) =>
  right.diagnosticScore - left.diagnosticScore)[0] || null
let absorptionReversal = null
if (reversalPressure) {
  const pressureIndex = outputRows.indexOf(reversalPressure)
  const after = outputRows.slice(pressureIndex + 1).filter((row) => Number.isFinite(row.candleClose))
  const last = after.at(-1)
  const latestThree = outputRows.filter((row) => Number.isFinite(row.candleClose)).slice(-3)
  const recoveryPct = last ? pct(last.candleClose, reversalPressure.candleClose) : NaN
  const latestThreeReturnPct = latestThree.length === 3
    ? pct(latestThree.at(-1).candleClose, latestThree[0].candleOpen) : NaN
  const greenMinutes = after.filter((row) => row.candleReturnPct > 0).length
  const positiveDeltaMinutes = after.filter((row) => row.estimatedDeltaPct > 0).length
  const positiveOfiMinutes = after.filter((row) => row.normalizedOfi > 0).length
  const recoveryScore = 100 * (0.20 * clamp(reversalPressure.diagnosticScore / 80) +
    0.20 * clamp(recoveryPct / 0.40) +
    0.15 * clamp(greenMinutes / Math.max(1, after.length) / 0.60) +
    0.15 * clamp(positiveDeltaMinutes / Math.max(1, after.length) / 0.60) +
    0.10 * clamp(positiveOfiMinutes / Math.max(1, after.length) / 0.60) +
    0.10 * clamp(latestThreeReturnPct / 0.20) +
    0.10 * (cleanContinuationRows.length === 0 ? 1 : 0))
  absorptionReversal = {
    pressureTime: reversalPressure.time,
    pressureScore: reversalPressure.diagnosticScore,
    pressureReturnPct: reversalPressure.candleReturnPct,
    pressureDeltaPct: reversalPressure.estimatedDeltaPct,
    pressureQualified: reversalPressure.qualified,
    pressureFailures: reversalPressure.gateFailures,
    postMinutes: after.length,
    recoveryPct: round(recoveryPct),
    greenMinutes,
    positiveDeltaMinutes,
    positiveOfiMinutes,
    latestThreeReturnPct: round(latestThreeReturnPct),
    recoveryScore: round(recoveryScore),
    patternMatched: cleanContinuationRows.length === 0 && reversalPressure.diagnosticScore >= 55 &&
      recoveryPct >= 0.10 && greenMinutes >= 3 && positiveDeltaMinutes >= 2 &&
      positiveOfiMinutes >= 2 && latestThreeReturnPct > 0,
  }
}
const summary = {
  symbol, side, date, range: `${startTime}-${throughTime}`, minutes: outputRows.length,
  averageDiagnosticScore: round(mean(outputRows.map((row) => row.diagnosticScore || 0))),
  availableMinutes: availableRows.length,
  averageAvailableDiagnosticScore: round(mean(availableRows.map((row) => row.diagnosticScore))),
  averageFinalScore: round(mean(outputRows.map((row) => row.finalScore || 0))),
  qualified: qualifiedRows.length, cleanContinuationMinutes: cleanContinuationRows.length,
  strongestCleanContinuation: cleanContinuationRows[0] || null,
  metricThresholds: bearish ? null : metricThresholds,
  metricPassCounts,
  allMetricPassAverageScore: allMetricPassRows.length
    ? round(mean(allMetricPassRows.map((row) => row.diagnosticScore))) : null,
  allMetricPassTimes: allMetricPassRows.map((row) => row.time).join("|"),
  absorptionReversal,
  output: skipCsv ? null : output, topCandidates,
}
if (!compactOutput) {
  summary.ranked = qualifiedRows
  summary.allMinutes = outputRows
}
console.log(JSON.stringify(summary, null, compactOutput ? 0 : 2))
