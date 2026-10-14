import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const MINUTE = 60_000
const DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"]
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const median = (values) => {
  if (!values.length) return NaN
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""
const istTime = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)

function loadCandles(symbol, date) {
  const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T15:31:00+05:30`)
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line), at = Number(value.time) * 1000
      if (value.partial || at < start || at >= end) return []
      const row = { at, open: Number(value.open), high: Number(value.high), low: Number(value.low), close: Number(value.close), volume: Number(value.volume) }
      return Object.values(row).every(Number.isFinite) ? [row] : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
}

function book(data) {
  let bidSize = 0, askSize = 0
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data?.[`bid_size${level}`]), ask = Number(data?.[`ask_size${level}`])
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null
    bidSize += bid; askSize += ask
  }
  const bid = Number(data.bid_price1), ask = Number(data.ask_price1)
  if (!(bid > 0) || !(ask > bid)) return null
  return { bid, ask, bid1: Number(data.bid_size1), ask1: Number(data.ask_size1),
    bidShare: bidSize / (bidSize + askSize || 1), mid: (bid + ask) / 2 }
}

function createBucket(minute) {
  return { minute, updates: 0, maxGapSec: 0, lastAt: null, bidShare: 0, bidDominant: 0,
    ofi: 0, traded: 0, signed: 0, firstPrice: null, lastPrice: null, firstMid: null, lastMid: null,
    spread: 0 }
}

function finish(bucket) {
  return { updates: bucket.updates, maxGapSec: bucket.maxGapSec,
    avgBidPct: 100 * bucket.bidShare / bucket.updates,
    bidDominantPct: 100 * bucket.bidDominant / bucket.updates,
    ofi: bucket.ofi / bucket.updates,
    deltaPct: bucket.traded > 0 ? 100 * bucket.signed / bucket.traded : 0,
    depthPricePct: pct(bucket.lastPrice, bucket.firstPrice), midReturnPct: pct(bucket.lastMid, bucket.firstMid),
    spreadPct: 100 * bucket.spread / bucket.updates }
}

async function loadDepth(symbol, date) {
  const filename = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const result = new Map()
  if (!fs.existsSync(filename)) return result
  const lines = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity })
  let previous = null, direction = 0, bucket = null
  for await (const line of lines) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(row.receivedAt), current = book(row.data), price = Number(row.marketContext?.price)
    const volume = Number(row.marketContext?.cumulativeVolume)
    if (!current || !Number.isFinite(at) || !(price > 0) || !Number.isFinite(volume)) continue
    const minute = Math.floor(at / MINUTE) * MINUTE
    if (!bucket || bucket.minute !== minute) {
      if (bucket) result.set(bucket.minute, finish(bucket))
      bucket = createBucket(minute)
    }
    let normalizedOfi = 0, traded = 0, signed = 0
    if (previous && at - previous.at <= 90_000) {
      const rawOfi = (current.bid >= previous.book.bid ? current.bid1 : 0) -
        (current.bid <= previous.book.bid ? previous.book.bid1 : 0) -
        (current.ask <= previous.book.ask ? current.ask1 : 0) +
        (current.ask >= previous.book.ask ? previous.book.ask1 : 0)
      const size = (current.bid1 + current.ask1 + previous.book.bid1 + previous.book.ask1) / 2
      normalizedOfi = rawOfi / (size || 1)
      traded = Math.max(0, volume - previous.volume)
      if (price > previous.price) direction = 1
      else if (price < previous.price) direction = -1
      signed = traded * direction
    }
    bucket.maxGapSec = bucket.lastAt ? Math.max(bucket.maxGapSec, (at - bucket.lastAt) / 1000) : 0
    bucket.lastAt = at; bucket.updates++; bucket.bidShare += current.bidShare
    bucket.bidDominant += current.bidShare > .5 ? 1 : 0; bucket.ofi += normalizedOfi
    bucket.traded += traded; bucket.signed += signed
    bucket.firstPrice ??= price; bucket.lastPrice = price; bucket.firstMid ??= current.mid; bucket.lastMid = current.mid
    bucket.spread += pct(current.ask, current.bid)
    previous = { at, price, volume, book: current }
  }
  if (bucket) result.set(bucket.minute, finish(bucket))
  return result
}

function outcome(candles, index, targetPct, stopPct, horizon) {
  const entry = candles[index].close, future = candles.slice(index + 1, index + 1 + horizon)
  let result = "Timed", resolvedAt = future.at(-1)?.at ?? null, returnPct = future.length ? pct(future.at(-1).close, entry) : 0
  for (const row of future) {
    if (row.low <= entry * (1 - stopPct / 100)) { result = "Stop"; resolvedAt = row.at; returnPct = -stopPct; break }
    if (row.high >= entry * (1 + targetPct / 100)) { result = "Target"; resolvedAt = row.at; returnPct = targetPct; break }
  }
  if (future.length < horizon && result === "Timed") result = "Pending"
  return { result, resolvedAt, returnPct,
    mfePct: future.length ? Math.max(...future.map((row) => pct(row.high, entry))) : 0,
    maePct: future.length ? Math.min(...future.map((row) => pct(row.low, entry))) : 0 }
}

function context(candles, index, depths) {
  const row = candles[index], history = candles.slice(0, index + 1), prior = history.slice(0, -1)
  const range = row.high - row.low, prior10 = prior.slice(-10)
  const ret = (length) => history.length >= length ? pct(row.close, history.at(-length).open) : NaN
  const sessionVolume = history.reduce((sum, item) => sum + item.volume, 0)
  const vwap = history.reduce((sum, item) => sum + item.volume * (item.high + item.low + item.close) / 3, 0) / sessionVolume
  const depth = depths.get(row.at), recentDepth = history.slice(-3).map((item) => depths.get(item.at)).filter(Boolean)
  const priorHigh5 = prior.slice(-5).length ? Math.max(...prior.slice(-5).map((item) => item.high)) : NaN
  const priorHigh10 = prior10.length ? Math.max(...prior10.map((item) => item.high)) : NaN
  return { candleReturnPct: pct(row.close, row.open), closeLocationPct: range > 0 ? 100 * (row.close - row.low) / range : 50,
    upperWickPct: range > 0 ? 100 * (row.high - Math.max(row.open, row.close)) / range : 0,
    volumeRatio10: prior10.length >= 3 ? row.volume / median(prior10.map((item) => item.volume)) : NaN,
    rangeRatio10: prior10.length >= 3 ? range / median(prior10.map((item) => item.high - item.low).filter((value) => value > 0)) : NaN,
    volumeTrend3: prior.length >= 6 ? mean(history.slice(-3).map((item) => item.volume)) / mean(history.slice(-6, -3).map((item) => item.volume)) : NaN,
    return2Pct: ret(2), return3Pct: ret(3), return5Pct: ret(5), return10Pct: ret(10), return30Pct: ret(30),
    dayReturnPct: pct(row.close, history[0].open), vwapGapPct: pct(row.close, vwap),
    breakout5Pct: pct(row.close, priorHigh5), breakout10Pct: pct(row.close, priorHigh10),
    green3: history.slice(-3).filter((item) => item.close > item.open).length,
    green5: history.slice(-5).filter((item) => item.close > item.open).length,
    depth, depthPositiveMid3: recentDepth.filter((item) => item.midReturnPct > 0).length,
    depthPositiveOfi3: recentDepth.filter((item) => item.ofi > 0).length,
    depthBidDominant3: recentDepth.filter((item) => item.avgBidPct > 50).length,
    depthAvgBid3: mean(recentDepth.map((item) => item.avgBidPct)),
    depthAvgOfi3: mean(recentDepth.map((item) => item.ofi)),
    depthAvgDelta3: mean(recentDepth.map((item) => item.deltaPct)),
    previousDepth: index ? depths.get(candles[index - 1].at) : null }
}

async function analyze(symbol, date) {
  const candles = loadCandles(symbol, date)
  if (!candles.length) return []
  const depths = await loadDepth(symbol, date), rows = []
  let cooldownUntil = -Infinity
  for (let index = 5; index < candles.length; index++) {
    const candle = candles[index]
    if (istTime(candle.at) < "09:20" || istTime(candle.at) > "14:45" || candle.at < cooldownUntil) continue
    const c = context(candles, index, depths), d = c.depth
    if (!d || d.updates < 10 || d.maxGapSec > 15 || c.candleReturnPct < .03 || c.closeLocationPct < 55 ||
      c.volumeRatio10 < .65 || c.return3Pct <= 0 || d.midReturnPct <= 0) continue
    const out05 = outcome(candles, index, .5, .3, 10), out06 = outcome(candles, index, .6, .3, 10)
    rows.push({ date, symbol, signalTime: istTime(candle.at), entry: candle.close,
      outcome05: out05.result, return05: round(out05.returnPct), outcome06: out06.result,
      return06: round(out06.returnPct), resolvedAt06: out06.resolvedAt ? istTime(out06.resolvedAt) : "",
      mfe06: round(out06.mfePct), mae06: round(out06.maePct),
      ...Object.fromEntries(Object.entries(c).filter(([key]) => !["depth", "previousDepth"].includes(key)).map(([key, value]) => [key, round(value)])),
      updates: d.updates, maxGapSec: round(d.maxGapSec), avgBidPct: round(d.avgBidPct), bidDominantPct: round(d.bidDominantPct),
      ofi: round(d.ofi), deltaPct: round(d.deltaPct), depthPricePct: round(d.depthPricePct), midReturnPct: round(d.midReturnPct), spreadPct: round(d.spreadPct),
      previousAvgBidPct: round(c.previousDepth?.avgBidPct), previousOfi: round(c.previousDepth?.ofi),
      previousDeltaPct: round(c.previousDepth?.deltaPct), previousMidReturnPct: round(c.previousDepth?.midReturnPct) })
    cooldownUntil = candle.at + 10 * MINUTE
  }
  return rows
}

const all = []
for (const date of DATES) {
  let cursor = 0, completed = 0
  const results = new Array(stocks.length)
  async function worker() {
    while (true) {
      const index = cursor++
      if (index >= stocks.length) return
      try { results[index] = await analyze(stocks[index], date) } catch { results[index] = [] }
      completed++
      if (completed % 25 === 0 || completed === stocks.length) process.stderr.write(`${date}: ${completed}/${stocks.length} ${stocks[index]}\n`)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  all.push(...results.flat())
}
const columns = [...new Set(all.flatMap((row) => Object.keys(row)))]
const csv = (value) => value === null || value === undefined ? "" : String(value)
const output = path.join(ROOT, "csv", "2026-10-05-to-14-fast-depth-momentum-candidates.csv")
fs.writeFileSync(output, [columns.join(","), ...all.map((row) => columns.map((column) => csv(row[column])).join(","))].join("\n") + "\n")
const summarize = (rows) => ({ signals: rows.length, target: rows.filter((row) => row.outcome06 === "Target").length,
  stop: rows.filter((row) => row.outcome06 === "Stop").length, timed: rows.filter((row) => row.outcome06 === "Timed").length,
  pending: rows.filter((row) => row.outcome06 === "Pending").length })
console.log(JSON.stringify({ output, total: all.length, train: summarize(all.filter((row) => row.date <= "2026-10-09")),
  validation: summarize(all.filter((row) => row.date >= "2026-10-12" && row.date <= "2026-10-13")),
  holdout: summarize(all.filter((row) => row.date === "2026-10-14")) }, null, 2))
