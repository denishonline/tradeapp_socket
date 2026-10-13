import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const DATES = process.argv.slice(2).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
const dates = DATES.length ? DATES : ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const TARGET_PCT = 1.5
const STOP_PCT = 0.4
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]

const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const median = (values) => {
  if (!values.length) return NaN
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const dateKey = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const timeKey = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 16)
const sessionAt = (date, time) => Date.parse(`${date}T${time}:00+05:30`)

function readAllCandles(symbol) {
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  const all = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const row = JSON.parse(line), at = Number(row.time) * 1000
      return [{ at, open: Number(row.open), high: Number(row.high), low: Number(row.low),
        close: Number(row.close), volume: Number(row.volume) }]
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
  return Map.groupBy(all, (row) => dateKey(row.at))
}

function book(data) {
  let bidSize = 0, askSize = 0
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data?.[`bid_size${level}`]), ask = Number(data?.[`ask_size${level}`])
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null
    bidSize += bid; askSize += ask
  }
  const bid = Number(data.bid_price1), ask = Number(data.ask_price1)
  if (!(bid > 0) || !(ask > 0)) return null
  return { bid, ask, bid1: Number(data.bid_size1), ask1: Number(data.ask_size1),
    bidShare: bidSize / (bidSize + askSize || 1), mid: (bid + ask) / 2 }
}

function createBucket(minute) {
  return { minute, updates: 0, maxGapSec: 0, lastAt: null, bidShare: 0, bidDominant: 0,
    ofi: 0, traded: 0, signed: 0, firstPrice: null, lastPrice: null, firstMid: null, lastMid: null,
    lastSpreadPct: null }
}

function finalize(bucket) {
  return { updates: bucket.updates, maxGapSec: bucket.maxGapSec,
    avgBidPct: 100 * bucket.bidShare / bucket.updates,
    bidDominantPct: 100 * bucket.bidDominant / bucket.updates,
    ofi: bucket.ofi / bucket.updates,
    deltaPct: bucket.traded > 0 ? 100 * bucket.signed / bucket.traded : 0,
    depthPricePct: pct(bucket.lastPrice, bucket.firstPrice), midReturnPct: pct(bucket.lastMid, bucket.firstMid),
    spreadPct: bucket.lastSpreadPct }
}

async function readDepth(date, symbol) {
  const filename = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return new Map()
  const result = new Map(), input = fs.createReadStream(filename)
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let previous = null, direction = 0, bucket = null
  for await (const line of lines) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(row.receivedAt), current = book(row.data), price = Number(row.marketContext?.price)
    const volume = Number(row.marketContext?.cumulativeVolume)
    if (!current || !Number.isFinite(at) || !(price > 0) || !Number.isFinite(volume)) continue
    const minute = Math.floor(at / MINUTE) * MINUTE
    if (!bucket || minute !== bucket.minute) {
      if (bucket) result.set(bucket.minute, finalize(bucket))
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
    bucket.bidDominant += current.bidShare > 0.5 ? 1 : 0; bucket.ofi += normalizedOfi
    bucket.traded += traded; bucket.signed += signed
    bucket.firstPrice ??= price; bucket.lastPrice = price; bucket.firstMid ??= current.mid; bucket.lastMid = current.mid
    bucket.lastSpreadPct = pct(current.ask, current.bid)
    previous = { at, price, volume, book: current }
  }
  if (bucket) result.set(bucket.minute, finalize(bucket))
  return result
}

function context(rows, index) {
  const row = rows[index], history = rows.slice(0, index + 1), range = row.high - row.low
  const sessionVolume = history.reduce((total, candle) => total + candle.volume, 0)
  const vwap = history.reduce((total, candle) => total + candle.volume * (candle.high + candle.low + candle.close) / 3, 0) / sessionVolume
  const priorVolumes = history.slice(0, -1).slice(-10).map((candle) => candle.volume)
  const ret = (length) => history.length >= length ? pct(row.close, history.slice(-length)[0].open) : NaN
  return { candleReturnPct: pct(row.close, row.open),
    closeLocationPct: range ? 100 * (row.close - row.low) / range : 50,
    upperWickPct: range ? 100 * (row.high - Math.max(row.open, row.close)) / range : 0,
    volumeRatio10: priorVolumes.length ? row.volume / median(priorVolumes) : NaN,
    return3Pct: ret(3), return5Pct: ret(5), return10Pct: ret(10), return30Pct: ret(30),
    dayReturnPct: pct(row.close, history[0].open), vwapGapPct: pct(row.close, vwap),
    belowHighPct: pct(Math.max(...history.map((candle) => candle.high)), row.close),
    recoveryLowPct: pct(row.close, Math.min(...history.map((candle) => candle.low))) }
}

