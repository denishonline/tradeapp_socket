import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DATE = "2026-10-13"
const MINUTE = 60_000
const SESSION = Date.parse(`${DATE}T09:15:00+05:30`)
const selected = [
  ["PRESTIGE", "14:20"], ["SHRIRAMFIN", "14:01"], ["INDIANB", "09:16"],
  ["CAMS", "09:16"], ["HAVELLS", "13:53"], ["KFINTECH", "09:16"],
  ["TRENT", "09:16"], ["CHOLAFIN", "13:50"],
]
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)
const mean = (values) => values.length ? sum(values) / values.length : NaN
const median = (values) => {
  if (!values.length) return NaN
  const ordered = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function jsonLines(filename) {
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function book(data) {
  let bidSize = 0, askSize = 0, topBid = 0, topAsk = 0
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data?.[`bid_size${level}`]), ask = Number(data?.[`ask_size${level}`])
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null
    bidSize += bid; askSize += ask
    if (level <= 2) { topBid += bid; topAsk += ask }
  }
  return { bid: Number(data.bid_price1), ask: Number(data.ask_price1),
    bid1: Number(data.bid_size1), ask1: Number(data.ask_size1),
    bidShare: bidSize / (bidSize + askSize || 1), top2BidShare: topBid / (topBid + topAsk || 1),
    mid: (Number(data.bid_price1) + Number(data.ask_price1)) / 2 }
}

function candles(symbol) {
  return jsonLines(path.join(ROOT, "db", "candles", `${symbol}.jsonl`)).flatMap((row) => {
    const at = Number(row.time) * 1000
    return at >= SESSION && at < SESSION + 7 * 60 * MINUTE ? [{ at, open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }] : []
  }).sort((left, right) => left.at - right.at)
}

function depth(symbol) {
  const buckets = new Map()
  let previous = null, direction = 0
  for (const row of jsonLines(path.join(ROOT, "db", "cash-depth", DATE, symbol, `${symbol}.jsonl`))) {
    const at = Date.parse(row.receivedAt), current = book(row.data), price = Number(row.marketContext?.price)
    const volume = Number(row.marketContext?.cumulativeVolume)
    if (!current || !Number.isFinite(at) || !(price > 0) || !Number.isFinite(volume)) continue
    let ofi = 0, traded = 0, signed = 0
    if (previous && at - previous.at <= 90_000) {
      const rawOfi = (current.bid >= previous.book.bid ? current.bid1 : 0) -
        (current.bid <= previous.book.bid ? previous.book.bid1 : 0) -
        (current.ask <= previous.book.ask ? current.ask1 : 0) +
        (current.ask >= previous.book.ask ? previous.book.ask1 : 0)
      const size = (current.bid1 + current.ask1 + previous.book.bid1 + previous.book.ask1) / 2
      ofi = rawOfi / (size || 1)
      traded = Math.max(0, volume - previous.volume)
      if (price > previous.price) direction = 1
      else if (price < previous.price) direction = -1
      signed = traded * direction
    }
    const minute = Math.floor(at / MINUTE) * MINUTE
    const bucket = buckets.get(minute) || []
    bucket.push({ at, price, volume, book: current, ofi, traded, signed })
    buckets.set(minute, bucket)
    previous = { at, price, volume, book: current }
  }
  return buckets
}

function minuteDepth(samples) {
  if (!samples?.length) return null
  const traded = sum(samples.map((row) => row.traded)), signed = sum(samples.map((row) => row.signed))
  const last = samples.at(-1), first = samples[0]
  return { updates: samples.length,
    maxGapSec: samples.length > 1 ? Math.max(...samples.slice(1).map((row, index) => (row.at - samples[index].at) / 1000)) : 60,
    avgBid: mean(samples.map((row) => row.book.bidShare)), closeBid: mean(samples.slice(-Math.max(1, Math.ceil(samples.length / 4))).map((row) => row.book.bidShare)),
    avgTop2Bid: mean(samples.map((row) => row.book.top2BidShare)), bidDominant: mean(samples.map((row) => row.book.bidShare > .5 ? 1 : 0)),
    ofi: mean(samples.map((row) => row.ofi)), delta: traded > 0 ? signed / traded : 0,
    priceReturn: pct(last.price, first.price), midReturn: pct(last.book.mid, first.book.mid),
    spreadPct: pct(last.book.ask, last.book.bid) }
}

