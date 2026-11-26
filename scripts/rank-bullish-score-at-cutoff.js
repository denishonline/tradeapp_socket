import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const targetDate = process.argv[2] || "2026-10-28"
const cutoffMinute = Number(process.argv[3] || 580) // 09:40 IST
const cutoffClock = `${String(Math.floor(cutoffMinute / 60)).padStart(2, "0")}:${String(cutoffMinute % 60).padStart(2, "0")}`
const IST_OFFSET_MS = 330 * 60_000
const candleDirectory = path.join(ROOT, "db", "candles")
const depthDirectory = path.join(ROOT, "db", "cash-depth", targetDate)
const stocks = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
  .map((symbol) => String(symbol).trim().toUpperCase())
  .filter(Boolean)

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
}

function dateOf(epochSeconds) {
  return new Date(Number(epochSeconds) * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
}

function minuteOf(epochSeconds) {
  const date = new Date(Number(epochSeconds) * 1000 + IST_OFFSET_MS)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}

function clamp(value, low = 0, high = 100) {
  return Math.max(low, Math.min(high, value))
}

function pct(current, base) {
  return Number.isFinite(current) && Number.isFinite(base) && base !== 0
    ? (current / base - 1) * 100
    : null
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

function latestTenDates(rows) {
  return [...new Set(rows.map((row) => dateOf(row.time)))].sort().slice(-10)
}

function pviSeries(rows) {
  let pvi = 1000
  let pviEma255 = null
  let previous = null
  return rows.map((row) => {
    if (previous && Number(row.volume) > Number(previous.volume) && Number(previous.close) !== 0) {
      pvi *= 1 + (Number(row.close) - Number(previous.close)) / Number(previous.close)
    }
    pviEma255 = pviEma255 === null ? pvi : pvi * (2 / 256) + pviEma255 * (254 / 256)
    previous = row
    return { ...row, pvi, pviEma255 }
  })
}

function bookFromRecord(record) {
  const data = record.data || {}
  const stored = record.book || {}
  const makeLevels = (side, field) => Array.from({ length: 5 }, (_, index) => ({
    price: Number(data[`${side}_price${index + 1}`]),
    size: Number(data[`${side}_size${index + 1}`]),
    orders: Number(data[`${side}_order${index + 1}`]),
  })).filter((level) => Number.isFinite(level.price))
  return {
    bids: stored.bids?.length ? stored.bids : makeLevels("bid", "size"),
    asks: stored.asks?.length ? stored.asks : makeLevels("ask", "size"),
  }
}

function imbalance(levels, count, field) {
  return levels.slice(0, count).reduce((sum, level) => sum + (Number(level[field]) || 0), 0)
}

function depthSeries(symbol) {
  const file = path.join(depthDirectory, symbol, `${symbol}.jsonl`)
  const raw = readJsonl(file)
  const byMinute = new Map()
  for (const record of raw) {
    const epoch = Date.parse(record.receivedAt) / 1000
    if (!Number.isFinite(epoch) || dateOf(epoch) !== targetDate) continue
    const minute = minuteOf(epoch)
    if (minute < 555 || minute > cutoffMinute) continue
    const book = bookFromRecord(record)
    if (!book.bids.length || !book.asks.length) continue
    const bid5 = imbalance(book.bids, 5, "size")
    const ask5 = imbalance(book.asks, 5, "size")
    const bid2 = imbalance(book.bids, 2, "size")
    const ask2 = imbalance(book.asks, 2, "size")
    const bidOrders = imbalance(book.bids, 5, "orders")
    const askOrders = imbalance(book.asks, 5, "orders")
    byMinute.set(minute, {
      minute,
      price: Number(record.marketContext?.price),
      top5Imbalance: (bid5 - ask5) / (bid5 + ask5 || 1) * 100,
      top2Imbalance: (bid2 - ask2) / (bid2 + ask2 || 1) * 100,
      orderImbalance: (bidOrders - askOrders) / (bidOrders + askOrders || 1) * 100,
      spread: Number(book.asks[0].price) - Number(book.bids[0].price),
    })
  }
  return [...byMinute.values()].sort((left, right) => left.minute - right.minute)
}

function scoreStock(symbol) {
  const rows = readJsonl(path.join(candleDirectory, `${symbol}.jsonl`))
    .filter((row) => Number.isFinite(Number(row.time)) && Number.isFinite(Number(row.close)))
    .sort((left, right) => Number(left.time) - Number(right.time))
  if (!rows.length) return null
  const dates = latestTenDates(rows)
  if (!dates.includes(targetDate)) return null
  const calculationRows = rows.filter((row) => {
    const date = dateOf(row.time)
    return dates.includes(date) && (date !== targetDate || minuteOf(row.time) <= cutoffMinute)
  })
  const series = pviSeries(calculationRows)
  const target = series.filter((row) => dateOf(row.time) === targetDate && minuteOf(row.time) >= 555 && minuteOf(row.time) <= cutoffMinute)
  if (target.length < 2) return null
  const first = target[0]
  const last = target.at(-1)
  const depth = depthSeries(symbol)
  if (!depth.length) return null
  const average = (field) => depth.reduce((sum, row) => sum + row[field], 0) / depth.length
  const movePct = pct(last.close, first.open)
  const pviMovePct = pct(last.pvi, first.pvi)
  const pviGapPct = pct(last.pvi, last.pviEma255)
  const priceScore = clamp(50 + (movePct || 0) * 15)
  const depthScore = clamp(50 + average("top5Imbalance") * 0.35 + average("top2Imbalance") * 0.25 + average("orderImbalance") * 0.40)
  const pviScore = clamp(50 + (pviMovePct || 0) * 200 + (pviGapPct || 0) * 20)
  const bullishScore = 0.35 * priceScore + 0.40 * depthScore + 0.25 * pviScore
  return {
    stock: symbol,
    bullishScore: round(bullishScore),
    priceScore: round(priceScore),
    depthScore: round(depthScore),
    pviScore: round(pviScore),
    openingMovePct: round(movePct),
    pviMovePct: round(pviMovePct, 3),
    pviVsEmaPct: round(pviGapPct, 3),
    pvi: round(last.pvi),
    pviEma255: round(last.pviEma255),
    avgTop5ImbalancePct: round(average("top5Imbalance")),
    avgTop2ImbalancePct: round(average("top2Imbalance")),
    avgOrderImbalancePct: round(average("orderImbalance")),
    depthMinutes: depth.length,
    candleMinutes: target.length,
    firstPrice: round(first.open),
    lastPrice: round(last.close),
  }
}

const ranked = stocks.map(scoreStock).filter(Boolean).sort((left, right) => right.bullishScore - left.bullishScore)
const result = {
  targetDate,
  cutoff: `${cutoffClock} IST`,
  method: `Bullish score = 35% price move from 09:15 open, 40% minute-sampled top-5/top-2/order depth imbalance, 25% PVI change and PVI-vs-EMA255. PVI uses the latest 10 available candle dates and no target-date candle after ${cutoffClock}.`,
  coverage: { stocksInUniverse: stocks.length, scoredStocks: ranked.length },
  top10: ranked.slice(0, 10),
}
const base = path.join(ROOT, "reports", `${targetDate}-${cutoffClock.replace(":", "")}-bullish-score-top10.json`)
let report = base
let suffix = 2
while (fs.existsSync(report)) report = base.replace(/\.json$/, `-${suffix++}.json`)
fs.writeFileSync(report, `${JSON.stringify({ ...result, report }, null, 2)}\n`, "utf8")
console.table(result.top10.map((row, index) => ({
  Rank: index + 1,
  Stock: row.stock,
  Score: row.bullishScore,
  Move: `${row.openingMovePct}%`,
  PVI: `${row.pviMovePct}%`,
  "PVI-EMA": `${row.pviVsEmaPct}%`,
  "Depth-5": `${row.avgTop5ImbalancePct}%`,
  "Depth-2": `${row.avgTop2ImbalancePct}%`,
  Orders: `${row.avgOrderImbalancePct}%`,
})))
console.log(`Saved ${report}`)
