import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const MINUTE = 60_000
const date = process.argv[2] || new Date(Date.now() + 330 * MINUTE).toISOString().slice(0, 10)
const requestedThrough = process.argv[3] || null
const liveCutoff = Math.floor(Date.now() / MINUTE) * MINUTE
const requestedCutoff = requestedThrough ? Date.parse(`${date}T${requestedThrough}:00+05:30`) + MINUTE : Infinity
const cutoff = Math.min(liveCutoff, requestedCutoff)
const sessionStart = Date.parse(`${date}T09:15:00+05:30`)
const completedMinutes = Math.max(0, Math.floor((cutoff - sessionStart) / MINUTE))
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaTime = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)

function book(data) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bid = { price: Number(data?.[`bid_price${level}`]), size: Number(data?.[`bid_size${level}`]), orders: Number(data?.[`bid_order${level}`]) }
    const ask = { price: Number(data?.[`ask_price${level}`]), size: Number(data?.[`ask_size${level}`]), orders: Number(data?.[`ask_order${level}`]) }
    if (![bid.price, bid.size, ask.price, ask.size].every(Number.isFinite) ||
        bid.price <= 0 || ask.price <= bid.price || bid.size < 0 || ask.size < 0) return null
    bids.push(bid); asks.push(ask)
  }
  const bidSize = bids.reduce((sum, row) => sum + row.size, 0)
  const askSize = asks.reduce((sum, row) => sum + row.size, 0)
  if (!(bidSize + askSize > 0)) return null
  const dominant = bids.map((bid, index) => bid.size >= 5 && bid.size >= 1.5 * Math.max(1, asks[index].size))
  let run = 0, longestRun = 0
  for (const value of dominant) { run = value ? run + 1 : 0; longestRun = Math.max(longestRun, run) }
  return { bestBid: bids[0].price, bestAsk: asks[0].price, bid1: bids[0].size, ask1: asks[0].size,
    bidSize, askSize, bidShare: 100 * bidSize / (bidSize + askSize),
    top2BidShare: 100 * (bids[0].size + bids[1].size) /
      (bids[0].size + bids[1].size + asks[0].size + asks[1].size),
    stackedBid: longestRun >= 3, mid: (bids[0].price + asks[0].price) / 2,
    spread: asks[0].price - bids[0].price }
}

async function readBuckets(filename) {
  const buckets = new Map()
  const lines = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(row.receivedAt)
    if (!Number.isFinite(at) || at < sessionStart || at >= cutoff) continue
    const current = book(row.data), price = Number(row.marketContext?.price)
    const volume = Number(row.marketContext?.cumulativeVolume)
    if (!current || !(price > 0) || !Number.isFinite(volume)) continue
    const minute = Math.floor(at / MINUTE) * MINUTE
    const bucket = buckets.get(minute) || []
    bucket.push({ at, price, volume, book: current })
    buckets.set(minute, bucket)
  }
  return buckets
}

