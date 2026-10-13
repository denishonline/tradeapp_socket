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
  const bidOrders = bids.reduce((sum, row) => sum + (Number.isFinite(row.orders) ? row.orders : 0), 0)
  const askOrders = asks.reduce((sum, row) => sum + (Number.isFinite(row.orders) ? row.orders : 0), 0)
  const dominant = bids.map((bid, index) => bid.size >= 5 && bid.size >= 1.5 * Math.max(1, asks[index].size))
  let run = 0, longestRun = 0
  for (const value of dominant) { run = value ? run + 1 : 0; longestRun = Math.max(longestRun, run) }
  return { bestBid: bids[0].price, bestAsk: asks[0].price, bid1: bids[0].size, ask1: asks[0].size,
    bidSize, askSize, bidShare: 100 * bidSize / (bidSize + askSize),
    top2BidShare: 100 * (bids[0].size + bids[1].size) /
      (bids[0].size + bids[1].size + asks[0].size + asks[1].size),
    bidOrderShare: bidOrders + askOrders > 0 ? 100 * bidOrders / (bidOrders + askOrders) : 50,
    stackedBid: longestRun >= 3, mid: (bids[0].price + asks[0].price) / 2,
    spread: asks[0].price - bids[0].price }
}

async function readBuckets(filename) {
  const buckets = new Map()
  const input = fs.createReadStream(filename)
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
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
  samples.sort((a, b) => a.at - b.at)
  const gaps = samples.slice(1).map((row, index) => (row.at - samples[index].at) / 1000)
  const coverageSeconds = samples.length ? (samples.at(-1).at - samples[0].at) / 1000 : 0
  const openDelaySeconds = samples.length ? (samples[0].at - minute) / 1000 : 60
  const maxGapSeconds = gaps.length ? Math.max(...gaps) : 60
  const qualityPassed = samples.length >= 10 && coverageSeconds >= 40 && openDelaySeconds <= 15 && maxGapSeconds <= 5
  if (!qualityPassed) return null

  const sliceLength = Math.max(2, Math.ceil(samples.length * 0.20))
  const first = samples.slice(0, sliceLength), last = samples.slice(-sliceLength)
  const finalThird = samples.slice(Math.floor(samples.length * 2 / 3))
  const startingBidShare = mean(first.map((row) => row.book.bidShare))
  const endingBidShare = mean(last.map((row) => row.book.bidShare))
  const endingTop2BidShare = mean(last.map((row) => row.book.top2BidShare))
  const transition = endingBidShare - startingBidShare
  const finalBidDominance = 100 * finalThird.filter((row) => row.book.bidShare > 50).length / finalThird.length
  const fullBidDominance = 100 * samples.filter((row) => row.book.bidShare > 50).length / samples.length
  const stackedBidPct = 100 * samples.filter((row) => row.book.stackedBid).length / samples.length

  let firstPersistentControl = -1
  for (let index = 0; index <= samples.length - 3; index++) {
    if (samples.slice(index, index + 3).every((row) => row.book.bidShare > 50)) { firstPersistentControl = index; break }
  }
  const afterControl = firstPersistentControl >= 0 ? samples.slice(firstPersistentControl) : []
  const persistencePct = afterControl.length ? 100 * afterControl.filter((row) => row.book.bidShare > 50).length / afterControl.length : 0
  const finalThreeBidShare = mean(samples.slice(-3).map((row) => row.book.bidShare))
  const secondHalf = samples.slice(Math.floor(samples.length / 2))
  let strongestLateThree = 0
  for (let index = 0; index <= secondHalf.length - 3; index++) {
    strongestLateThree = Math.max(strongestLateThree,
      mean(secondHalf.slice(index, index + 3).map((row) => row.book.bidShare)))
  }
  const lateBidDisappearance = finalThreeBidShare < 50 ||
    finalThreeBidShare < 58 && strongestLateThree - finalThreeBidShare > 12

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
    tradedVolume += increment
    signedVolume += increment * lastDirection
    const bidReplenished = current.book.bestBid > previous.book.bestBid ||
      current.book.bestBid === previous.book.bestBid && current.book.bid1 > previous.book.bid1
    replenishments.push(bidReplenished ? 1 : 0)
  }
  const normalizedOfi = mean(ofis)
  const firstHalfOfi = mean(ofis.slice(0, Math.floor(ofis.length / 2)))
  const secondHalfOfi = mean(ofis.slice(Math.floor(ofis.length / 2)))
  const estimatedDeltaPct = tradedVolume > 0 ? 100 * signedVolume / tradedVolume : 0
  const replenishmentPct = 100 * mean(replenishments)

  const firstPrice = samples[0].price, lastPrice = samples.at(-1).price
  const priceReturnPct = pct(lastPrice, firstPrice)
  const midReturnPct = pct(samples.at(-1).book.mid, samples[0].book.mid)
  const low = Math.min(...samples.map((row) => row.price)), high = Math.max(...samples.map((row) => row.price))
  const closeLocationPct = high > low ? 100 * (lastPrice - low) / (high - low) : 50
  const bestBidProgress = samples.at(-1).book.bestBid > samples[0].book.bestBid
  const startingSpread = mean(first.map((row) => row.book.spread / row.book.mid))
  const endingSpread = mean(last.map((row) => row.book.spread / row.book.mid))
  const spreadExpansionPct = startingSpread > 0 ? 100 * (endingSpread / startingSpread - 1) : 0
  const spreadControlled = spreadExpansionPct <= 25

  const transitionScore = 10 * clamp(transition / 15) + 5 * clamp((endingBidShare - 50) / 12) +
    5 * clamp((endingTop2BidShare - 50) / 10) + 5 * (startingBidShare < 50 ? 1 : clamp((transition - 6) / 8))
  const persistenceScore = 8 * clamp(finalBidDominance / 75) + 7 * clamp(persistencePct / 80)
  const flowScore = 10 * clamp(normalizedOfi / 0.15) + 8 * clamp(estimatedDeltaPct / 15) +
    2 * clamp((secondHalfOfi - firstHalfOfi + 0.05) / 0.15)
  const priceScore = 7 * clamp(priceReturnPct / 0.30) + 4 * clamp(midReturnPct / 0.20) +
    2 * clamp((closeLocationPct - 50) / 35) + 2 * (bestBidProgress ? 1 : 0)
  const stackedScore = 5 * clamp((endingTop2BidShare - 50) / 12) + 5 * clamp(stackedBidPct / 25)
  const replenishmentScore = 10 * clamp((replenishmentPct - 35) / 30)
  const spreadScore = spreadControlled ? 5 * clamp((25 - Math.max(0, spreadExpansionPct)) / 25) : 0
  let score = transitionScore + persistenceScore + flowScore + priceScore + stackedScore + replenishmentScore + spreadScore

  const conflicts = []
  if (priceReturnPct <= 0 || midReturnPct < 0.08) conflicts.push("mid/last price progress below requirement")
  if (!bestBidProgress) conflicts.push("best bid did not progress")
  if (closeLocationPct < 60) conflicts.push("price did not finish in upper 60% of range")
  if (lateBidDisappearance) conflicts.push("late bid disappearance")
  if (endingBidShare < 58) conflicts.push("ending bid share below 58%")
  if (endingTop2BidShare < 55) conflicts.push("ending top-two bid share below 55%")
  if (transition < 10) conflicts.push("bid-share transition below 10pp")
  if (normalizedOfi <= 0.05) conflicts.push("OFI not positive enough")
  if (estimatedDeltaPct <= 5) conflicts.push("estimated delta not positive enough")
  if (finalBidDominance < 60) conflicts.push("weak final-third persistence")
  if (firstPersistentControl < 0 || persistencePct < 60) conflicts.push("bid control did not persist")
  if (stackedBidPct < 20) conflicts.push("stacked bids below 20% of updates")
  if (replenishmentPct < 40) conflicts.push("bid replenishment below 40%")
  if (!spreadControlled) conflicts.push("spread expanded above 25%")
  const validTakeover = conflicts.length === 0
  if (!validTakeover) score = Math.min(score, 69.99)
  return { time: indiaTime(minute), score: round(score), strong: validTakeover && score >= 80,
    validTakeover, updates: samples.length, coverageSeconds: round(coverageSeconds), maxGapSeconds: round(maxGapSeconds),
    startingBidSharePct: round(startingBidShare), endingBidSharePct: round(endingBidShare),
    bidShareTransitionPp: round(transition), endingTop2BidSharePct: round(endingTop2BidShare),
    finalBidDominancePct: round(finalBidDominance), fullBidDominancePct: round(fullBidDominance),
    stackedBidUpdatesPct: round(stackedBidPct), persistencePct: round(persistencePct),
    replenishmentPct: round(replenishmentPct), normalizedOfi: round(normalizedOfi, 4),
    estimatedDeltaPct: round(estimatedDeltaPct), priceReturnPct: round(priceReturnPct),
    midReturnPct: round(midReturnPct), closeLocationPct: round(closeLocationPct),
    spreadExpansionPct: round(spreadExpansionPct), conflicts: conflicts.join("; ") }
}

