import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

const REQUESTED_DATE = argumentValue("--date")
const ALL_WINDOWS = process.argv.includes("--all-windows")
const UNTIL_TIME = argumentValue("--until")
const outputSuffix = REQUESTED_DATE && ALL_WINDOWS ? `-${REQUESTED_DATE}-all-windows` : ""
const OUTPUT = path.join(ROOT, "reports", `candle-depth-profit-dataset${outputSuffix}.json`)
const MINUTE = 60_000
const INDIA_OFFSET = 330 * MINUTE
const STOP_PCT = 0.5
const TARGET_PCT = 1
const BREAKEVEN_TRIGGER_PCT = 0.5
const TRAIL_DISTANCE_PCT = 0.4
const MAX_HOLD_MINUTES = 120
const MIN_VOLUME_HISTORY = 4

function indiaDate(epoch) {
  return new Date(epoch + INDIA_OFFSET).toISOString().slice(0, 10)
}

function indiaTime(epoch) {
  return new Date(epoch + INDIA_OFFSET).toISOString().slice(11, 16)
}

function localEpoch(date, hour, minute) {
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hour, minute) - INDIA_OFFSET
}

function mean(values) {
  const valid = values.filter(Number.isFinite)
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position), upper = Math.ceil(position)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function pct(current, base) {
  return Number.isFinite(current) && Number.isFinite(base) && base !== 0 ? 100 * (current / base - 1) : 0
}

