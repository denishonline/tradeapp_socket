import apiV3 from "fyers-api-v3"
import fs from "node:fs"
import path from "node:path"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"

const ROOT = process.cwd()
const symbol = String(process.argv[2] || "BANDHANBNK").replace(/-EQ$/i, "").toUpperCase()
const date = process.argv[3] || new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
const minuteText = process.argv[4] || "09:15"
const start = Date.parse(`${date}T${minuteText}:00+05:30`)
const end = start + 60_000
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const median = (values) => {
  if (!values.length) return NaN
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function parse(filename) {
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function book(data) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bid = { price: Number(data?.[`bid_price${level}`]), size: Number(data?.[`bid_size${level}`]), orders: Number(data?.[`bid_order${level}`]) }
    const ask = { price: Number(data?.[`ask_price${level}`]), size: Number(data?.[`ask_size${level}`]), orders: Number(data?.[`ask_order${level}`]) }
    if (![bid.price, bid.size, ask.price, ask.size].every(Number.isFinite) || bid.price <= 0 || ask.price <= bid.price) return null
    bids.push(bid); asks.push(ask)
  }
  const bidSize = bids.reduce((sum, row) => sum + row.size, 0), askSize = asks.reduce((sum, row) => sum + row.size, 0)
  const bidOrders = bids.reduce((sum, row) => sum + (Number.isFinite(row.orders) ? row.orders : 0), 0)
  const askOrders = asks.reduce((sum, row) => sum + (Number.isFinite(row.orders) ? row.orders : 0), 0)
  const dominant = bids.map((bid, index) => bid.size >= 5 && bid.size >= 1.5 * Math.max(1, asks[index].size))
  const longest = (values) => { let run = 0, best = 0; for (const value of values) { run = value ? run + 1 : 0; best = Math.max(best, run) } return best }
  return { bids, asks, bestBid: bids[0].price, bestAsk: asks[0].price, bid1: bids[0].size, ask1: asks[0].size,
    bidShare: 100 * bidSize / (bidSize + askSize), top2BidShare: 100 * (bids[0].size + bids[1].size) /
      (bids[0].size + bids[1].size + asks[0].size + asks[1].size),
    bidOrderShare: bidOrders + askOrders > 0 ? 100 * bidOrders / (bidOrders + askOrders) : NaN,
    bidSize, askSize, spread: asks[0].price - bids[0].price, mid: (asks[0].price + bids[0].price) / 2,
    stackedBid: longest(dominant) >= 3 }
}

const depthFile = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
const records = parse(depthFile).filter((row) => {
  const at = Date.parse(row.receivedAt)
  return at >= start && at < end
})
const samples = records.flatMap((record) => {
  const at = Date.parse(record.receivedAt), current = book(record.data)
  const price = Number(record.marketContext?.price), volume = Number(record.marketContext?.cumulativeVolume)
  return current && Number.isFinite(price) && Number.isFinite(volume) ? [{ at, price, volume, book: current }] : []
})
let tradedVolume = 0, signedVolume = 0, lastDirection = 0
const ofis = []
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
}
const gaps = samples.slice(1).map((row, index) => (row.at - samples[index].at) / 1000)

const token = String(getFromStorage("token") || "").trim()
let candle = null
if (token) {
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId); client.setAccessToken(token)
  const response = await client.getHistory({ symbol: `NSE:${symbol}-EQ`, resolution: "1", date_format: "1",
    range_from: date, range_to: date, cont_flag: "1" })
  const item = response?.candles?.find((row) => Number(row[0]) * 1000 === start)
  if (item) candle = { open: Number(item[1]), high: Number(item[2]), low: Number(item[3]), close: Number(item[4]), volume: Number(item[5]) }
}

const report = {
  symbol, date, minute: minuteText, rawDepthObjects: records.length, validFiveLevelUpdates: samples.length,
  firstUpdate: samples[0]?.at ? new Date(samples[0].at).toISOString() : null,
  lastUpdate: samples.at(-1)?.at ? new Date(samples.at(-1).at).toISOString() : null,
  secondsMissingAtOpen: samples.length ? (samples[0].at - start) / 1000 : null,
  capturedSeconds: samples.length ? (samples.at(-1).at - samples[0].at) / 1000 : null,
  updatesPerCapturedSecond: samples.length > 1 ? (samples.length - 1) / ((samples.at(-1).at - samples[0].at) / 1000) : null,
  averageGapSeconds: mean(gaps), medianGapSeconds: median(gaps), maximumGapSeconds: gaps.length ? Math.max(...gaps) : null,
  candle: candle ? { ...candle, returnPct: pct(candle.close, candle.open),
    closeLocationPct: candle.high > candle.low ? 100 * (candle.close - candle.low) / (candle.high - candle.low) : 50 } : null,
  observedPrice: samples.length ? { first: samples[0].price, last: samples.at(-1).price,
    low: Math.min(...samples.map((row) => row.price)), high: Math.max(...samples.map((row) => row.price)),
    returnPct: pct(samples.at(-1).price, samples[0].price) } : null,
  capturedCumulativeVolumeIncrease: samples.length ? samples.at(-1).volume - samples[0].volume : null,
  capturedVolumePctOfCandle: candle && samples.length ? 100 * (samples.at(-1).volume - samples[0].volume) / candle.volume : null,
  estimatedDeltaPct: tradedVolume > 0 ? 100 * signedVolume / tradedVolume : null,
  averageBidSharePct: mean(samples.map((row) => row.book.bidShare)),
  startingBidSharePct: samples[0]?.book.bidShare, endingBidSharePct: samples.at(-1)?.book.bidShare,
  averageTop2BidSharePct: mean(samples.map((row) => row.book.top2BidShare)),
  averageBidOrderSharePct: mean(samples.map((row) => row.book.bidOrderShare)),
  bidDominantUpdatesPct: samples.length ? 100 * samples.filter((row) => row.book.bidShare > 50).length / samples.length : null,
  strongBidUpdatesPct: samples.length ? 100 * samples.filter((row) => row.book.bidShare >= 55).length / samples.length : null,
  stackedBidUpdatesPct: samples.length ? 100 * samples.filter((row) => row.book.stackedBid).length / samples.length : null,
  normalizedOfi: mean(ofis), averageSpreadBps: mean(samples.map((row) => 10_000 * row.book.spread / row.book.mid)),
  startingSpreadBps: samples[0] ? 10_000 * samples[0].book.spread / samples[0].book.mid : null,
  endingSpreadBps: samples.at(-1) ? 10_000 * samples.at(-1).book.spread / samples.at(-1).book.mid : null,
}
console.log(JSON.stringify(report, (key, value) => typeof value === "number" ? round(value, ["normalizedOfi"].includes(key) ? 4 : 2) : value, 2))
