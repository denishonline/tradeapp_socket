import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const DATE = process.argv.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? "2026-10-13"
const MINUTE = 60_000
const SESSION = Date.parse(`${DATE}T09:15:00+05:30`)
const OPENING = Date.parse(`${DATE}T09:16:00+05:30`)
const INTRADAY_START = Date.parse(`${DATE}T09:30:00+05:30`)
const INTRADAY_END = Date.parse(`${DATE}T14:30:00+05:30`)
const TARGET_PCT = 1.5
const STOP_PCT = .4
const selectedKeys = new Set(["PRESTIGE|14:20", "SHRIRAMFIN|14:01", "INDIANB|09:16", "CAMS|09:16",
  "HAVELLS|13:53", "KFINTECH|09:16", "TRENT|09:16", "CHOLAFIN|13:50"])
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : NaN
const median = (values) => {
  if (!values.length) return NaN
  const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const time = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)

function candles(symbol) {
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const row = JSON.parse(line), at = Number(row.time) * 1000
      return at >= SESSION && at < SESSION + 7 * 60 * MINUTE
        ? [{ at, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }]
        : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
}

function historicalContext(symbol, setup) {
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  const sessions = new Map()
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line), at = Number(value.time) * 1000
      const date = new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
      if (date >= DATE) continue
      if (!sessions.has(date)) sessions.set(date, [])
      sessions.get(date).push({ at, open: Number(value.open), close: Number(value.close) })
    } catch {}
  }
  const priorDate = [...sessions.keys()].sort().at(-1), prior = sessions.get(priorDate) ?? []
  prior.sort((a, b) => a.at - b.at)
  return { priorDate,
    gapPct: prior.length ? pct(setup.open, prior.at(-1).close) : NaN,
    prior30ReturnPct: prior.length >= 30 ? pct(prior.at(-1).close, prior.at(-30).open) : NaN }
}

function book(data) {
  let bidSize = 0, askSize = 0
  for (let level = 1; level <= 5; level++) {
    const bid = Number(data?.[`bid_size${level}`]), ask = Number(data?.[`ask_size${level}`])
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null
    bidSize += bid; askSize += ask
  }
  const bid = Number(data.bid_price1), ask = Number(data.ask_price1)
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

async function depths(symbol) {
  const filename = path.join(ROOT, "db", "cash-depth", DATE, symbol, `${symbol}.jsonl`)
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
    bucket.bidDominant += current.bidShare > .5 ? 1 : 0; bucket.ofi += normalizedOfi
    bucket.traded += traded; bucket.signed += signed
    bucket.firstPrice ??= price; bucket.lastPrice = price; bucket.firstMid ??= current.mid; bucket.lastMid = current.mid
    bucket.lastSpreadPct = pct(current.ask, current.bid)
    previous = { at, price, volume, book: current }
  }
  if (bucket) result.set(bucket.minute, finalize(bucket))
  return result
}

function outcome(rows, index, stopPct = STOP_PCT, targetPct = TARGET_PCT) {
  const entry = rows[index].close
  let result = "Unresolved", resolvedAt = null
  for (const row of rows.slice(index + 1)) {
    if (row.low <= entry * (1 - stopPct / 100)) { result = "Stop"; resolvedAt = row.at; break }
    if (row.high >= entry * (1 + targetPct / 100)) { result = "Target"; resolvedAt = row.at; break }
  }
  const future = rows.slice(index + 1)
  return { result, resolvedAt, entry, mfePct: future.length ? Math.max(...future.map((row) => pct(row.high, entry))) : 0,
    maePct: future.length ? Math.min(...future.map((row) => pct(row.low, entry))) : 0,
    closePct: pct(rows.at(-1).close, entry) }
}

function candleContext(rows, index) {
  const row = rows[index], history = rows.slice(0, index + 1), range = row.high - row.low
  const sessionVolume = history.reduce((total, candle) => total + candle.volume, 0)
  const vwap = history.reduce((total, candle) => total + candle.volume * (candle.high + candle.low + candle.close) / 3, 0) / sessionVolume
  const priorVolumes = history.slice(0, -1).slice(-10).map((candle) => candle.volume)
  const ret = (length) => history.length >= length ? pct(row.close, history.slice(-length)[0].open) : NaN
  return { candleReturnPct: pct(row.close, row.open), closeLocationPct: range ? 100 * (row.close - row.low) / range : 50,
    upperWickPct: range ? 100 * (row.high - Math.max(row.open, row.close)) / range : 0,
    volumeRatio10: priorVolumes.length ? row.volume / median(priorVolumes) : NaN,
    return3Pct: ret(3), return5Pct: ret(5), return10Pct: ret(10), return30Pct: ret(30),
    dayReturnPct: pct(row.close, history[0].open), vwapGapPct: pct(row.close, vwap),
    belowHighPct: pct(Math.max(...history.map((candle) => candle.high)), row.close),
    recoveryLowPct: pct(row.close, Math.min(...history.map((candle) => candle.low))) }
}

