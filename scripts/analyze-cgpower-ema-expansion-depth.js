import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const SYMBOL = "CGPOWER"
const DATE = "2026-10-13"
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const startAt = Date.parse(`${DATE}T12:28:00+05:30`)
const transitionAt = Date.parse(`${DATE}T13:28:00+05:30`)
const endAt = Date.parse(`${DATE}T13:39:00+05:30`)

const mean = (values) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 16)

function jsonLines(filename) {
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function completeBook(fields) {
  let bidSize = 0, askSize = 0, bidTop2 = 0, askTop2 = 0
  let bidOrders = 0, askOrders = 0, bid = NaN, ask = NaN, bid1 = NaN, ask1 = NaN
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBid = Number(fields[`bid_size${level}`])
    const currentAsk = Number(fields[`ask_size${level}`])
    const currentBidOrders = Number(fields[`bid_order${level}`])
    const currentAskOrders = Number(fields[`ask_order${level}`])
    if (![bidPrice, askPrice, currentBid, currentAsk].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBid < 0 || currentAsk < 0) return null
    if (level === 1) { bid = bidPrice; ask = askPrice; bid1 = currentBid; ask1 = currentAsk }
    bidSize += currentBid
    askSize += currentAsk
    bidOrders += Number.isFinite(currentBidOrders) ? currentBidOrders : 0
    askOrders += Number.isFinite(currentAskOrders) ? currentAskOrders : 0
    if (level <= 2) { bidTop2 += currentBid; askTop2 += currentAsk }
  }
  return { bid, ask, bid1, ask1, bidSize, askSize, mid: (bid + ask) / 2,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (bidTop2 - askTop2) / (bidTop2 + askTop2 || 1),
    orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1),
    spreadBps: 10_000 * (ask - bid) / ((ask + bid) / 2) }
}

const candles = jsonLines(path.join(ROOT, "db", "candles", `${SYMBOL}.jsonl`))
  .map((row) => ({ at: Number(row.time) * 1000, open: Number(row.open), high: Number(row.high),
    low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }))
  .filter((row) => Object.values(row).every(Number.isFinite)).sort((a, b) => a.at - b.at)
let ema15 = null, ema30 = null
for (const row of candles) {
  ema15 = ema15 == null ? row.close : row.close * 2 / 16 + ema15 * 14 / 16
  ema30 = ema30 == null ? row.close : row.close * 2 / 31 + ema30 * 29 / 31
  row.ema15 = ema15
  row.ema30 = ema30
  row.emaGap = ema15 - ema30
  row.emaGapPct = 100 * row.emaGap / ema30
}

const samples = []
const fields = {}
let previous = null, direction = 0
for (const record of jsonLines(path.join(ROOT, "db", "cash-depth", DATE, SYMBOL, `${SYMBOL}.jsonl`))) {
  const at = Date.parse(record.receivedAt)
  if (!Number.isFinite(at) || indiaDate(at) !== DATE) continue
  if (previous && at - previous.at > 90_000) {
    previous = null
    direction = 0
    for (const key of Object.keys(fields)) delete fields[key]
  }
  if (record.kind === "checkpoint" || record.book) {
    for (const key of Object.keys(fields)) delete fields[key]
    Object.assign(fields, record.data)
  } else if (record.kind === "update") Object.assign(fields, record.data)
  else continue
  const book = completeBook(fields)
  const price = Number(record.marketContext?.price)
  const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
  if (!book || !(price > 0) || !Number.isFinite(cumulativeVolume)) continue
  let normalizedOfi = 0, traded = 0, signed = 0
  if (previous) {
    let rawOfi = book.bid > previous.bid ? book.bid1
      : book.bid === previous.bid ? book.bid1 - previous.bid1 : -previous.bid1
    rawOfi -= book.ask < previous.ask ? book.ask1
      : book.ask === previous.ask ? book.ask1 - previous.ask1 : -previous.ask1
    const scale = (book.bid1 + book.ask1 + previous.bid1 + previous.ask1) / 2
    normalizedOfi = rawOfi / (scale || 1)
    traded = Math.max(0, cumulativeVolume - previous.cumulativeVolume)
    if (price > previous.price) direction = 1
    else if (price < previous.price) direction = -1
    signed = traded * direction
  }
  samples.push({ at, price, cumulativeVolume, normalizedOfi, traded, signed, ...book })
  previous = { at, price, cumulativeVolume, ...book }
}

