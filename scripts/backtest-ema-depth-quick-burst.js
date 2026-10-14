import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const DATE = process.argv.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)) ?? "2026-10-14"
const MINUTE = 60_000
const SESSION_START = Date.parse(`${DATE}T09:15:00+05:30`)
const SESSION_END = Date.parse(`${DATE}T15:20:00+05:30`)
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""
const time = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)

function loadCandles(symbol) {
  const filename = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return []
  const all = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line), at = Number(value.time) * 1000
      if (value.partial || !Number.isFinite(at) || at >= SESSION_END + 11 * MINUTE) return []
      const row = { at, open: Number(value.open), high: Number(value.high), low: Number(value.low),
        close: Number(value.close), volume: Number(value.volume) }
      return [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) ? [row] : []
    } catch { return [] }
  }).sort((left, right) => left.at - right.at)
  const ema = { 5: null, 9: null, 20: null }
  for (const row of all) {
    for (const period of [5, 9, 20]) {
      const alpha = 2 / (period + 1)
      ema[period] = ema[period] == null ? row.close : alpha * row.close + (1 - alpha) * ema[period]
      row[`ema${period}`] = ema[period]
    }
  }
  return all.filter((row) => row.at >= SESSION_START && row.at < SESSION_END + 11 * MINUTE)
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
    bidShare: bidSize / (bidSize + askSize || 1), mid: (bid + ask) / 2,
    spreadPct: pct(ask, bid) }
}

function bucket(minute) {
  return { minute, updates: 0, maxGapSec: 0, lastAt: null, bidShare: 0, ofi: 0, traded: 0,
    signed: 0, firstMid: null, lastMid: null, firstSpread: null, lastSpread: null }
}

function finish(value) {
  return { updates: value.updates, maxGapSec: value.maxGapSec,
    avgBidPct: 100 * value.bidShare / value.updates,
    ofi: value.ofi / value.updates,
    deltaPct: value.traded > 0 ? 100 * value.signed / value.traded : 0,
    midReturnPct: pct(value.lastMid, value.firstMid),
    spreadExpansionPct: value.firstSpread > 0 ? 100 * (value.lastSpread / value.firstSpread - 1) : 0 }
}

async function loadDepth(symbol) {
  const filename = path.join(ROOT, "db", "cash-depth", DATE, symbol, `${symbol}.jsonl`)
  const result = new Map()
  if (!fs.existsSync(filename)) return result
  const lines = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity })
  let previous = null, direction = 0, currentBucket = null
  for await (const line of lines) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(row.receivedAt), current = book(row.data), price = Number(row.marketContext?.price)
    const volume = Number(row.marketContext?.cumulativeVolume)
    if (!current || !Number.isFinite(at) || !(price > 0) || !Number.isFinite(volume)) continue
    const minute = Math.floor(at / MINUTE) * MINUTE
    if (!currentBucket || minute !== currentBucket.minute) {
      if (currentBucket) result.set(currentBucket.minute, finish(currentBucket))
      currentBucket = bucket(minute)
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
    currentBucket.maxGapSec = currentBucket.lastAt ? Math.max(currentBucket.maxGapSec, (at - currentBucket.lastAt) / 1000) : 0
    currentBucket.lastAt = at; currentBucket.updates++; currentBucket.bidShare += current.bidShare
    currentBucket.ofi += normalizedOfi; currentBucket.traded += traded; currentBucket.signed += signed
    currentBucket.firstMid ??= current.mid; currentBucket.lastMid = current.mid
    currentBucket.firstSpread ??= current.spreadPct; currentBucket.lastSpread = current.spreadPct
    previous = { at, price, volume, book: current }
  }
  if (currentBucket) result.set(currentBucket.minute, finish(currentBucket))
  return result
}

function trigger(candles, index, depths) {
  if (index < 5) return null
  const row = candles[index], prior = candles[index - 1], fiveBack = candles[index - 5]
  const depth = depths.get(row.at), priorDepth = depths.get(prior.at)
  if (!depth || !priorDepth || depth.updates < 10 || priorDepth.updates < 10 ||
      depth.maxGapSec > 15 || priorDepth.maxGapSec > 15 || depth.midReturnPct <= 0 ||
      depth.spreadExpansionPct > 50) return null
  const ema20Slope5Pct = pct(row.ema20, fiveBack.ema20)
  const gap59Pct = pct(row.ema5, row.ema9), priorGap59Pct = pct(prior.ema5, prior.ema9)
  const distanceEma5Pct = pct(row.close, row.ema5), distanceEma9Pct = pct(row.close, row.ema9)
  const range = row.high - row.low
  const closeLocationPct = range > 0 ? 100 * (row.close - row.low) / range : 50
  const candleReturnPct = pct(row.close, row.open)
  const twoMinuteDelta = mean([priorDepth.deltaPct, depth.deltaPct])
  const twoMinuteMidReturn = priorDepth.midReturnPct + depth.midReturnPct
  const depthFlow = twoMinuteDelta >= 15 && Math.max(priorDepth.deltaPct, depth.deltaPct) >= 25 &&
    twoMinuteMidReturn >= .12 && (depth.ofi > 0 || (depth.ofi > -.02 && depth.ofi - priorDepth.ofi >= .05))
  const trend = row.ema9 > row.ema20 && ema20Slope5Pct > 0
  const continuation = trend && row.ema5 > row.ema9 && gap59Pct > priorGap59Pct && row.close > row.ema5 &&
    candleReturnPct >= .10 && closeLocationPct >= 70 && distanceEma9Pct <= .60 && depthFlow
  const aggressive = trend && Math.abs(distanceEma5Pct) <= .10 && depth.avgBidPct >= 58 &&
    depth.deltaPct >= 25 && depth.ofi > 0 && depth.midReturnPct > 0
  if (!continuation && !aggressive) return null
  return { branch: continuation ? "CONTINUATION" : "PULLBACK_DEPTH", depth, priorDepth,
    candleReturnPct, closeLocationPct, ema20Slope5Pct, gap59Pct, priorGap59Pct,
    distanceEma5Pct, distanceEma9Pct, twoMinuteDelta, twoMinuteMidReturn }
}

