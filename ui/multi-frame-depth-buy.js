import { depthUpdateFields } from "./market-depth.js"
import { toStockName } from "./market-data.js"

const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const MAX_CANDLES = 400
const EVALUATION_DELAY_MS = 2_000
const TARGET_PCT = 2
const STOP_PCT = 0.4
const indiaDate = (time) => new Date(time + IST_OFFSET).toISOString().slice(0, 10)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)
const mean = (values) => values.length ? sum(values) / values.length : NaN

function normalizeCandle(input) {
  if (!input || input.partial) return null
  const candle = { time: Math.floor(Number(input.time) / 60) * 60,
    open: Number(input.open), high: Number(input.high), low: Number(input.low),
    close: Number(input.close), volume: Number(input.volume) }
  return Number.isFinite(candle.time) &&
    [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) &&
    candle.open > 0 && candle.low > 0 && candle.high >= candle.low && candle.volume >= 0 ? candle : null
}

function bookMetrics(fields) {
  let bidSize = 0, askSize = 0, topBidSize = 0, topAskSize = 0, bid = NaN, ask = NaN
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBidSize = Number(fields[`bid_size${level}`])
    const currentAskSize = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBidSize, currentAskSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBidSize < 0 || currentAskSize < 0) return null
    if (level === 1) { bid = bidPrice; ask = askPrice }
    bidSize += currentBidSize
    askSize += currentAskSize
    if (level <= 2) { topBidSize += currentBidSize; topAskSize += currentAskSize }
  }
  return { bid, ask, full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (topBidSize - topAskSize) / (topBidSize + topAskSize || 1) }
}

function rsi14(rows) {
  if (rows.length < 15) return NaN
  let gains = 0, losses = 0
  for (let index = rows.length - 14; index < rows.length; index++) {
    const change = rows[index].close - rows[index - 1].close
    if (change > 0) gains += change
    else losses -= change
  }
  return losses ? 100 - 100 / (1 + gains / losses) : 100
}

function atr14(rows) {
  if (rows.length < 15) return NaN
  const trailing = rows.slice(-15)
  const ranges = []
  for (let index = 1; index < trailing.length; index++) {
    const current = trailing[index]
    const previousClose = trailing[index - 1].close
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose)))
  }
  return 100 * mean(ranges) / trailing.at(-1).close
}

function greenVolumeShare(rows) {
  const volume = sum(rows.map((row) => row.volume))
  return volume ? sum(rows.filter((row) => row.close >= row.open).map((row) => row.volume)) / volume : 0
}

function vwapGap(rows) {
  const volume = sum(rows.map((row) => row.volume))
  if (!volume) return NaN
  const vwap = sum(rows.map((row) => row.volume * (row.high + row.low + row.close) / 3)) / volume
  return pct(rows.at(-1).close, vwap)
}

function slopePct(rows) {
  if (rows.length < 2) return NaN
  const closes = rows.map((row) => row.close)
  const count = closes.length
  const sumX = count * (count - 1) / 2
  const sumY = sum(closes)
  const sumXX = (count - 1) * count * (2 * count - 1) / 6
  const sumXY = closes.reduce((total, close, index) => total + index * close, 0)
  const denominator = count * sumXX - sumX * sumX
  if (!denominator || !sumY) return 0
  return ((count * sumXY - sumX * sumY) / denominator) / (sumY / count) * 100
}

function emaSeries(values, period) {
  if (!values.length) return []
  const multiplier = 2 / (period + 1)
  let ema = values[0]
  const series = [ema]
  for (const value of values.slice(1)) {
    ema = value * multiplier + ema * (1 - multiplier)
    series.push(ema)
  }
  return series
}

function aggregateLastComplete(rows, length) {
  let latest = null
  for (let index = 0; index + length <= rows.length; index += length) {
    const group = rows.slice(index, index + length)
    latest = { high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)) }
  }
  return latest
}

function branchFor(metrics) {
  if (metrics.slope50 <= 0.02 && metrics.positiveDepthShare15 <= 2 / 3 &&
      metrics.askDrift3 > 0.04 && metrics.greenVolume50 <= 0.62 &&
      metrics.recovery50 > 1.34 && metrics.range3 <= 0.22 &&
      metrics.return30 <= 0.91 && metrics.rsi14 < 80) return "controlled_recovery"
  if (metrics.atr14 <= 0.24 && metrics.dayReturn > -0.70 &&
      metrics.greenVolume30 <= 0.33 && metrics.pullback10 > 0.32 &&
      metrics.return3 > -0.05) return "low_volatility_pullback"
  if (metrics.slope50 <= 0.018 && metrics.atr14 > 0.24 &&
      metrics.dayReturn > -1.90 && metrics.ema5Slope10 <= 0.004 &&
      metrics.greenVolume5 > 0.59 && metrics.depthChange15 > 0.065) return "improving_depth"
  if (metrics.atr14 > 0.24 && metrics.dayReturn <= -1.90 &&
      metrics.top2Imbalance3 > 0.04 && metrics.pullback15 > 0.57) return "gap_recovery"
  return null
}