function outcome(rows, index, targetPct = 1.5, stopPct = .4) {
  const entry = rows[index].close
  let mfe = -Infinity, mae = Infinity, result = "Unresolved", resolvedAt = ""
  for (const row of rows.slice(index + 1)) {
    mfe = Math.max(mfe, pct(row.high, entry)); mae = Math.min(mae, pct(row.low, entry))
    if (row.low <= entry * (1 - stopPct / 100)) { result = "Stop"; resolvedAt = row.at; break }
    if (row.high >= entry * (1 + targetPct / 100)) { result = "Target"; resolvedAt = row.at; break }
  }
  const future = rows.slice(index + 1)
  const sessionMfe = future.length ? Math.max(...future.map((row) => pct(row.high, entry))) : 0
  const sessionMae = future.length ? Math.min(...future.map((row) => pct(row.low, entry))) : 0
  return { entry, result, resolvedAt: resolvedAt ? new Date(resolvedAt + 330 * MINUTE).toISOString().slice(11, 16) : "",
    mfePct: sessionMfe, maePct: sessionMae }
}

function analyze(symbol, time) {
  const at = Date.parse(`${DATE}T${time}:00+05:30`), rows = candles(symbol), index = rows.findIndex((row) => row.at === at)
  if (index < 0) throw new Error(`Missing ${symbol} ${time}`)
  const buckets = depth(symbol), candle = rows[index], history = rows.slice(0, index + 1)
  const d1 = minuteDepth(buckets.get(at))
  const dm = (length) => {
    const values = []
    for (let minute = at - (length - 1) * MINUTE; minute <= at; minute += MINUTE) {
      const value = minuteDepth(buckets.get(minute)); if (value) values.push(value)
    }
    return { count: values.length, avgBid: mean(values.map((row) => row.avgBid)),
      bidPositive: mean(values.map((row) => row.avgBid > .5 ? 1 : 0)), ofi: mean(values.map((row) => row.ofi)),
      delta: mean(values.map((row) => row.delta)), priceReturn: values.length ? sum(values.map((row) => row.priceReturn)) : NaN }
  }
  const windowReturn = (length) => history.length >= length ? pct(candle.close, history.slice(-length)[0].open) : NaN
  const sessionHigh = Math.max(...history.map((row) => row.high)), sessionLow = Math.min(...history.map((row) => row.low))
  const sessionVolume = sum(history.map((row) => row.volume))
  const vwap = sessionVolume ? sum(history.map((row) => row.volume * (row.high + row.low + row.close) / 3)) / sessionVolume : NaN
  const priorVolumes = history.slice(0, -1).slice(-10).map((row) => row.volume)
  const range = candle.high - candle.low
  const out = outcome(rows, index)
  return { symbol, time, branch: time <= "09:17" ? "opening" : "intraday", entry: out.entry,
    candleReturnPct: pct(candle.close, candle.open), closeLocationPct: range ? 100 * (candle.close - candle.low) / range : 50,
    upperWickPct: range ? 100 * (candle.high - Math.max(candle.open, candle.close)) / range : 0,
    volumeRatio10: priorVolumes.length ? candle.volume / median(priorVolumes) : NaN,
    return2Pct: windowReturn(2), return3Pct: windowReturn(3), return5Pct: windowReturn(5),
    return10Pct: windowReturn(10), return15Pct: windowReturn(15), return30Pct: windowReturn(30),
    dayReturnPct: pct(candle.close, history[0].open), vwapGapPct: pct(candle.close, vwap),
    belowSessionHighPct: pct(sessionHigh, candle.close), recoveryFromLowPct: pct(candle.close, sessionLow),
    updates: d1?.updates, maxGapSec: d1?.maxGapSec, avgBidPct: d1 ? 100 * d1.avgBid : NaN,
    closeBidPct: d1 ? 100 * d1.closeBid : NaN, avgTop2BidPct: d1 ? 100 * d1.avgTop2Bid : NaN,
    bidDominantPct: d1 ? 100 * d1.bidDominant : NaN, ofi: d1?.ofi, deltaPct: d1 ? 100 * d1.delta : NaN,
    depthPricePct: d1?.priceReturn, midReturnPct: d1?.midReturn, spreadPct: d1?.spreadPct,
    depth5AvgBidPct: 100 * dm(5).avgBid, depth5BidPositivePct: 100 * dm(5).bidPositive,
    depth5Ofi: dm(5).ofi, depth5DeltaPct: 100 * dm(5).delta,
    outcome: out.result, targetAt: out.resolvedAt, mfePct: out.mfePct, maePct: out.maePct }
}

const results = selected.map(([symbol, time]) => analyze(symbol, time))
const fields = Object.keys(results[0])
const value = (input) => Number.isFinite(input) ? round(input) : input ?? ""
const csv = [fields.join(","), ...results.map((row) => fields.map((field) => value(row[field])).join(","))]
const output = path.join(ROOT, "csv", "2026-10-13-selected-breakout-candle-depth-research.csv")
fs.writeFileSync(output, csv.join("\n") + "\n")
console.log(JSON.stringify({ output, results: results.map((row) => Object.fromEntries(Object.entries(row).map(([key, input]) => [key, value(input)]))) }, null, 2))