function resolve(rows, entryIndex) {
  const entry = rows[entryIndex].close, future = rows.slice(entryIndex + 1)
  let exitReason = "EOD", exitAt = rows.at(-1)?.at, strategyReturnPct = pct(rows.at(-1)?.close, entry)
  for (const row of future) {
    // Conservative ordering for a one-minute candle containing both levels.
    if (row.low <= entry * (1 - STOP_PCT / 100)) {
      exitReason = "STOP"; exitAt = row.at; strategyReturnPct = -STOP_PCT; break
    }
    if (row.high >= entry * (1 + TARGET_PCT / 100)) {
      exitReason = "TARGET"; exitAt = row.at; strategyReturnPct = TARGET_PCT; break
    }
  }
  const mfePct = future.length ? Math.max(...future.map((row) => pct(row.high, entry))) : 0
  const maePct = future.length ? Math.min(...future.map((row) => pct(row.low, entry))) : 0
  return { entry, exitReason, exitAt, strategyReturnPct,
    result: strategyReturnPct > 0 ? "WIN" : strategyReturnPct < 0 ? "LOSS" : "FLAT", mfePct, maePct }
}

function priorContext(candleSessions, date, setup) {
  const priorDate = [...candleSessions.keys()].filter((value) => value < date).sort().at(-1)
  const prior = priorDate ? candleSessions.get(priorDate) ?? [] : []
  const prior30ReturnPct = prior.length >= 30 ? pct(prior.at(-1).close, prior.at(-30).open) : NaN
  return { priorDate, gapPct: prior.length ? pct(setup.open, prior.at(-1).close) : NaN, prior30ReturnPct }
}

function makeSignal(date, symbol, branch, setup, signal, resolved, features) {
  return { date, strategyBranch: branch, symbol, setupTime: timeKey(setup.at), signalTime: timeKey(signal.at),
    entry: round(resolved.entry, 4), result: resolved.result, exitReason: resolved.exitReason,
    exitTime: timeKey(resolved.exitAt), returnPct: round(resolved.strategyReturnPct),
    mfePct: round(resolved.mfePct), maePct: round(resolved.maePct), ...features }
}