function exitTrade(candles, entryIndex, depths) {
  const setup = candles[entryIndex], entry = setup.close
  const candleStop = setup.low * .9998
  const stop = Math.max(entry * .997, candleStop)
  const stopPct = pct(stop, entry)
  const target = entry * 1.005
  const future = candles.slice(entryIndex + 1, entryIndex + 11)
  let outcome = "TIME", exitAt = future.at(-1)?.at ?? setup.at, exitPrice = future.at(-1)?.close ?? entry
  for (const row of future) {
    if (row.low <= stop) { outcome = "STOP"; exitAt = row.at; exitPrice = stop; break }
    if (row.high >= target) { outcome = "TARGET"; exitAt = row.at; exitPrice = target; break }
    const depth = depths.get(row.at)
    if (depth && depth.deltaPct < -20 && depth.ofi < 0) {
      outcome = "DEPTH_EXIT"; exitAt = row.at; exitPrice = row.close; break
    }
  }
  if (future.length < 10 && outcome === "TIME") outcome = "PENDING"
  return { outcome, exitAt, exitPrice, returnPct: pct(exitPrice, entry), stopPct,
    mfePct: future.length ? Math.max(...future.map((row) => pct(row.high, entry))) : 0,
    maePct: future.length ? Math.min(...future.map((row) => pct(row.low, entry))) : 0 }
}

async function analyze(symbol) {
  const candles = loadCandles(symbol), depths = await loadDepth(symbol), signals = []
  for (let index = 5; index < candles.length - 1; index++) {
    const row = candles[index]
    if (row.at < SESSION_START || row.at >= SESSION_END) continue
    const setup = trigger(candles, index, depths)
    if (!setup) continue
    const result = exitTrade(candles, index, depths)
    signals.push({ date: DATE, symbol, branch: setup.branch, setupCandle: time(row.at),
      actionableAt: time(row.at + MINUTE), entry: round(row.close), outcome: result.outcome,
      exitCandle: time(result.exitAt), holdMinutes: Math.round((result.exitAt - row.at) / MINUTE),
      returnPct: round(result.returnPct), stopPct: round(result.stopPct), mfePct: round(result.mfePct), maePct: round(result.maePct),
      ema5: round(row.ema5), ema9: round(row.ema9), ema20: round(row.ema20),
      ema20Slope5Pct: round(setup.ema20Slope5Pct), emaGap59Pct: round(setup.gap59Pct),
      candleReturnPct: round(setup.candleReturnPct), closeLocationPct: round(setup.closeLocationPct),
      distanceEma5Pct: round(setup.distanceEma5Pct), distanceEma9Pct: round(setup.distanceEma9Pct),
      depthUpdates: setup.depth.updates, avgBidPct: round(setup.depth.avgBidPct), ofi: round(setup.depth.ofi),
      deltaPct: round(setup.depth.deltaPct), midReturnPct: round(setup.depth.midReturnPct),
      twoMinuteDeltaPct: round(setup.twoMinuteDelta), twoMinuteMidReturnPct: round(setup.twoMinuteMidReturn) })
    const exitIndex = candles.findIndex((candidate) => candidate.at === result.exitAt)
    if (exitIndex > index) index = exitIndex
  }
  return signals
}

const results = new Array(stocks.length)
let cursor = 0, completed = 0
async function worker() {
  while (true) {
    const index = cursor++
    if (index >= stocks.length) return
    try { results[index] = await analyze(stocks[index]) } catch (error) { results[index] = [{ symbol: stocks[index], error: error.message }] }
    completed++
    if (completed % 20 === 0 || completed === stocks.length) process.stderr.write(`Scanning ${completed}/${stocks.length}: ${stocks[index]}\n`)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
const errors = results.flat().filter((row) => row.error)
const signals = results.flat().filter((row) => !row.error).sort((a, b) => a.setupCandle.localeCompare(b.setupCandle) || a.symbol.localeCompare(b.symbol))
const columns = signals.length ? Object.keys(signals[0]) : []
const output = path.join(ROOT, "csv", `${DATE}-ema-depth-quick-burst-backtest.csv`)
fs.writeFileSync(output, [columns.join(","), ...signals.map((row) => columns.map((column) => row[column]).join(","))].join("\n") + "\n")
const resolved = signals.filter((row) => row.outcome !== "PENDING")
const winners = resolved.filter((row) => row.returnPct > 0), losers = resolved.filter((row) => row.returnPct < 0)
console.log(JSON.stringify({ date: DATE, scanned: stocks.length, errors, output, signals: signals.length,
  resolved: resolved.length, winners: winners.length, losers: losers.length,
  targets: resolved.filter((row) => row.outcome === "TARGET").length,
  stops: resolved.filter((row) => row.outcome === "STOP").length,
  depthExits: resolved.filter((row) => row.outcome === "DEPTH_EXIT").length,
  timeExits: resolved.filter((row) => row.outcome === "TIME").length,
  pending: signals.filter((row) => row.outcome === "PENDING").length,
  grossReturnPct: round(resolved.reduce((sum, row) => sum + row.returnPct, 0)),
  averageReturnPct: round(resolved.reduce((sum, row) => sum + row.returnPct, 0) / Math.max(1, resolved.length)),
  rows: signals }, null, 2))
