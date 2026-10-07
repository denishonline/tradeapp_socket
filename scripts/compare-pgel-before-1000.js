import fs from "node:fs"
import readline from "node:readline"
import path from "node:path"
import { depthUpdateFields } from "../ui/market-depth.js"

const date = process.argv[2] || "2026-10-06"
const cutoffTime = process.argv[3] || "10:00"
const cutoff = Date.parse(`${date}T${cutoffTime}:00+05:30`)
const morningStart = Date.parse(`${date}T09:15:00+05:30`)
const formatTime = (timestamp) => new Date(timestamp + 330 * 60_000).toISOString().slice(11, 16)
const round = (number, digits = 3) => Number.isFinite(number) ? Number(number.toFixed(digits)) : null
const mean = (items, key) => items.length ? items.reduce((sum, item) => sum + item[key], 0) / items.length : null
const pct = (next, prior) => prior > 0 ? (next / prior - 1) * 100 : null
const depthDirectory = path.join(process.cwd(), "db", "cash-depth", date)
const symbols = fs.readdirSync(depthDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

function candleFeatures(symbol) {
  const file = path.join(process.cwd(), "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const byTime = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const row = JSON.parse(line)
    const timestamp = Number(row.time) * 1000
    if (timestamp >= morningStart && timestamp < cutoff) byTime.set(timestamp, row)
  }
  const rows = [...byTime].sort((a, b) => a[0] - b[0]).map(([timestamp, candle]) => ({
    timestamp, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low),
    close: Number(candle.close), volume: Number(candle.volume),
  }))
  const previous30 = rows.filter((row) => row.timestamp < cutoff - 15 * 60_000)
  const recent15 = rows.filter((row) => row.timestamp >= cutoff - 15 * 60_000)
  const recent5 = rows.filter((row) => row.timestamp >= cutoff - 5 * 60_000)
  if (!rows.length || !recent15.length || !previous30.length) return null
  const last = rows.at(-1)
  const recentVolume = mean(recent15, "volume")
  const olderVolume = mean(previous30, "volume")
  return {
    candles: rows.length,
    lastCandle: formatTime(last.timestamp),
    open: rows[0].open, close: last.close,
    returnOpenPct: pct(last.close, rows[0].open),
    return15Pct: pct(last.close, recent15[0].open),
    return5Pct: pct(last.close, recent5[0]?.open),
    volumeRamp: recentVolume / (olderVolume || 1),
    volumeLast15: recent15.reduce((sum, row) => sum + row.volume, 0),
    breakoutAbovePrior30HighPct: pct(last.close, Math.max(...previous30.map((row) => row.high))),
    recent15Bars: recent15.length,
    recent15HighVolumeBars: recent15.filter((row) => row.volume >= olderVolume).length,
  }
}