const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const rankings = [], signals = [], audit = []
for (const symbol of symbols) {
  const filename = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) continue
  const buckets = await readBuckets(filename)
  const evaluated = [...buckets].sort((a, b) => a[0] - b[0]).flatMap(([minute, samples]) => {
    const result = evaluate(samples, minute)
    return result ? [result] : []
  })
  const strong = evaluated.filter((row) => row.strong)
  const valid = evaluated.filter((row) => row.validTakeover)
  const best = evaluated.slice().sort((a, b) => b.score - a.score)[0]
  rankings.push({ symbol, strongTakeoverCount: strong.length, validTakeoverCount: valid.length,
    evaluatedMinutes: evaluated.length, averageStrongScore: round(mean(strong.map((row) => row.score))),
    bestScore: best?.score ?? null, bestTime: best?.time ?? "", strongTimes: strong.map((row) => row.time).join("|") })
  signals.push(...strong.map((row) => ({ symbol, ...row })))
  audit.push(...evaluated.map((row) => ({ symbol, ...row })))
}
rankings.sort((a, b) => b.strongTakeoverCount - a.strongTakeoverCount ||
  (b.averageStrongScore || 0) - (a.averageStrongScore || 0) || (b.bestScore || 0) - (a.bestScore || 0))
rankings.forEach((row, index) => { row.rank = index + 1 })
signals.sort((a, b) => a.time.localeCompare(b.time) || b.score - a.score)

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
function writeCsv(filename, rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  fs.writeFileSync(filename, `${[columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n")}\n`)
}
const through = indiaTime(cutoff - MINUTE)
const rankingFile = path.join(ROOT, "csv", `${date}-0915-to-${through.replace(":", "")}-strong-bullish-takeover-ranking.csv`)
const signalsFile = path.join(ROOT, "csv", `${date}-0915-to-${through.replace(":", "")}-strong-bullish-takeover-signals.csv`)
const auditFile = path.join(ROOT, "csv", `${date}-0915-to-${through.replace(":", "")}-bullish-takeover-minute-audit.csv`)
writeCsv(rankingFile, rankings)
writeCsv(signalsFile, signals)
writeCsv(auditFile, audit)
console.log(JSON.stringify({ date, completedThrough: through, stocksScanned: rankings.length,
  totalStrongMinutes: signals.length, stocksWithStrongTakeover: rankings.filter((row) => row.strongTakeoverCount > 0).length,
  top5: rankings.slice(0, 5), rankingFile, signalsFile, auditFile }, null, 2))