function evaluate(samples, minute) {
  if (!samples?.length) return { time: indiaTime(minute), score: 0, updates: 0, coverageSeconds: 0,
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
  const improvement = endingBidShare - startingBidShare
  const fullBidDominance = 100 * samples.filter((row) => row.book.bidShare > 50).length / samples.length
  const finalBidDominance = 100 * finalThird.filter((row) => row.book.bidShare > 50).length / finalThird.length
  const stackedBidPct = 100 * samples.filter((row) => row.book.stackedBid).length / samples.length
  let control = -1
  for (let index = 0; index <= samples.length - 3; index++) {
    if (samples.slice(index, index + 3).every((row) => row.book.bidShare > 50)) { control = index; break }
  }
  const afterControl = control >= 0 ? samples.slice(control) : []
  const persistencePct = afterControl.length ? 100 * afterControl.filter((row) => row.book.bidShare > 50).length / afterControl.length : 0
  const finalThreeBidShare = mean(samples.slice(-3).map((row) => row.book.bidShare))
  const secondHalf = samples.slice(Math.floor(samples.length / 2))
  let strongestLateThree = 0
  for (let index = 0; index <= secondHalf.length - 3; index++) strongestLateThree = Math.max(strongestLateThree,
    mean(secondHalf.slice(index, index + 3).map((row) => row.book.bidShare)))
  const bidDisappeared = finalThreeBidShare < 50 || finalThreeBidShare < 58 && strongestLateThree - finalThreeBidShare > 12

  let tradedVolume = 0, signedVolume = 0, lastDirection = 0
  const ofis = [], replenishments = []
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1], current = samples[index]
    const ofi = (current.book.bestBid >= previous.book.bestBid ? current.book.bid1 : 0) -
      (current.book.bestBid <= previous.book.bestBid ? previous.book.bid1 : 0) -
      (current.book.bestAsk <= previous.book.bestAsk ? current.book.ask1 : 0) +
      (current.book.bestAsk >= previous.book.bestAsk ? previous.book.ask1 : 0)
    const depth = (current.book.bid1 + current.book.ask1 + previous.book.bid1 + previous.book.ask1) / 2
    ofis.push(ofi / (depth || 1))
    const increment = Math.max(0, current.volume - previous.volume)
    if (current.price > previous.price) lastDirection = 1
    else if (current.price < previous.price) lastDirection = -1
    tradedVolume += increment; signedVolume += increment * lastDirection
    replenishments.push(current.book.bestBid > previous.book.bestBid ||
      current.book.bestBid === previous.book.bestBid && current.book.bid1 > previous.book.bid1 ? 1 : 0)
  }
  const normalizedOfi = mean(ofis) || 0
  const estimatedDeltaPct = tradedVolume > 0 ? 100 * signedVolume / tradedVolume : 0
  const replenishmentPct = 100 * (mean(replenishments) || 0)
  const priceReturnPct = pct(samples.at(-1).price, samples[0].price)
  const midReturnPct = pct(samples.at(-1).book.mid, samples[0].book.mid)
  const bestBidProgress = samples.at(-1).book.bestBid > samples[0].book.bestBid
  const startingSpread = mean(first.map((row) => row.book.spread / row.book.mid))
  const endingSpread = mean(last.map((row) => row.book.spread / row.book.mid))
  const spreadExpansionPct = startingSpread > 0 ? 100 * (endingSpread / startingSpread - 1) : 0

  const phaseScore = 5 * clamp((middleBidShare - 45) / 20) + 10 * clamp((endingBidShare - 45) / 25)
  const topTwoScore = 8 * clamp((endingTop2BidShare - 45) / 25)
  const improvementScore = 10 * clamp(improvement / 20)
  const dominanceScore = 3 * clamp(fullBidDominance / 70) + 5 * clamp(finalBidDominance / 80)
  const persistenceScore = 8 * clamp(persistencePct / 80)
  const ofiScore = 10 * clamp(normalizedOfi / 0.15)
  const deltaScore = 10 * clamp(estimatedDeltaPct / 25)
  const stackedScore = 5 * clamp(stackedBidPct / 25)
  const replenishmentScore = 6 * clamp((replenishmentPct - 25) / 40) + (bidDisappeared ? 0 : 2)
  const priceScore = 3 * clamp(midReturnPct / 0.20) + 2 * clamp(priceReturnPct / 0.25) + (bestBidProgress ? 3 : 0)
  const spreadScore = 5 * clamp((25 - spreadExpansionPct) / 25)
  const qualityScore = 5 * dataQuality
  const rawScore = phaseScore + topTwoScore + improvementScore + dominanceScore + persistenceScore +
    ofiScore + deltaScore + stackedScore + replenishmentScore + priceScore + spreadScore + qualityScore
  const score = clamp(rawScore * (0.40 + 0.60 * dataQuality), 0, 100)
  return { time: indiaTime(minute), score: round(score), updates: samples.length,
    coverageSeconds: round(coverageSeconds), maximumGapSeconds: round(maximumGapSeconds),
    dataQualityPct: round(100 * dataQuality), startingBidSharePct: round(startingBidShare),
    middleBidSharePct: round(middleBidShare), endingBidSharePct: round(endingBidShare),
    endingTop2BidSharePct: round(endingTop2BidShare), bidShareImprovementPp: round(improvement),
    bidDominantUpdatesPct: round(fullBidDominance), finalBidDominancePct: round(finalBidDominance),
    persistencePct: round(persistencePct), normalizedOfi: round(normalizedOfi, 4),
    estimatedDeltaPct: round(estimatedDeltaPct), stackedBidImbalancesPct: round(stackedBidPct),
    replenishmentPct: round(replenishmentPct), bidDisappeared, midPriceProgressPct: round(midReturnPct),
    bestBidProgress, lastPriceProgressPct: round(priceReturnPct), spreadExpansionPct: round(spreadExpansionPct),
    phaseScore: round(phaseScore), topTwoScore: round(topTwoScore), improvementScore: round(improvementScore),
    dominanceScore: round(dominanceScore), persistenceScore: round(persistenceScore), ofiScore: round(ofiScore),
    deltaScore: round(deltaScore), stackedScore: round(stackedScore), replenishmentScore: round(replenishmentScore),
    priceScore: round(priceScore), spreadScore: round(spreadScore), qualityScore: round(qualityScore) }
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
function writeCsv(filename, records) {
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))]
  fs.writeFileSync(filename, `${[columns.join(","), ...records.map((row) =>
    columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`)
}