async function depthFeatures(symbol) {
  const file = path.join(depthDirectory, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  const fields = {}
  let previous = null
  const buckets = new Map()
  for await (const line of lines) {
    if (!line) continue
    const record = JSON.parse(line)
    const at = Date.parse(record.receivedAt)
    if (at >= cutoff) { lines.close(); break }
    const update = depthUpdateFields(record.data)
    if (!update) continue
    for (const [key, value] of update) fields[key] = value
    const bids = Array.from({ length: 5 }, (_, index) => Number(fields[`bid_size${index + 1}`]))
    const asks = Array.from({ length: 5 }, (_, index) => Number(fields[`ask_size${index + 1}`]))
    const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
    if (![...bids, ...asks, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= bid) continue
    const bidSum = bids.reduce((sum, value) => sum + value, 0)
    const askSum = asks.reduce((sum, value) => sum + value, 0)
    const bid2 = bids[0] + bids[1], ask2 = asks[0] + asks[1]
    const validPrevious = previous && at - previous.at <= 90_000 ? previous : null
    const ofi = validPrevious
      ? (bid >= validPrevious.bid ? bids[0] : 0) - (bid <= validPrevious.bid ? validPrevious.bid1 : 0) -
        (ask <= validPrevious.ask ? asks[0] : 0) + (ask >= validPrevious.ask ? validPrevious.ask1 : 0)
      : 0
    const ofiDepth = validPrevious ? (bids[0] + asks[0] + validPrevious.bid1 + validPrevious.ask1) / 2 : 0
    const minute = Math.floor(at / 60_000) * 60_000
    const bucket = buckets.get(minute) || { minute, count: 0, full: 0, top2: 0, ofi: 0, ofiDepth: 0,
      firstBid: bid, lastBid: bid, firstAsk: ask, lastAsk: ask }
    bucket.count++
    bucket.full += (bidSum - askSum) / (bidSum + askSum || 1)
    bucket.top2 += (bid2 - ask2) / (bid2 + ask2 || 1)
    bucket.ofi += ofi
    bucket.ofiDepth += ofiDepth
    bucket.lastBid = bid
    bucket.lastAsk = ask
    buckets.set(minute, bucket)
    previous = { at, bid, ask, bid1: bids[0], ask1: asks[0] }
  }
  const rows = [...buckets.values()].sort((a, b) => a.minute - b.minute)
  const summarize = (minutes) => {
    const items = rows.filter((row) => row.minute >= cutoff - minutes * 60_000)
    if (!items.length) return { minutes: 0 }
    const averages = items.map((row) => ({ full: row.full / row.count, top2: row.top2 / row.count }))
    const ofi = items.reduce((sum, row) => sum + row.ofi, 0)
    const ofiDepth = items.reduce((sum, row) => sum + row.ofiDepth, 0)
    return { minutes: items.length, updates: items.reduce((sum, row) => sum + row.count, 0),
      full: mean(averages, "full"), top2: mean(averages, "top2"),
      flow: ofi / (ofiDepth || 1), bidMovePct: pct(items.at(-1).lastBid, items[0].firstBid),
      positiveFullPct: items.filter((row) => row.full / row.count > 0).length / items.length * 100,
      positiveTop2Pct: items.filter((row) => row.top2 / row.count > 0).length / items.length * 100,
    }
  }
  return { d5: summarize(5), d15: summarize(15), d30: summarize(30), d45: summarize(45) }
}

const records = []
for (const symbol of symbols) {
  const candles = candleFeatures(symbol)
  if (!candles) continue
  const depth = await depthFeatures(symbol)
  records.push({ symbol, ...candles, ...depth })
}
const pgel = records.find((row) => row.symbol === "PGEL")
if (!pgel) throw new Error("PGEL has no usable before-10:00 data")
const eligible = records.filter((row) => row.candles >= 35 && row.recent15Bars >= 12 && row.d15?.minutes >= 12)
const conditions = {
  candleImpulse: (row) => row.return15Pct >= 1,
  volumeExpansion: (row) => row.volumeRamp >= 3,
  prior30Breakout: (row) => row.breakoutAbovePrior30HighPct > 0,
  supportiveRecentBook: (row) => row.d5?.full >= 0.15 && row.d5?.top2 >= 0.15,
  activeRecentQuotes: (row) => row.d5?.flow > 0 && row.d5?.bidMovePct > 0,
}
const flagNames = Object.keys(conditions)
console.log(`${date} at ${cutoffTime} IST: ${records.length} stocks, ${eligible.length} with comparable candle and depth coverage`)
console.log("PGEL:", JSON.stringify(pgel, null, 2))
console.log("PGEL cross-sectional ranks (1 = highest):")
console.table([
  ["45-minute return", (row) => row.returnOpenPct],
  ["15-minute return", (row) => row.return15Pct],
  ["15-minute volume / prior 30-minute volume", (row) => row.volumeRamp],
  ["Breakout above prior 30-minute high", (row) => row.breakoutAbovePrior30HighPct],
  ["5-minute full-book imbalance", (row) => row.d5?.full],
  ["5-minute top-two imbalance", (row) => row.d5?.top2],
  ["5-minute quote flow", (row) => row.d5?.flow],
].map(([feature, value]) => ({ feature,
  pgelValue: round(value(pgel)), rank: 1 + eligible.filter((row) => value(row) > value(pgel)).length,
  eligible: eligible.length })))
console.log("Broad filter counts and PGEL status:")
console.table(flagNames.map((name) => ({ condition: name,
  pgel: conditions[name](pgel), stocks: eligible.filter(conditions[name]).length })))
const candleCandidates = eligible.filter((row) => conditions.candleImpulse(row) &&
  conditions.volumeExpansion(row) && conditions.prior30Breakout(row))
const allCandidates = candleCandidates.filter((row) => conditions.supportiveRecentBook(row) &&
  conditions.activeRecentQuotes(row))
console.log(`Candle combination: ${candleCandidates.length} stocks; candle + depth combination: ${allCandidates.length} stocks`)
console.table(candleCandidates.map((row) => ({ symbol: row.symbol,
  returnOpenPct: round(row.returnOpenPct), return15Pct: round(row.return15Pct),
  volumeRamp: round(row.volumeRamp), breakoutPct: round(row.breakoutAbovePrior30HighPct),
  full5: round(row.d5.full), top2_5: round(row.d5.top2), flow5: round(row.d5.flow),
  bidMove5Pct: round(row.d5.bidMovePct) })))
console.log("Closest peers by morning price momentum (top ten):")
console.table(eligible.filter((row) => row.symbol !== "PGEL")
  .sort((a, b) => Math.abs(a.return15Pct - pgel.return15Pct) - Math.abs(b.return15Pct - pgel.return15Pct))
  .slice(0, 10).map((row) => ({ symbol: row.symbol, return15Pct: round(row.return15Pct),
    volumeRamp: round(row.volumeRamp), full5: round(row.d5.full), top2_5: round(row.d5.top2),
    flow5: round(row.d5.flow), bidMove5Pct: round(row.d5.bidMovePct) })))
