import fs from "node:fs"
import readline from "node:readline"
import path from "node:path"
import { depthUpdateFields } from "../ui/market-depth.js"

const date = process.argv[2] || "2026-10-06"
const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth", date)
const sessionStart = Date.parse(`${date}T09:15:00+05:30`)
const sessionEnd = Date.parse(`${date}T15:15:00+05:30`)
const minute = 60_000
const fmt = (ms) => new Date(ms + 330 * minute).toISOString().slice(11, 16)
const pct = (current, base) => base > 0 ? (current / base - 1) * 100 : NaN
const mean = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function readCandles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const byTime = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    const candle = JSON.parse(line)
    const at = Number(candle.time) * 1000
    if (at < sessionStart || at >= sessionEnd) continue
    byTime.set(at, { at, open: Number(candle.open), high: Number(candle.high),
      low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume) })
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at)
}

async function readDepthMinutes(symbol) {
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  const buckets = new Map()
  if (!fs.existsSync(file)) return buckets
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let fields = {}
  let previous = null
  for await (const line of lines) {
    if (!line) continue
    const record = JSON.parse(line)
    const at = Date.parse(record.receivedAt)
    if (at < sessionStart) continue
    if (at >= sessionEnd) { lines.close(); break }
    const update = depthUpdateFields(record.data)
    if (!update) continue
    if (previous && at - previous.at > 90_000) { fields = {}; previous = null }
    for (const [key, value] of update) fields[key] = value
    const bidSizes = Array.from({ length: 5 }, (_, index) => Number(fields[`bid_size${index + 1}`]))
    const askSizes = Array.from({ length: 5 }, (_, index) => Number(fields[`ask_size${index + 1}`]))
    const bid = Number(fields.bid_price1), ask = Number(fields.ask_price1)
    if (![...bidSizes, ...askSizes, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= bid) continue
    const bidSum = bidSizes.reduce((sum, value) => sum + value, 0)
    const askSum = askSizes.reduce((sum, value) => sum + value, 0)
    const bid2 = bidSizes[0] + bidSizes[1], ask2 = askSizes[0] + askSizes[1]
    const ofi = previous
      ? (bid >= previous.bid ? bidSizes[0] : 0) - (bid <= previous.bid ? previous.bid1 : 0) -
        (ask <= previous.ask ? askSizes[0] : 0) + (ask >= previous.ask ? previous.ask1 : 0)
      : 0
    const ofiDepth = previous ? (bidSizes[0] + askSizes[0] + previous.bid1 + previous.ask1) / 2 : 0
    const key = Math.floor(at / minute) * minute
    const bucket = buckets.get(key) || { count: 0, fullSum: 0, top2Sum: 0,
      ofiSum: 0, ofiDepthSum: 0, firstBid: bid, lastBid: bid, lastAsk: ask }
    bucket.count++
    bucket.fullSum += (bidSum - askSum) / (bidSum + askSum || 1)
    bucket.top2Sum += (bid2 - ask2) / (bid2 + ask2 || 1)
    bucket.ofiSum += ofi
    bucket.ofiDepthSum += ofiDepth
    bucket.lastBid = bid
    bucket.lastAsk = ask
    buckets.set(key, bucket)
    previous = { at, bid, ask, bid1: bidSizes[0], ask1: askSizes[0] }
  }
  return buckets
}

function firstTouch(candles, index) {
  const entry = candles[index].close
  const target = entry * 1.03
  const stop = entry * 0.995
  for (const candle of candles.slice(index + 1)) {
    if (candle.low <= stop) return { result: "Stopped", resolvedAt: fmt(candle.at) }
    if (candle.high >= target) return { result: "Target +3%", resolvedAt: fmt(candle.at) }
  }
  return { result: "Unresolved", resolvedAt: null }
}

function scanStock(symbol, candles, depth) {
  const matches = []
  for (let index = 0; index < candles.length; index++) {
    const last = candles[index]
    const cutoff = last.at + minute
    if (cutoff < Date.parse(`${date}T09:59:00+05:30`)) continue
    const recent15 = candles.filter((row) => row.at >= cutoff - 15 * minute && row.at < cutoff)
    const previous30 = candles.filter((row) => row.at >= cutoff - 45 * minute && row.at < cutoff - 15 * minute)
    if (recent15.length < 12 || previous30.length < 25) continue
    const return15 = pct(last.close, recent15[0].open)
    const volumeRamp = mean(recent15, "volume") / (mean(previous30, "volume") || 1)
    const breakoutPct = pct(last.close, Math.max(...previous30.map((row) => row.high)))
    if (return15 < 1 || volumeRamp < 3 || breakoutPct <= 0) continue
    const books = []
    for (let at = cutoff - 5 * minute; at < cutoff; at += minute) {
      const book = depth.get(at)
      if (!book) break
      books.push(book)
    }
    if (books.length < 5) continue
    const full5 = mean(books.map((row) => ({ full: row.fullSum / row.count })), "full")
    const top2_5 = mean(books.map((row) => ({ top2: row.top2Sum / row.count })), "top2")
    const flow5 = books.reduce((sum, row) => sum + row.ofiSum, 0) /
      (books.reduce((sum, row) => sum + row.ofiDepthSum, 0) || 1)
    const bidMovePct = pct(books.at(-1).lastBid, books[0].firstBid)
    if (full5 < 0.15 || top2_5 < 0.15 || flow5 <= 0 || bidMovePct <= 0) continue
    matches.push({ symbol, at: fmt(cutoff), entry: last.close,
      return15: round(return15), volumeRamp: round(volumeRamp), breakoutPct: round(breakoutPct),
      full5: round(full5), top2_5: round(top2_5), flow5: round(flow5),
      bidMovePct: round(bidMovePct), ...firstTouch(candles, index) })
  }
  return matches
}

function proposedOutcome(candles, signalAt, entry) {
  const target = entry * 1.03
  const stop = entry * 0.995
  for (const candle of candles) {
    if (candle.at < signalAt) continue
    if (candle.low <= stop) return { result: "Stopped", resolvedAt: fmt(candle.at) }
    if (candle.high >= target) return { result: "Target +3%", resolvedAt: fmt(candle.at) }
  }
  return { result: "Unresolved", resolvedAt: null }
}

function scanProposedStock(symbol, candles, depth) {
  const signals = []
  let matchingMinutes = 0
  let candleIndex = -1
  let lastSignalAt = -Infinity
  for (const depthMinute of [...depth.keys()].sort((a, b) => a - b)) {
    const signalAt = depthMinute + minute
    while (candleIndex + 1 < candles.length && candles[candleIndex + 1].at + minute <= signalAt) candleIndex++
    if (candleIndex < 14) continue
    const last15 = candles.slice(candleIndex - 14, candleIndex + 1)
    const last = last15.at(-1)
    if (signalAt - (last.at + minute) > 2 * minute ||
        last15.some((row, index) => index > 0 && row.at !== last15[index - 1].at + minute)) continue
    const previous10 = last15.slice(0, 10)
    const recent5 = last15.slice(-5)
    const return5Pct = pct(last.close, recent5[0].open)
    const previousVolume = mean(previous10, "volume")
    const volumeMultiple = mean(recent5, "volume") / (previousVolume || 1)
    const elevatedVolumeBars = recent5.filter((row) => row.volume >= previousVolume).length
    const breakoutPct = pct(last.close, Math.max(...previous10.map((row) => row.high)))
    if (return5Pct < 0.5 || volumeMultiple < 1.5 || elevatedVolumeBars < 2 || breakoutPct <= 0) continue
    const books = []
    for (let offset = 4; offset >= 0; offset--) {
      const bucket = depth.get(depthMinute - offset * minute)
      if (!bucket || bucket.count < 3) break
      books.push(bucket)
    }
    if (books.length !== 5) continue
    const prior3Full = mean(books.slice(0, 3).map((row) => ({ value: row.fullSum / row.count })), "value")
    const prior3Top2 = mean(books.slice(0, 3).map((row) => ({ value: row.top2Sum / row.count })), "value")
    const latest2 = books.slice(-2)
    const latest2Full = mean(latest2.map((row) => ({ value: row.fullSum / row.count })), "value")
    const latest2Top2 = mean(latest2.map((row) => ({ value: row.top2Sum / row.count })), "value")
    if (latest2.some((row) => row.fullSum / row.count <= 0.15 || row.top2Sum / row.count <= 0.15) ||
        latest2Full - prior3Full < 0.2 || latest2Top2 - prior3Top2 < 0.2) continue
    const currentFlow = books.at(-1).ofiSum / (books.at(-1).ofiDepthSum || 1)
    const recentFlow = latest2.reduce((sum, row) => sum + row.ofiSum, 0) /
      (latest2.reduce((sum, row) => sum + row.ofiDepthSum, 0) || 1)
    const bidMovePct = pct(books.at(-1).lastBid, books[2].firstBid)
    if (currentFlow <= 0 || recentFlow <= 0 || bidMovePct < 0.25) continue
    const entryQuote = books.at(-1).lastAsk
    const quoteExtensionPct = pct(entryQuote, last.close)
    if (quoteExtensionPct > 0.5) continue
    matchingMinutes++
    if (signalAt - lastSignalAt < 30 * minute) continue
    lastSignalAt = signalAt
    signals.push({ symbol, signalAt: fmt(signalAt), entryQuote: round(entryQuote, 2),
      lastCandle: fmt(last.at), candleAgeMin: (signalAt - last.at - minute) / minute,
      return5Pct: round(return5Pct), volumeMultiple: round(volumeMultiple),
      elevatedVolumeBars, breakoutPct: round(breakoutPct),
      full2: round(latest2Full), top2_2: round(latest2Top2),
      fullAcceleration: round(latest2Full - prior3Full),
      top2Acceleration: round(latest2Top2 - prior3Top2),
      currentFlow: round(currentFlow), bidMovePct: round(bidMovePct),
      quoteExtensionPct: round(quoteExtensionPct), ...proposedOutcome(candles, signalAt, entryQuote) })
  }
  return { signals, matchingMinutes }
}

const symbols = fs.readdirSync(depthRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
if (process.argv.includes("--proposed")) {
  const signals = []
  let matchingMinutes = 0
  for (const symbol of symbols) {
    const result = scanProposedStock(symbol, readCandles(symbol), await readDepthMinutes(symbol))
    signals.push(...result.signals)
    matchingMinutes += result.matchingMinutes
  }
  signals.sort((a, b) => a.signalAt.localeCompare(b.signalAt) || a.symbol.localeCompare(b.symbol))
  console.log(`${date}: ${symbols.length} stocks, ${matchingMinutes} qualifying minutes, ${signals.length} signals after 30-minute per-stock cooldown`)
  console.log("Entry = last ask in completed depth minute; target +3%, stop -0.5%, stop wins a same-bar collision:")
  console.table(signals)
  console.log(Object.fromEntries(["Target +3%", "Stopped", "Unresolved"].map((result) =>
    [result, signals.filter((signal) => signal.result === result).length])))
  process.exit(0)
}
const matches = []
for (const symbol of symbols) {
  matches.push(...scanStock(symbol, readCandles(symbol), await readDepthMinutes(symbol)))
}
const firstByStock = new Map()
for (const item of matches) if (!firstByStock.has(item.symbol)) firstByStock.set(item.symbol, item)
console.log(`${date}: ${symbols.length} stocks, ${matches.length} matching minutes, ${firstByStock.size} matching stocks`)
console.log("First match per stock; 0.5% stop and +3% target measured from its close, stop wins a same-bar collision:")
console.table([...firstByStock.values()])
console.log("PGEL matching minutes:")
console.table(matches.filter((row) => row.symbol === "PGEL"))
