import fs from "node:fs"
import readline from "node:readline"
import path from "node:path"
import { depthUpdateFields } from "../ui/market-depth.js"

const date = process.argv[2] || "2026-10-06"
const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth", date)
const minute = 60_000
const at = (clock) => Date.parse(`${date}T${clock}:00+05:30`)
const candleCutoff = at("09:32")
const depthCutoff = at("09:33")
const pct = (current, base) => base > 0 ? (current / base - 1) * 100 : NaN
const mean = (rows, field) => rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : NaN
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function readCandles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const byMinute = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const candle = JSON.parse(line)
    const timestamp = Number(candle.time) * 1000
    if (timestamp >= at("09:15") && timestamp < candleCutoff) {
      byMinute.set(timestamp, { timestamp, open: Number(candle.open), high: Number(candle.high),
        low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume) })
    }
  }
  const rows = [...byMinute.values()].sort((a, b) => a.timestamp - b.timestamp)
  if (!rows.length) return null
  const last5 = rows.filter((row) => row.timestamp >= at("09:27"))
  const prior10 = rows.filter((row) => row.timestamp >= at("09:17") && row.timestamp < at("09:27"))
  const last = rows.at(-1)
  return { candles: rows.length, lastCandle: new Date(last.timestamp + 330 * minute).toISOString().slice(11, 16),
    close: last.close, open: rows[0].open, returnOpen: pct(last.close, rows[0].open),
    last5Return: last5.length ? pct(last.close, last5[0].open) : NaN,
    last5Volume: last5.reduce((sum, row) => sum + row.volume, 0),
    volumeRamp: mean(last5, "volume") / mean(prior10, "volume"),
    prior10HighBreak: pct(last.close, Math.max(...prior10.map((row) => row.high))),
    last5Bars: last5.length, prior10Bars: prior10.length,
  }
}