function depthMetrics(rows) {
  if (!rows.length) return null
  const traded = sum(rows.map((row) => row.traded))
  return { updates: rows.length,
    spanSec: (rows.at(-1).at - rows[0].at) / 1000,
    avgFullPct: 100 * mean(rows.map((row) => row.full)),
    avgTop2Pct: 100 * mean(rows.map((row) => row.top2)),
    closeFullPct: 100 * rows.at(-1).full,
    closeTop2Pct: 100 * rows.at(-1).top2,
    bidDominantPct: 100 * rows.filter((row) => row.full > 0).length / rows.length,
    avgBidSize: mean(rows.map((row) => row.bidSize)),
    avgAskSize: mean(rows.map((row) => row.askSize)),
    sizeRatio: mean(rows.map((row) => row.bidSize)) / mean(rows.map((row) => row.askSize)),
    avgOrderImbalancePct: 100 * mean(rows.map((row) => row.orders)),
    avgOfi: mean(rows.map((row) => row.normalizedOfi)),
    tradedVolume: traded,
    deltaPct: traded ? 100 * sum(rows.map((row) => row.signed)) / traded : 0,
    priceReturnPct: pct(rows.at(-1).price, rows[0].price),
    midReturnPct: pct(rows.at(-1).mid, rows[0].mid),
    avgSpreadBps: mean(rows.map((row) => row.spreadBps)),
    firstPrice: rows[0].price, lastPrice: rows.at(-1).price,
    firstMid: rows[0].mid, lastMid: rows.at(-1).mid }
}

const minuteRows = []
for (let minute = startAt; minute < endAt; minute += MINUTE) {
  const candle = candles.find((row) => row.at === minute)
  const depth = depthMetrics(samples.filter((row) => row.at >= minute && row.at < minute + MINUTE))
  if (!candle || !depth) continue
  minuteRows.push({ time: indiaTime(minute), open: candle.open, high: candle.high,
    low: candle.low, close: candle.close, candleReturnPct: pct(candle.close, candle.open),
    volume: candle.volume, ema15: candle.ema15, ema30: candle.ema30,
    emaGap: candle.emaGap, emaGapPct: candle.emaGapPct, ...depth })
}

function phase(from, to) {
  const candleRows = candles.filter((row) => row.at >= from && row.at < to)
  const depthRows = samples.filter((row) => row.at >= from && row.at < to)
  const depth = depthMetrics(depthRows)
  return { from: indiaTime(from), to: indiaTime(to - MINUTE), candles: candleRows.length,
    candleReturnPct: pct(candleRows.at(-1)?.close, candleRows[0]?.open),
    highLowRangePct: pct(Math.max(...candleRows.map((row) => row.high)),
      Math.min(...candleRows.map((row) => row.low))),
    totalVolume: sum(candleRows.map((row) => row.volume)),
    averageMinuteVolume: mean(candleRows.map((row) => row.volume)),
    emaGapStart: candleRows[0]?.emaGap, emaGapEnd: candleRows.at(-1)?.emaGap,
    emaGapPctStart: candleRows[0]?.emaGapPct, emaGapPctEnd: candleRows.at(-1)?.emaGapPct,
    ...depth }
}

const phases = {
  pre60: phase(startAt, transitionAt),
  preFirst30: phase(startAt, transitionAt - 30 * MINUTE),
  preLast30: phase(transitionAt - 30 * MINUTE, transitionAt),
  transition1328: phase(transitionAt, transitionAt + MINUTE),
  expansion1329to1338: phase(transitionAt + MINUTE, endAt),
  full1328to1338: phase(transitionAt, endAt),
}

const selectedMinutes = minuteRows.filter((row) => row.time >= "13:23" && row.time <= "13:38")
const roundObject = (object) => Object.fromEntries(Object.entries(object).map(([key, value]) =>
  [key, typeof value === "number" ? round(value) : value]))
const output = { symbol: SYMBOL, date: DATE,
  windows: { pre60: "12:28-13:27", transition: "13:28", expansion: "13:29-13:38" },
  phases: Object.fromEntries(Object.entries(phases).map(([key, value]) => [key, roundObject(value)])),
  minutes: selectedMinutes.map(roundObject) }

const outputFile = path.join(ROOT, "csv", `${DATE}-${SYMBOL.toLowerCase()}-1328-1338-depth-analysis.json`)
fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`)
console.log(JSON.stringify({ ...output, outputFile }, null, 2))