function readJsonLines(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function readCandles(symbol, dates) {
  const wanted = new Set(dates)
  const byDate = new Map()
  for (const row of readJsonLines(path.join(CANDLE_ROOT, `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000
    const date = indiaDate(at)
    if (!Number.isFinite(at) || !wanted.has(date)) continue
    const candle = {
      at, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) || 0,
    }
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(candle)
  }
  for (const rows of byDate.values()) rows.sort((left, right) => left.at - right.at)
  return byDate
}

function validBook(fields) {
  let bid = 0, ask = 0, topBid = 0, topAsk = 0
  for (let level = 1; level <= 5; level++) {
    const bp = Number(fields[`bid_price${level}`]), ap = Number(fields[`ask_price${level}`])
    const bq = Number(fields[`bid_size${level}`]), aq = Number(fields[`ask_size${level}`])
    if (![bp, ap, bq, aq].every(Number.isFinite) || bp <= 0 || ap <= bp || bq < 0 || aq < 0) return null
    bid += bq; ask += aq
    if (level <= 2) { topBid += bq; topAsk += aq }
  }
  const bestBid = Number(fields.bid_price1), bestAsk = Number(fields.ask_price1)
  return {
    bid, ask, bestBid, bestAsk,
    bidShare: 100 * bid / (bid + ask || 1),
    top2BidShare: 100 * topBid / (topBid + topAsk || 1),
    mid: (bestBid + bestAsk) / 2,
    spreadBps: 10_000 * (bestAsk - bestBid) / ((bestBid + bestAsk) / 2),
  }
}

function newBucket() {
  return {
    volume: 0, askLiftVolume: 0, samples: 0, bidShareSum: 0, top2BidShareSum: 0,
    bidDominant: 0, spreadBpsSum: 0, askRises: 0, bidRises: 0, transitions: 0,
    ofiSum: 0, ofiSamples: 0, askDepletionSum: 0, askDepletionSamples: 0,
    firstBidShare: null, lastBidShare: null, firstMid: null, lastMid: null,
  }
}

function readDepth(symbol, date) {
  const filename = path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)
  const byMinute = new Map()
  const fields = {}
  let previousVolume = null, previousBook = null, previousAskSize = null
  for (const record of readJsonLines(filename)) {
    const receivedAt = Date.parse(record.receivedAt)
    const priceAt = Date.parse(record.marketContext?.priceAt) || receivedAt
    if (!Number.isFinite(priceAt) || indiaDate(priceAt) !== date) continue
    for (const [key, value] of Object.entries(record.data || {})) {
      if (/^(bid|ask)_(price|size|order)[1-5]$/.test(key)) fields[key] = value
    }
    const book = validBook(fields)
    if (!book) continue
    const minute = Math.floor(priceAt / MINUTE) * MINUTE
    const bucket = byMinute.get(minute) || newBucket()
    const cumulativeVolume = Number(record.marketContext?.cumulativeVolume)
    const executed = Number.isFinite(cumulativeVolume) && previousVolume !== null && cumulativeVolume >= previousVolume
      ? cumulativeVolume - previousVolume : 0
    bucket.volume += executed
    if (executed > 0 && previousBook && book.bestAsk > previousBook.bestAsk) bucket.askLiftVolume += executed
    bucket.samples++
    bucket.bidShareSum += book.bidShare
    bucket.top2BidShareSum += book.top2BidShare
    bucket.bidDominant += book.bidShare > 50 ? 1 : 0
    bucket.spreadBpsSum += book.spreadBps
    bucket.firstBidShare ??= book.bidShare
    bucket.lastBidShare = book.bidShare
    bucket.firstMid ??= book.mid
    bucket.lastMid = book.mid
    if (previousBook) {
      bucket.transitions++
      bucket.askRises += book.bestAsk > previousBook.bestAsk ? 1 : 0
      bucket.bidRises += book.bestBid > previousBook.bestBid ? 1 : 0
      const bidChange = book.bid - previousBook.bid
      const askChange = book.ask - previousBook.ask
      const denominator = Math.abs(bidChange) + Math.abs(askChange)
      if (denominator > 0) {
        bucket.ofiSum += (bidChange - askChange) / denominator
        bucket.ofiSamples++
      }
      const askSize = Number(fields.ask_size1)
      if (book.bestAsk === previousBook.bestAsk && Number.isFinite(askSize) && Number.isFinite(previousAskSize) && previousAskSize > 0) {
        bucket.askDepletionSum += Math.max(0, previousAskSize - askSize) / previousAskSize
        bucket.askDepletionSamples++
      }
    }
    byMinute.set(minute, bucket)
    if (Number.isFinite(cumulativeVolume)) previousVolume = cumulativeVolume
    previousBook = book
    previousAskSize = Number(fields.ask_size1)
  }
  return byMinute
}

function ema(values, period) {
  if (!values.length) return 0
  const alpha = 2 / (period + 1)
  return values.slice(1).reduce((value, current) => alpha * current + (1 - alpha) * value, values[0])
}

function rsi(values, period = 14) {
  const selected = values.slice(-(period + 1))
  if (selected.length < 2) return 50
  let gains = 0, losses = 0
  for (let index = 1; index < selected.length; index++) {
    const change = selected[index] - selected[index - 1]
    if (change > 0) gains += change
    else losses -= change
  }
  if (losses === 0) return gains > 0 ? 100 : 50
  return 100 - 100 / (1 + gains / losses)
}

function windowReturn(rows, count) {
  const selected = rows.slice(-count)
  return selected.length ? pct(selected.at(-1).close, selected[0].open) : 0
}

function candleFeatures(rows, index, five) {
  const history = rows.slice(0, index + 1)
  const closes = history.map((row) => row.close)
  const current = five.at(-1)
  const high = Math.max(...five.map((row) => row.high))
  const low = Math.min(...five.map((row) => row.low))
  const range = high - low
  const moves = five.slice(1).map((row, moveIndex) => Math.abs(row.close - five[moveIndex].close))
  const path = moves.reduce((sum, value) => sum + value, 0)
  const previous20 = history.slice(-21, -1)
  const dayVolume = history.reduce((sum, row) => sum + row.volume, 0)
  const vwap = dayVolume > 0
    ? history.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / dayVolume
    : current.close
  const trueRanges = history.slice(-14).map((row, rangeIndex, selected) => {
    const previousClose = rangeIndex ? selected[rangeIndex - 1].close : row.open
    return Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose))
  })
  const ema5 = ema(closes, 5), ema10 = ema(closes, 10), ema20 = ema(closes, 20)
  return {
    timeMinute: Number(indiaTime(current.at).slice(0, 2)) * 60 + Number(indiaTime(current.at).slice(3)),
    return1: windowReturn(history, 1), return3: windowReturn(history, 3), return5: windowReturn(history, 5),
    return10: windowReturn(history, 10), return15: windowReturn(history, 15), return30: windowReturn(history, 30),
    openingReturn: pct(current.close, history[0].open),
    green3: history.slice(-3).filter((row) => row.close > row.open).length,
    green5: five.filter((row) => row.close > row.open).length,
    green10: history.slice(-10).filter((row) => row.close > row.open).length,
    closeLocation: range > 0 ? 100 * (current.close - low) / range : 0,
    bodyEfficiency: range > 0 ? 100 * five.reduce((sum, row) => sum + Math.abs(row.close - row.open), 0) / range : 0,
    trendEfficiency5: path > 0 ? 100 * (current.close - five[0].close) / path : 0,
    range5Pct: pct(high, low), pullbackFromHigh5: pct(current.close, high),
    breakout20: previous20.length ? pct(current.close, Math.max(...previous20.map((row) => row.high))) : 0,
    distanceDayHigh: pct(current.close, Math.max(...history.map((row) => row.high))),
    ema5Gap: pct(current.close, ema5), ema10Gap: pct(current.close, ema10), ema20Gap: pct(current.close, ema20),
    emaAlignment: pct(ema5, ema10) + pct(ema10, ema20),
    rsi14: rsi(closes), vwapGap: pct(current.close, vwap),
    atr14Pct: pct(mean(trueRanges) + current.close, current.close),
    candleVolume5: five.reduce((sum, row) => sum + row.volume, 0),
    candleVolumeAcceleration: five.slice(0, 4).reduce((sum, row) => sum + row.volume, 0) > 0
      ? 4 * current.volume / five.slice(0, 4).reduce((sum, row) => sum + row.volume, 0) : 0,
  }
}

function aggregateDepth(depth) {
  const volume = depth.reduce((sum, row) => sum + row.volume, 0)
  const samples = depth.reduce((sum, row) => sum + row.samples, 0)
  const transitions = depth.reduce((sum, row) => sum + row.transitions, 0)
  const ofiSamples = depth.reduce((sum, row) => sum + row.ofiSamples, 0)
  const depletionSamples = depth.reduce((sum, row) => sum + row.askDepletionSamples, 0)
  const first = depth.find((row) => Number.isFinite(row.firstMid))
  const last = [...depth].reverse().find((row) => Number.isFinite(row.lastMid))
  return {
    depthVolume: volume,
    askLift: volume > 0 ? 100 * depth.reduce((sum, row) => sum + row.askLiftVolume, 0) / volume : 0,
    bidShare: samples ? depth.reduce((sum, row) => sum + row.bidShareSum, 0) / samples : 0,
    top2BidShare: samples ? depth.reduce((sum, row) => sum + row.top2BidShareSum, 0) / samples : 0,
    bidDominantPct: samples ? 100 * depth.reduce((sum, row) => sum + row.bidDominant, 0) / samples : 0,
    spreadBps: samples ? depth.reduce((sum, row) => sum + row.spreadBpsSum, 0) / samples : 0,
    bidShareChange: last && first ? last.lastBidShare - first.firstBidShare : 0,
    depthMidReturn: last && first ? pct(last.lastMid, first.firstMid) : 0,
    askRisePct: transitions ? 100 * depth.reduce((sum, row) => sum + row.askRises, 0) / transitions : 0,
    bidRisePct: transitions ? 100 * depth.reduce((sum, row) => sum + row.bidRises, 0) / transitions : 0,
    normalizedOfi: ofiSamples ? depth.reduce((sum, row) => sum + row.ofiSum, 0) / ofiSamples : 0,
    askDepletion: depletionSamples ? 100 * depth.reduce((sum, row) => sum + row.askDepletionSum, 0) / depletionSamples : 0,
    depthSamples: samples,
  }
}

function trailingOutcome(signalAt, candles) {
  const future = candles.filter((row) => row.at >= signalAt && row.at < signalAt + MAX_HOLD_MINUTES * MINUTE)
  if (!future.length) return { outcome: "NO_DATA", winner: false, returnPct: 0 }
  const entry = future[0].open
  const target = entry * (1 + TARGET_PCT / 100)
  const mfePct = pct(Math.max(...future.map((row) => row.high)), entry)
  const maePct = pct(Math.min(...future.map((row) => row.low)), entry)
  let stop = entry * (1 - STOP_PCT / 100), highWater = entry, reachedTarget = false
  for (const row of future) {
    if (row.low <= stop) {
      const returnPct = pct(stop, entry)
      return { outcome: reachedTarget ? "TRAIL" : "STOP", winner: returnPct > TARGET_PCT,
        returnPct, entry, mfePct, maePct }
    }
    highWater = Math.max(highWater, row.high)
    if (highWater >= entry * (1 + BREAKEVEN_TRIGGER_PCT / 100)) stop = Math.max(stop, entry)
    if (highWater >= target) {
      reachedTarget = true
      stop = Math.max(stop, entry, highWater * (1 - TRAIL_DISTANCE_PCT / 100))
    }
  }
  const returnPct = pct(future.at(-1).close, entry)
  return { outcome: reachedTarget ? "TARGET_TIME" : "TIME", winner: returnPct > TARGET_PCT,
    returnPct, entry, mfePct, maePct }
}

function candidatesFor(symbol, date, candles, depthByMinute, { allWindows = false, untilTime = null } = {}) {
  const rows = candles.filter((row) => row.at >= localEpoch(date, 9, 15) && row.at < localEpoch(date, 15, 31))
  const volumeHistory = []
  const candidates = []
  for (let index = 4; index < rows.length; index++) {
    const five = rows.slice(index - 4, index + 1)
    if (five.some((row, offset) => offset && row.at !== five[offset - 1].at + MINUTE)) continue
    const start = five[0].at, confirmedAt = five.at(-1).at + MINUTE
    if (untilTime && indiaTime(confirmedAt) > untilTime) continue
    const depth = five.map((_, offset) => depthByMinute.get(start + offset * MINUTE))
    if (depth.some((row) => !row)) continue
    const depthFeatures = aggregateDepth(depth)
    const volumeThreshold = percentile(volumeHistory, 0.75)
    const volumeRatio = volumeThreshold > 0 ? depthFeatures.depthVolume / volumeThreshold : 0
    volumeHistory.push(depthFeatures.depthVolume)
    if (!allWindows && volumeHistory.length < MIN_VOLUME_HISTORY) continue
    const features = { ...candleFeatures(rows, index, five), ...depthFeatures,
      volumeRatio, volumeThreshold, volumeHistorySamples: volumeHistory.length - 1 }
    const baseQualified = features.green5 >= 3 && features.return5 > 0 && features.closeLocation >= 80 &&
        features.bodyEfficiency >= 80 && features.depthVolume >= volumeThreshold &&
        features.askLift >= 50 && features.bidShare > 50
    if (!allWindows && (features.green5 < 3 || features.return5 <= 0 || features.closeLocation < 80 ||
        features.bodyEfficiency < 80 || features.depthVolume < volumeThreshold ||
        features.askLift < 50 || features.bidShare <= 50)) continue
    const candidate = {
      date, symbol, confirmedAt, time: indiaTime(confirmedAt), baseQualified, features,
      ...trailingOutcome(confirmedAt, rows),
    }
    if (!allWindows) return candidate
    candidates.push(candidate)
  }
  return allWindows ? candidates : null
}

const dates = fs.readdirSync(DEPTH_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name).filter((date) => !REQUESTED_DATE || date === REQUESTED_DATE).sort()
const stocks = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
  .map((symbol) => String(symbol).trim().toUpperCase().replace(/-EQ$/, ""))
const rows = []

for (const date of dates) {
  const started = Date.now()
  let found = 0
  for (const symbol of stocks) {
    const candles = readCandles(symbol, [date]).get(date) || []
    if (!candles.length) continue
    const candidate = candidatesFor(symbol, date, candles, readDepth(symbol, date), {
      allWindows: ALL_WINDOWS, untilTime: UNTIL_TIME,
    })
    if (ALL_WINDOWS) { rows.push(...candidate); found += candidate.length }
    else if (candidate) { rows.push(candidate); found++ }
  }
  console.error(`${date}: ${found} candidates (${((Date.now() - started) / 1000).toFixed(1)}s)`)
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
fs.writeFileSync(OUTPUT, JSON.stringify({
  generatedAt: new Date().toISOString(), dates, allWindows: ALL_WINDOWS, untilTime: UNTIL_TIME, strategy: {
    baseFilters: ["green5 >= 3", "return5 > 0", "closeLocation >= 80", "bodyEfficiency >= 80",
      "depthVolume >= causal same-day p75", "askLift >= 50", "bidShare > 50"],
    outcome: { targetPct: TARGET_PCT, stopPct: STOP_PCT, breakevenTriggerPct: BREAKEVEN_TRIGGER_PCT,
      trailDistancePct: TRAIL_DISTANCE_PCT, maxHoldMinutes: MAX_HOLD_MINUTES },
  }, rows,
}, null, 2))
console.log(JSON.stringify({ output: OUTPUT, dates, candidates: rows.length,
  winners: rows.filter((row) => row.winner).length }, null, 2))