async function readDepth(symbol) {
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  const minutes = new Map()
  if (!fs.existsSync(file)) return minutes
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let fields = {}
  let previous = null
  for await (const line of lines) {
    if (!line) continue
    const record = JSON.parse(line)
    const timestamp = Date.parse(record.receivedAt)
    if (timestamp >= depthCutoff) { lines.close(); break }
    const update = depthUpdateFields(record.data)
    if (!update) continue
    if (previous && timestamp - previous.timestamp > 90_000) { fields = {}; previous = null }
    for (const [key, value] of update) fields[key] = value
    const bids = Array.from({ length: 5 }, (_, index) => Number(fields[`bid_size${index + 1}`]))
    const asks = Array.from({ length: 5 }, (_, index) => Number(fields[`ask_size${index + 1}`]))
    const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
    if (![...bids, ...asks, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= bid) continue
    const bidSum = bids.reduce((sum, value) => sum + value, 0)
    const askSum = asks.reduce((sum, value) => sum + value, 0)
    const bid2 = bids[0] + bids[1], ask2 = asks[0] + asks[1]
    const ofi = previous ? (bid >= previous.bid ? bids[0] : 0) -
      (bid <= previous.bid ? previous.bid1 : 0) -
      (ask <= previous.ask ? asks[0] : 0) + (ask >= previous.ask ? previous.ask1 : 0) : 0
    const ofiDepth = previous ? (bids[0] + asks[0] + previous.bid1 + previous.ask1) / 2 : 0
    const key = Math.floor(timestamp / minute) * minute
    const bucket = minutes.get(key) || { count: 0, full: 0, top2: 0, ofi: 0,
      ofiDepth: 0, firstBid: bid, lastBid: bid }
    bucket.count++
    bucket.full += (bidSum - askSum) / (bidSum + askSum || 1)
    bucket.top2 += (bid2 - ask2) / (bid2 + ask2 || 1)
    bucket.ofi += ofi
    bucket.ofiDepth += ofiDepth
    bucket.lastBid = bid
    minutes.set(key, bucket)
    previous = { timestamp, bid, ask, bid1: bids[0], ask1: asks[0] }
  }
  return minutes
}

function depthSummary(minutes, start, end) {
  const buckets = []
  for (let timestamp = at(start); timestamp < at(end); timestamp += minute) {
    const bucket = minutes.get(timestamp)
    if (bucket) buckets.push(bucket)
  }
  if (!buckets.length) return { minutes: 0 }
  const ofi = buckets.reduce((sum, row) => sum + row.ofi, 0)
  const ofiDepth = buckets.reduce((sum, row) => sum + row.ofiDepth, 0)
  return { minutes: buckets.length, updates: buckets.reduce((sum, row) => sum + row.count, 0),
    full: mean(buckets.map((row) => ({ value: row.full / row.count })), "value"),
    top2: mean(buckets.map((row) => ({ value: row.top2 / row.count })), "value"),
    flow: ofi / (ofiDepth || 1),
    bidMove: pct(buckets.at(-1).lastBid, buckets[0].firstBid),
  }
}

const symbols = fs.readdirSync(depthRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
const rows = []
for (const symbol of symbols) {
  const candle = readCandles(symbol)
  if (!candle) continue
  const depth = await readDepth(symbol)
  rows.push({ symbol, ...candle, d3: depthSummary(depth, "09:30", "09:33"),
    d5: depthSummary(depth, "09:28", "09:33"),
    at0932: depthSummary(depth, "09:32", "09:33") })
}
const eligible = rows.filter((row) => row.last5Bars >= 4 && row.prior10Bars >= 8 && row.d3.minutes === 3)
const pgel = eligible.find((row) => row.symbol === "PGEL")
if (!pgel) throw new Error("PGEL missing from eligible stocks")
console.log(`${date} around 09:32: ${rows.length} stocks; ${eligible.length} have comparable completed candles and depth`)
console.log("PGEL:", JSON.stringify(pgel, null, 2))
console.log("Cross-sectional ranks, 1 = highest:")
console.table([
  ["Return from open through 09:31", (row) => row.returnOpen],
  ["Five completed candle return", (row) => row.last5Return],
  ["Five candle volume / preceding ten", (row) => row.volumeRamp],
  ["Close above preceding ten candle high", (row) => row.prior10HighBreak],
  ["09:32 full-book imbalance", (row) => row.at0932.full],
  ["09:32 top-two imbalance", (row) => row.at0932.top2],
  ["09:32 quote flow", (row) => row.at0932.flow],
  ["09:30-09:32 best bid move", (row) => row.d3.bidMove],
].map(([feature, get]) => ({ feature, pgel: round(get(pgel)),
  rank: 1 + eligible.filter((row) => get(row) > get(pgel)).length, eligible: eligible.length })))

const rules = {
  candleRise: (row) => row.last5Return >= 0.5,
  volumeExpansion: (row) => row.volumeRamp >= 1.5,
  priceBreakout: (row) => row.prior10HighBreak > 0,
  currentBidBook: (row) => row.at0932.full >= 0.2 && row.at0932.top2 >= 0.2,
  currentBuyerFlow: (row) => row.at0932.flow > 0,
  risingBid3: (row) => row.d3.bidMove >= 0.5,
}
console.log("Broad condition counts:")
console.table(Object.entries(rules).map(([name, test]) => ({ name, pgel: test(pgel),
  stocks: eligible.filter(test).length })))
const candleMatches = eligible.filter((row) => rules.candleRise(row) && rules.volumeExpansion(row) &&
  rules.priceBreakout(row))
const allMatches = candleMatches.filter((row) => rules.currentBidBook(row) &&
  rules.currentBuyerFlow(row) && rules.risingBid3(row))
console.log(`Candle matches: ${candleMatches.length}; combined candle and depth matches: ${allMatches.length}`)
console.table(candleMatches.map((row) => ({ symbol: row.symbol, return5: round(row.last5Return),
  volumeRamp: round(row.volumeRamp), priceBreakout: round(row.prior10HighBreak),
  full0932: round(row.at0932.full), top2_0932: round(row.at0932.top2),
  flow0932: round(row.at0932.flow), bidMove3: round(row.d3.bidMove) })))