const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const rankings = [], audit = []
for (const symbol of symbols) {
  const filename = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const buckets = fs.existsSync(filename) ? await readBuckets(filename) : new Map()
  const minutes = []
  for (let index = 0; index < completedMinutes; index++) {
    const minute = sessionStart + index * MINUTE
    minutes.push(evaluate(buckets.get(minute) || [], minute))
  }
  const totalScore = minutes.reduce((sum, row) => sum + row.score, 0)
  const withDepth = minutes.filter((row) => row.updates > 0)
  const reliable = minutes.filter((row) => row.dataQualityPct >= 80)
  const best = minutes.slice().sort((a, b) => b.score - a.score)[0]
  rankings.push({ symbol, totalScore: round(totalScore), averagePerCompletedMinute: round(totalScore / Math.max(1, completedMinutes)),
    completedMinuteCount: completedMinutes, minutesWithDepth: withDepth.length, reliableMinuteCount: reliable.length,
    totalDepthObjects: withDepth.reduce((sum, row) => sum + row.updates, 0), bestMinute: best?.time || "",
    bestMinuteScore: best?.score ?? 0 })
  audit.push(...minutes.map((row) => ({ symbol, ...row })))
}
rankings.sort((a, b) => b.totalScore - a.totalScore || b.averagePerCompletedMinute - a.averagePerCompletedMinute)
rankings.forEach((row, index) => { row.rank = index + 1 })
const through = completedMinutes ? indiaTime(cutoff - MINUTE) : "0915"
const rankingFile = path.join(ROOT, "csv", `${date}-0915-to-${through.replace(":", "")}-cumulative-bullish-depth-score-ranking.csv`)
const auditFile = path.join(ROOT, "csv", `${date}-0915-to-${through.replace(":", "")}-all-minute-bullish-depth-scores.csv`)
writeCsv(rankingFile, rankings)
writeCsv(auditFile, audit)
console.log(JSON.stringify({ date, completedThrough: through, completedMinuteCount: completedMinutes,
  stocksScored: rankings.length, methodology: "Every completed minute scored 0-100; missing minutes score zero; stock total is the sum of all minute scores; no takeover threshold is applied.",
  top5: rankings.slice(0, 5), rankingFile, auditFile }, null, 2))
