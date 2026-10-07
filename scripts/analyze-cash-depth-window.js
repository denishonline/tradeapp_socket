import fs from "node:fs"
import path from "node:path"

const [symbol = "NAUKRI", date = "2026-10-06"] = process.argv.slice(2)
const root = process.cwd()
const depthFile = path.join(root, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
const candleFile = path.join(root, "db", "candles", `${symbol}.jsonl`)
const at = (time) => Date.parse(`${date}T${time}:00+05:30`)
const from = at("09:20")
const split = at("11:30")
const until = at("11:37")
const minuteKey = (timestamp) => new Date(timestamp + 330 * 60_000).toISOString().slice(11, 16)
const round = (value, places = 3) => Number.isFinite(value) ? Number(value.toFixed(places)) : null
const average = (rows, field) => rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : null
const median = (numbers) => numbers.length ? numbers.slice().sort((a, b) => a - b)[Math.floor(numbers.length / 2)] : null

const candlesByTime = new Map()
for (const line of fs.readFileSync(candleFile, "utf8").split(/\r?\n/)) {
  if (!line) continue
  const row = JSON.parse(line)
  const timestamp = Number(row.time) * 1000
  if (timestamp >= from - 10 * 60_000 && timestamp < at("15:30")) candlesByTime.set(timestamp, row)
}
const candles = [...candlesByTime].sort((a, b) => a[0] - b[0]).map(([timestamp, row]) => ({
  timestamp, open: Number(row.open), high: Number(row.high), low: Number(row.low),
  close: Number(row.close), volume: Number(row.volume), source: row.source,
}))

const depth = []
let previous = null
let invalid = 0
for (const line of fs.readFileSync(depthFile, "utf8").split(/\r?\n/)) {
  if (!line) continue
  const record = JSON.parse(line)
  const timestamp = Date.parse(record.receivedAt)
  if (timestamp < from || timestamp >= until) continue
  const book = record.data
  const bid = Array.from({ length: 5 }, (_, index) => Number(book[`bid_size${index + 1}`]))
  const ask = Array.from({ length: 5 }, (_, index) => Number(book[`ask_size${index + 1}`]))
  const bestBid = Number(book.bid_price1)
  const bestAsk = Number(book.ask_price1)
  if (![...bid, ...ask, bestBid, bestAsk].every(Number.isFinite) || bestBid <= 0 || bestAsk <= bestBid) {
    invalid++
    continue
  }
  const bidSum = bid.reduce((sum, value) => sum + value, 0)
  const askSum = ask.reduce((sum, value) => sum + value, 0)
  const bid2 = bid[0] + bid[1]
  const ask2 = ask[0] + ask[1]
  const full = (bidSum - askSum) / (bidSum + askSum || 1)
  const top2 = (bid2 - ask2) / (bid2 + ask2 || 1)
  const ofi = previous && timestamp - previous.timestamp <= 90_000
    ? (bestBid >= previous.bestBid ? bid[0] : 0) -
      (bestBid <= previous.bestBid ? previous.bid1 : 0) -
      (bestAsk <= previous.bestAsk ? ask[0] : 0) +
      (bestAsk >= previous.bestAsk ? previous.ask1 : 0)
    : 0
  const ofiDepth = previous && timestamp - previous.timestamp <= 90_000
    ? (bid[0] + ask[0] + previous.bid1 + previous.ask1) / 2 : 0
  depth.push({ timestamp, full, top2, bidSum, askSum, bid2, ask2, bestBid, bestAsk,
    bid1: bid[0], ask1: ask[0], spreadBps: (bestAsk / bestBid - 1) * 10_000,
    ofi, ofiDepth, price: Number(record.marketContext?.price),
    priceAt: Date.parse(record.marketContext?.priceAt), cumulativeVolume: Number(record.marketContext?.cumulativeVolume) })
  previous = { timestamp, bestBid, bestAsk, bid1: bid[0], ask1: ask[0] }
}

function summary(label, start, end) {
  const bars = candles.filter((row) => row.timestamp >= start && row.timestamp < end)
  const books = depth.filter((row) => row.timestamp >= start && row.timestamp < end)
  const minuteGroups = new Map()
  for (const row of books) {
    const key = Math.floor(row.timestamp / 60_000)
    if (!minuteGroups.has(key)) minuteGroups.set(key, [])
    minuteGroups.get(key).push(row)
  }
  const minuteMean = [...minuteGroups.values()].map((rows) => ({
    full: average(rows, "full"), top2: average(rows, "top2"), spreadBps: average(rows, "spreadBps"),
  }))
  const ofi = books.reduce((sum, row) => sum + row.ofi, 0)
  const ofiDepth = books.reduce((sum, row) => sum + row.ofiDepth, 0)
  return { period: label, candles: bars.length, updates: books.length, depthMinutes: minuteGroups.size,
    open: bars[0]?.open, close: bars.at(-1)?.close,
    returnPct: bars.length ? round((bars.at(-1).close / bars[0].open - 1) * 100) : null,
    high: bars.length ? Math.max(...bars.map((row) => row.high)) : null,
    low: bars.length ? Math.min(...bars.map((row) => row.low)) : null,
    volume: bars.reduce((sum, row) => sum + row.volume, 0),
    avgVolumePerCandle: round(average(bars, "volume"), 0),
    medianVolume: median(bars.map((row) => row.volume)),
    meanFull: round(average(minuteMean, "full")), meanTop2: round(average(minuteMean, "top2")),
    sellHeavyPct: round(minuteMean.filter((row) => row.full <= -0.2).length / (minuteMean.length || 1) * 100, 1),
    bidHeavyPct: round(minuteMean.filter((row) => row.full >= 0.2).length / (minuteMean.length || 1) * 100, 1),
    ofi: round(ofi / (ofiDepth || 1)), spreadBps: round(average(minuteMean, "spreadBps"), 1),
  }
}

console.log(`${symbol} ${date} IST | invalid depth books: ${invalid}`)
console.table([
  summary("09:20–11:30", from, split),
  summary("09:20–09:50", from, at("09:50")),
  summary("09:50–10:20", at("09:50"), at("10:20")),
  summary("10:20–10:50", at("10:20"), at("10:50")),
  summary("10:50–11:20", at("10:50"), at("11:20")),
  summary("11:20–11:30", at("11:20"), split),
  summary("11:25–11:30", at("11:25"), split),
  summary("11:30–11:35", split, at("11:35")),
  summary("11:35–11:37", at("11:35"), until),
  summary("11:30–11:37", split, until),
])
const rows = []
for (let timestamp = at("11:20"); timestamp < until; timestamp += 60_000) {
  const bar = candles.find((row) => row.timestamp === timestamp)
  const books = depth.filter((row) => row.timestamp >= timestamp && row.timestamp < timestamp + 60_000)
  const ofi = books.reduce((sum, row) => sum + row.ofi, 0)
  const ofiDepth = books.reduce((sum, row) => sum + row.ofiDepth, 0)
  rows.push({ minute: minuteKey(timestamp), open: bar?.open, high: bar?.high, low: bar?.low, close: bar?.close,
    volume: bar?.volume, updates: books.length, full: round(average(books, "full")),
    top2: round(average(books, "top2")), ofi: round(ofi / (ofiDepth || 1)),
    spreadBps: round(average(books, "spreadBps"), 1),
    bidSize: round(average(books, "bidSum"), 0), askSize: round(average(books, "askSum"), 0),
    priceContext: books.at(-1)?.price,
  })
}
console.table(rows)
const activity = []
for (let timestamp = at("11:25"); timestamp < until; timestamp += 60_000) {
  const books = depth.filter((row) => row.timestamp >= timestamp && row.timestamp < timestamp + 60_000)
  const quotedPrices = new Set(books.map((row) => `${row.bestBid}:${row.bestAsk}`))
  const priceTimes = new Set(books.filter((row) => Number.isFinite(row.priceAt)).map((row) => row.priceAt))
  const signFlips = books.slice(1).filter((row, index) => (row.full > 0) !== (books[index].full > 0)).length
  activity.push({ minute: minuteKey(timestamp), updates: books.length,
    priceTicksSeen: priceTimes.size, quotePairs: quotedPrices.size, signFlips,
    firstBid: books[0]?.bestBid, lastBid: books.at(-1)?.bestBid,
    firstAsk: books[0]?.bestAsk, lastAsk: books.at(-1)?.bestAsk,
    firstVolume: books[0]?.cumulativeVolume, lastVolume: books.at(-1)?.cumulativeVolume,
    maxSpreadBps: round(Math.max(...books.map((row) => row.spreadBps)), 1),
    negativeTop2Pct: round(books.filter((row) => row.top2 < 0).length / (books.length || 1) * 100, 1) })
}
console.log("Depth activity from 11:25:")
console.table(activity)
const volumeChanges = []
for (let index = 1; index < depth.length; index++) {
  const previous = depth[index - 1]
  const current = depth[index]
  if (!Number.isFinite(current.cumulativeVolume) || !Number.isFinite(previous.cumulativeVolume)) continue
  const increase = current.cumulativeVolume - previous.cumulativeVolume
  if (increase <= 0) continue
  volumeChanges.push({ at: new Date(current.timestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
    increase, cumulativeVolume: current.cumulativeVolume, price: current.price,
    priceAt: Number.isFinite(current.priceAt) ? new Date(current.priceAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : null,
    bid: current.bestBid, ask: current.bestAsk, bidSize: current.bid1, askSize: current.ask1,
    full: round(current.full), top2: round(current.top2) })
}
console.log("Largest cumulative-volume changes observed in depth context:")
console.table(volumeChanges.sort((a, b) => b.increase - a.increase).slice(0, 12))
const crossings = []
for (const level of [1207, 1208, 1209, 1210, 1211, 1212]) {
  const row = depth.find((item) => item.timestamp >= split && item.price >= level)
  if (!row) continue
  crossings.push({ level, received: new Date(row.timestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
    priceAt: new Date(row.priceAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
    price: row.price, cumulativeVolume: row.cumulativeVolume, bid: row.bestBid, ask: row.bestAsk,
    full: round(row.full), top2: round(row.top2) })
}
console.log("First observed price-context crossings after 11:30:")
console.table(crossings)
const jumpAt = at("11:32") + 46_000
console.log("Depth snapshots around the 11:32:46 volume jump:")
console.table(depth.filter((row) => row.timestamp >= jumpAt - 6000 && row.timestamp <= jumpAt + 6000)
  .map((row) => ({ received: new Date(row.timestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
    price: row.price, cumulativeVolume: row.cumulativeVolume, bid: row.bestBid, ask: row.bestAsk,
    bid1: row.bid1, ask1: row.ask1, full: round(row.full), top2: round(row.top2) })))
const secondJumpAt = at("11:35") + 36_000
console.log("Depth snapshots around the 11:35:36 volume jump:")
console.table(depth.filter((row) => row.timestamp >= secondJumpAt - 6000 && row.timestamp <= secondJumpAt + 6000)
  .map((row) => ({ received: new Date(row.timestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
    price: row.price, cumulativeVolume: row.cumulativeVolume, bid: row.bestBid, ask: row.bestAsk,
    bid1: row.bid1, ask1: row.ask1, full: round(row.full), top2: round(row.top2) })))
const later = candles.filter((row) => row.timestamp >= until)
if (later.length) {
  const peak = later.reduce((best, row) => row.high > best.high ? row : best)
  console.log("Later observed candles:", { count: later.length,
    lastMinute: minuteKey(later.at(-1).timestamp), lastClose: later.at(-1).close,
    peakMinute: minuteKey(peak.timestamp), peakHigh: peak.high,
    peakFrom1130Pct: round((peak.high / 1206.4 - 1) * 100) })
}