export function createMultiFrameDepthBuyRadar({
  onUpdate = () => {}, initialSignals = [], now = () => Date.now(),
} = {}) {
  const candlesByStock = new Map()
  const depthByStock = new Map()
  const booksByStock = new Map()
  const evaluatedByStock = new Map()
  const signals = initialSignals.slice()
  const signalIds = new Set(signals.map((signal) => signal.id))
  const usedStock = new Set(signals.map((signal) => signal.symbol))
  let sessionDate = indiaDate(now())

  function snapshot() { return signals.slice().reverse() }
  function publish() { onUpdate(snapshot(), sessionDate) }

  function resetDay(date) {
    sessionDate = date
    candlesByStock.clear(); depthByStock.clear(); booksByStock.clear(); evaluatedByStock.clear()
    signals.length = 0; signalIds.clear(); usedStock.clear(); publish()
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) resetDay(today)
    resetLiveState()
    const completedBefore = Math.floor(now() / MINUTE) * MINUTE
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_CANDLES })
        candlesByStock.set(symbol, rows.map(normalizeCandle).filter((row) => row &&
          indiaDate(row.time * 1000) === sessionDate && row.time * 1000 + MINUTE <= completedBefore)
          .slice(-MAX_CANDLES))
      } catch { candlesByStock.set(symbol, []) }
    }))
  }

  function observeCandle(symbol, input) {
    const candle = normalizeCandle(input)
    if (!symbol || !candle) return
    const date = indiaDate(candle.time * 1000)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    const rows = candlesByStock.get(symbol) || []
    const index = rows.findIndex((row) => row.time === candle.time)
    if (index >= 0) rows[index] = candle
    else rows.push(candle)
    rows.sort((left, right) => left.time - right.time)
    candlesByStock.set(symbol, rows.slice(-MAX_CANDLES))

    const active = signals.find((signal) => signal.symbol === symbol && signal.status === "Active")
    if (!active || candle.time * 1000 <= Date.parse(active.time)) return
    if (candle.low <= active.stop) active.status = "Stopped"
    else if (candle.high >= active.target) active.status = "Target reached"
    else return
    active.resolvedAt = new Date(candle.time * 1000).toISOString()
    publish()
  }

  function observeDepth(data, receivedAt) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!symbol || !Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    const update = depthUpdateFields(data)
    if (!update) return
    let state = booksByStock.get(symbol)
    if (!state || at - state.lastAt > 90_000) state = { fields: {}, book: null, lastAt: at }
    for (const [key, value] of update) state.fields[key] = value
    const book = bookMetrics(state.fields)
    state.book = book; state.lastAt = at; booksByStock.set(symbol, state)
    if (!book) return
    const minute = Math.floor(at / MINUTE) * MINUTE
    let buckets = depthByStock.get(symbol)
    if (!buckets) buckets = new Map()
    const bucket = buckets.get(minute) || { count: 0, full: 0, top2: 0,
      firstAsk: book.ask, lastAsk: book.ask }
    bucket.count++; bucket.full += book.full; bucket.top2 += book.top2; bucket.lastAsk = book.ask
    buckets.set(minute, bucket)
    for (const key of buckets.keys()) if (key < minute - 20 * MINUTE) buckets.delete(key)
    depthByStock.set(symbol, buckets)
  }

  function observePrice(data, receivedAt) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    const price = Number(data.ltp)
    if (!symbol || !Number.isFinite(at) || !Number.isFinite(price) || price <= 0) return
    const active = signals.find((signal) => signal.symbol === symbol && signal.status === "Active")
    if (!active || at <= Date.parse(active.time)) return
    if (price <= active.stop) active.status = "Stopped"
    else if (price >= active.target) active.status = "Target reached"
    else return
    active.resolvedAt = new Date(at).toISOString()
    publish()
  }

  function evaluate(symbol, signalMinute, at) {
    if (usedStock.has(symbol)) return
    const rows = (candlesByStock.get(symbol) || []).filter((row) =>
      indiaDate(row.time * 1000) === sessionDate && row.time * 1000 + MINUTE <= signalMinute)
    const last15 = rows.slice(-15)
    if (last15.length < 15 || last15.some((row, index) =>
      index > 0 && row.time !== last15[index - 1].time + 60)) return
    const last = last15.at(-1)
    if (last.time * 1000 + MINUTE !== signalMinute) return
    const return15 = pct(last.close, last15[0].open)
    const rsi = rsi14(last15)
    const pullback15 = pct(Math.max(...last15.map((row) => row.high)), last.close)
    const vwapGap15 = vwapGap(last15)
    const dayReturn = pct(last.close, rows[0].open)
    if (!(return15 >= 0.30 && rsi >= 50 && rsi <= 92 && pullback15 >= 0.05 &&
        pullback15 <= 2 && vwapGap15 >= -0.20 && dayReturn <= 10)) return

    const buckets = depthByStock.get(symbol)
    if (!buckets) return
    const depth = []
    for (let minute = signalMinute - 15 * MINUTE; minute < signalMinute; minute += MINUTE) {
      const bucket = buckets.get(minute)
      if (bucket?.count >= 3) depth.push(bucket)
    }
    if (depth.length < 8) return
    const depthImbalance15 = mean(depth.map((bucket) => bucket.full / bucket.count))
    const askDrift15 = pct(depth.at(-1).lastAsk, depth[0].firstAsk)
    if (!(askDrift15 >= 0 && depthImbalance15 > -0.50)) return

    const last3 = rows.slice(-3), last5 = rows.slice(-5), last10 = rows.slice(-10)
    const last30 = rows.slice(-30), last50 = rows.slice(-50), lastDepth3 = depth.slice(-3)
    const ema5 = emaSeries(rows.map((row) => row.close), 5)
    const aggregate3 = aggregateLastComplete(rows, 3)
    const metrics = { return15, rsi14: rsi, pullback15, vwapGap15, dayReturn,
      depthMinutes: depth.length, depthImbalance15, askDrift15,
      slope50: slopePct(last50),
      positiveDepthShare15: depth.filter((bucket) => bucket.full / bucket.count > 0).length / depth.length,
      askDrift3: pct(lastDepth3.at(-1).lastAsk, lastDepth3[0].firstAsk),
      greenVolume50: greenVolumeShare(last50),
      recovery50: pct(last.close, Math.min(...last50.map((row) => row.low))),
      range3: aggregate3 ? pct(aggregate3.high, aggregate3.low) : NaN,
      return30: pct(last.close, last30[0].open), atr14: atr14(rows),
      greenVolume30: greenVolumeShare(last30),
      pullback10: pct(Math.max(...last10.map((row) => row.high)), last.close),
      return3: pct(last.close, last3[0].open),
      ema5Slope10: ema5.length >= 11 ? pct(ema5.at(-1), ema5.at(-11)) / 10 : NaN,
      greenVolume5: greenVolumeShare(last5),
      depthChange15: depth.at(-1).full / depth.at(-1).count - depth[0].full / depth[0].count,
      top2Imbalance3: mean(lastDepth3.map((bucket) => bucket.top2 / bucket.count)) }
    const branch = branchFor(metrics)
    if (!branch) return
    const quote = booksByStock.get(symbol)
    const entry = quote?.book?.ask
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(quote.lastAt) ||
        quote.lastAt < signalMinute || at - quote.lastAt > 5_000) return
    const id = `${symbol}:${Math.floor(signalMinute / 1000)}:multi-frame-depth-buy`
    if (signalIds.has(id)) return
    const patterns = { controlled_recovery: "Controlled recovery with a rising best ask",
      low_volatility_pullback: "Low-volatility pullback continuation",
      improving_depth: "Improving depth behind short-term momentum",
      gap_recovery: "Gap recovery with top-level bid support" }
    signals.push({ id, strategy: "Multi-Frame Depth Recovery", symbol, direction: "BUY",
      pattern: patterns[branch], time: new Date(at).toISOString(), price: entry,
      stop: entry * (1 - STOP_PCT / 100), target: entry * (1 + TARGET_PCT / 100),
      status: "Active", candleMinute: last.time, metrics: { ...metrics, filterBranch: branch } })
    signalIds.add(id); usedStock.add(symbol); publish()
  }

  function flushCompleted(timestamp = now()) {
    const at = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp)
    if (!Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date > sessionDate) resetDay(date)
    const signalMinute = Math.floor((at - EVALUATION_DELAY_MS) / MINUTE) * MINUTE
    for (const [symbol, buckets] of depthByStock) {
      if (!buckets.has(signalMinute - MINUTE) ||
          (evaluatedByStock.get(symbol) ?? -Infinity) >= signalMinute) continue
      const rows = candlesByStock.get(symbol) || []
      if (!rows.some((row) => row.time * 1000 === signalMinute - MINUTE)) continue
      const quoteAt = booksByStock.get(symbol)?.lastAt
      if (!Number.isFinite(quoteAt) || quoteAt < signalMinute || at - quoteAt > 5_000) continue
      evaluatedByStock.set(symbol, signalMinute)
      evaluate(symbol, signalMinute, at)
    }
  }

  function resetLiveState() { depthByStock.clear(); booksByStock.clear(); evaluatedByStock.clear() }
  return { seed, observeCandle, observeDepth, observePrice, flushCompleted, resetLiveState, snapshot }
}