async function analyze(symbol) {
  const rows = candles(symbol), depth = await depths(symbol), candidates = []
  for (let index = 0; index < rows.length - 1; index++) {
    const setup = rows[index], confirmation = rows[index + 1], d = depth.get(setup.at), confirmDepth = depth.get(confirmation.at)
    if (!d || confirmation.at !== setup.at + MINUTE) continue
    const context = candleContext(rows, index), confirmContext = candleContext(rows, index + 1)
    const opening = setup.at === OPENING && d.updates >= 10 && d.maxGapSec <= 10 &&
      context.candleReturnPct >= .20 && context.closeLocationPct >= 75 && context.upperWickPct <= 25 &&
      d.midReturnPct >= .20 && d.ofi > 0 && d.spreadPct <= .10
    const absorption = setup.at >= INTRADAY_START && setup.at <= INTRADAY_END &&
      d.updates >= 20 && d.maxGapSec <= 6 && d.spreadPct <= .06 &&
      context.return10Pct >= .20 && context.return30Pct >= .40 && context.vwapGapPct >= 0 &&
      context.belowHighPct <= 1.10 && context.recoveryLowPct >= .70 && Math.abs(d.deltaPct) >= 15 &&
      (d.avgBidPct >= 55 || d.deltaPct >= 60)
    if (!opening && !absorption) continue
    // The opening setup is observable when the 09:16 candle closes, so its
    // entry and outcome must start there. Intraday absorption needs the next
    // completed candle to confirm that price has begun to leave the base.
    const confirmed = confirmation.close > setup.close && confirmContext.closeLocationPct >= 50
    if (absorption && !confirmed) continue
    const entryIndex = opening ? index : index + 1
    const out = outcome(rows, entryIndex)
    const out05 = outcome(rows, entryIndex, 0.5), out06 = outcome(rows, entryIndex, 0.6)
    const previousContext = index > 0 ? candleContext(rows, index - 1) : null
    const previousDepth = index > 0 ? depth.get(rows[index - 1].at) : null
    const historical = opening ? historicalContext(symbol, setup) : null
    candidates.push({ date: DATE, symbol, branch: opening ? "opening" : "intraday", setupTime: time(setup.at),
      signalTime: time(rows[entryIndex].at), confirmationTime: opening ? "" : time(confirmation.at),
      selected: DATE === "2026-10-13" && selectedKeys.has(`${symbol}|${time(setup.at)}`),
      entry: out.entry, outcome: out.result, resolvedAt: out.resolvedAt ? time(out.resolvedAt) : "",
      outcome05: out05.result, resolvedAt05: out05.resolvedAt ? time(out05.resolvedAt) : "",
      outcome06: out06.result, resolvedAt06: out06.resolvedAt ? time(out06.resolvedAt) : "",
      mfePct: round(out.mfePct), maePct: round(out.maePct), closePct: round(out.closePct),
      gapPct: round(historical?.gapPct), prior30ReturnPct: round(historical?.prior30ReturnPct),
      ...Object.fromEntries(Object.entries(context).map(([key, value]) => [key, round(value)])),
      updates: d.updates, maxGapSec: round(d.maxGapSec), avgBidPct: round(d.avgBidPct),
      bidDominantPct: round(d.bidDominantPct), ofi: round(d.ofi, 4), deltaPct: round(d.deltaPct),
      depthPricePct: round(d.depthPricePct), midReturnPct: round(d.midReturnPct), spreadPct: round(d.spreadPct),
      confirmCandleReturnPct: round(confirmContext.candleReturnPct), confirmCloseLocationPct: round(confirmContext.closeLocationPct),
      confirmVolumeRatio10: round(confirmContext.volumeRatio10), confirmAvgBidPct: round(confirmDepth?.avgBidPct),
      confirmBidDominantPct: round(confirmDepth?.bidDominantPct), confirmOfi: round(confirmDepth?.ofi, 4),
      confirmDeltaPct: round(confirmDepth?.deltaPct), confirmMidReturnPct: round(confirmDepth?.midReturnPct),
      previousCandleReturnPct: round(previousContext?.candleReturnPct),
      previousCloseLocationPct: round(previousContext?.closeLocationPct),
      previousVolume: index > 0 ? rows[index - 1].volume : null,
      previousDepthUpdates: previousDepth?.updates ?? null,
      previousAvgBidPct: round(previousDepth?.avgBidPct),
      previousBidDominantPct: round(previousDepth?.bidDominantPct),
      previousOfi: round(previousDepth?.ofi, 4), previousDeltaPct: round(previousDepth?.deltaPct),
      previousMidReturnPct: round(previousDepth?.midReturnPct) })
  }
  return candidates
}

const results = new Array(stocks.length)
let cursor = 0
async function consume() {
  while (true) {
    const index = cursor++
    if (index >= stocks.length) return
    const symbol = stocks[index]
    try { results[index] = await analyze(symbol) }
    catch (error) { results[index] = [{ symbol, error: error.message }] }
    if ((index + 1) % 10 === 0 || index + 1 === stocks.length) process.stderr.write(`Scanning ${index + 1}/${stocks.length}: ${symbol}\n`)
  }
}
await Promise.all(Array.from({ length: 8 }, consume))
const errors = results.flat().filter((row) => row.error)
const candidates = results.flat().filter((row) => !row.error)
  .sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const fields = candidates.length ? Object.keys(candidates[0]) : []
const csvValue = (value) => value === null || value === undefined ? "" : String(value)
const output = path.join(ROOT, "csv", `${DATE}-absorption-breakout-broad-candidates.csv`)
fs.writeFileSync(output, [fields.join(","), ...candidates.map((row) => fields.map((field) => csvValue(row[field])).join(","))].join("\n") + "\n")
const summary = (rows) => ({ signals: rows.length, target: rows.filter((row) => row.outcome === "Target").length,
  stop: rows.filter((row) => row.outcome === "Stop").length,
  unresolved: rows.filter((row) => row.outcome === "Unresolved").length })
console.log(JSON.stringify({ scanned: stocks.length, errors, output, broad: summary(candidates),
  opening: summary(candidates.filter((row) => row.branch === "opening")),
  intraday: summary(candidates.filter((row) => row.branch === "intraday")),
  selected: candidates.filter((row) => row.selected) }, null, 2))