async function analyze(date, symbol, candleSessions) {
  const rows = candleSessions.get(date) ?? []
  if (!rows.length) return null
  const depth = await readDepth(date, symbol)
  const openingAt = sessionAt(date, "09:16"), openingIndex = rows.findIndex((row) => row.at === openingAt)
  if (openingIndex >= 0) {
    const setup = rows[openingIndex], d = depth.get(setup.at), c = context(rows, openingIndex)
    if (d) {
      const prior = priorContext(candleSessions, date, setup)
      const depthEfficiency = c.candleReturnPct > 0 ? d.depthPricePct / c.candleReturnPct : NaN
      const opening = d.updates >= 12 && d.maxGapSec <= 10 && c.candleReturnPct >= 0.20 &&
        c.closeLocationPct >= 75 && c.upperWickPct <= 25 && d.midReturnPct >= 0.20 && d.ofi > 0 &&
        d.spreadPct <= 0.10 && prior.gapPct >= -0.10 && prior.prior30ReturnPct <= 0.25 &&
        d.deltaPct <= 50 && depthEfficiency >= 0.95 && d.avgBidPct <= 50
      if (opening) {
        const resolved = resolve(rows, openingIndex)
        return makeSignal(date, symbol, "Opening Ask Absorption", setup, setup, resolved,
          { gapPct: round(prior.gapPct), prior30ReturnPct: round(prior.prior30ReturnPct),
            candleReturnPct: round(c.candleReturnPct), return3Pct: "", return10Pct: "", return30Pct: "",
            avgBidPct: round(d.avgBidPct), confirmAvgBidPct: "", deltaPct: round(d.deltaPct),
            ofi: round(d.ofi, 4), depthPricePct: round(d.depthPricePct), midReturnPct: round(d.midReturnPct),
            depthUpdates: d.updates, maxGapSec: round(d.maxGapSec), depthEfficiency: round(depthEfficiency) })
      }
    }
  }

  const start = sessionAt(date, "13:50"), end = sessionAt(date, "14:30")
  for (let index = 0; index < rows.length - 1; index++) {
    const setup = rows[index], confirmation = rows[index + 1]
    if (setup.at < start || setup.at > end || confirmation.at !== setup.at + MINUTE) continue
    const d = depth.get(setup.at), confirmDepth = depth.get(confirmation.at)
    if (!d || !confirmDepth) continue
    const c = context(rows, index), confirm = context(rows, index + 1)
    const broadAbsorption = d.updates >= 20 && d.maxGapSec <= 6 && d.spreadPct <= 0.06 &&
      c.return10Pct >= 0.20 && c.return30Pct >= 0.40 && c.vwapGapPct >= 0 &&
      c.belowHighPct <= 1.10 && c.recoveryLowPct >= 0.70 && Math.abs(d.deltaPct) >= 15 &&
      (d.avgBidPct >= 55 || d.deltaPct >= 60)
    const confirmationPassed = confirmation.close > setup.close && confirm.closeLocationPct >= 50
    const selectedFilter = c.return3Pct >= 0.13 && c.candleReturnPct <= 0.15 &&
      confirmDepth.avgBidPct >= 51 && confirmDepth.avgBidPct <= 64
    if (!broadAbsorption || !confirmationPassed || !selectedFilter) continue
    const resolved = resolve(rows, index + 1)
    return makeSignal(date, symbol, "Late Absorption Continuation", setup, confirmation, resolved,
      { gapPct: "", prior30ReturnPct: "", candleReturnPct: round(c.candleReturnPct),
        return3Pct: round(c.return3Pct), return10Pct: round(c.return10Pct), return30Pct: round(c.return30Pct),
        avgBidPct: round(d.avgBidPct), confirmAvgBidPct: round(confirmDepth.avgBidPct),
        deltaPct: round(d.deltaPct), ofi: round(d.ofi, 4), depthPricePct: round(d.depthPricePct),
        midReturnPct: round(d.midReturnPct), depthUpdates: d.updates, maxGapSec: round(d.maxGapSec),
        depthEfficiency: "" })
  }
  return null
}

const candleCache = new Map(stocks.map((symbol) => [symbol, readAllCandles(symbol)]))
const signals = [], errors = []
for (const date of dates) {
  let cursor = 0, scanned = 0
  const results = new Array(stocks.length)
  async function consume() {
    while (true) {
      const index = cursor++
      if (index >= stocks.length) return
      const symbol = stocks[index]
      try { results[index] = await analyze(date, symbol, candleCache.get(symbol)) }
      catch (error) { errors.push({ date, symbol, error: error.message }) }
      scanned++
      if (scanned % 25 === 0 || scanned === stocks.length) process.stderr.write(`${date}: ${scanned}/${stocks.length} ${symbol}\n`)
    }
  }
  await Promise.all(Array.from({ length: 8 }, consume))
  signals.push(...results.filter(Boolean))
}

signals.sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const fields = signals.length ? Object.keys(signals[0]) : []
const csv = (value) => value == null ? "" : String(value)
const output = path.join(ROOT, "csv", `${dates[0]}-to-${dates.at(-1).slice(8)}-two-branch-absorption-backtest.csv`)
fs.writeFileSync(output, [fields.join(","), ...signals.map((row) => fields.map((field) => csv(row[field])).join(","))].join("\n") + "\n")

const summarize = (rows) => ({ signals: rows.length, winners: rows.filter((row) => row.result === "WIN").length,
  losers: rows.filter((row) => row.result === "LOSS").length, targets: rows.filter((row) => row.exitReason === "TARGET").length,
  stops: rows.filter((row) => row.exitReason === "STOP").length, eod: rows.filter((row) => row.exitReason === "EOD").length,
  totalReturnPct: round(rows.reduce((total, row) => total + row.returnPct, 0)),
  averageReturnPct: round(rows.length ? rows.reduce((total, row) => total + row.returnPct, 0) / rows.length : 0) })
const byDay = Object.fromEntries(dates.map((date) => [date, summarize(signals.filter((row) => row.date === date))]))
const branches = [...new Set(signals.map((row) => row.strategyBranch))]
const byBranch = Object.fromEntries(branches.map((branch) => [branch, summarize(signals.filter((row) => row.strategyBranch === branch))]))
console.log(JSON.stringify({ dates, scannedStocksPerDay: stocks.length, errors, output, overall: summarize(signals), byDay, byBranch, signals }, null, 2))
