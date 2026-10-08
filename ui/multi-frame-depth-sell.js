import { depthUpdateFields } from "./market-depth.js"
import { toStockName } from "./market-data.js"

const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const MAX_CANDLES = 400
const TARGET_PCT = 2
const STOP_PCT = 0.4
const EVALUATION_DELAY_MS = 2_000

const indiaDate = (time) => new Date(time + IST_OFFSET).toISOString().slice(0, 10)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)
const mean = (values) => values.length ? sum(values) / values.length : NaN

function normalizeCandle(input) {
  if (!input || input.partial) return null
  const candle = {
    time: Math.floor(Number(input.time) / 60) * 60,
    open: Number(input.open), high: Number(input.high), low: Number(input.low),
    close: Number(input.close), volume: Number(input.volume),
  }
  return Number.isFinite(candle.time) &&
    [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) &&
    candle.open > 0 && candle.low > 0 && candle.high >= candle.low && candle.volume >= 0
    ? candle : null
}

function bookMetrics(fields) {
  let bidSize = 0
  let askSize = 0
  let bidOrders = 0
  let askOrders = 0
  let topBidSize = 0
  let topAskSize = 0
  let bid = NaN
  let ask = NaN
  let bid1 = NaN
  let ask1 = NaN
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBidSize = Number(fields[`bid_size${level}`])
    const currentAskSize = Number(fields[`ask_size${level}`])
    const currentBidOrders = Number(fields[`bid_order${level}`])
    const currentAskOrders = Number(fields[`ask_order${level}`])
    if (![bidPrice, askPrice, currentBidSize, currentAskSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBidSize < 0 || currentAskSize < 0) return null
    if (level === 1) {
      bid = bidPrice
      ask = askPrice
      bid1 = currentBidSize
      ask1 = currentAskSize
    }
    bidSize += currentBidSize
    askSize += currentAskSize
    bidOrders += Number.isFinite(currentBidOrders) && currentBidOrders >= 0 ? currentBidOrders : 0
    askOrders += Number.isFinite(currentAskOrders) && currentAskOrders >= 0 ? currentAskOrders : 0
    if (level <= 2) {
      topBidSize += currentBidSize
      topAskSize += currentAskSize
    }
  }
  return {
    bid, ask, bid1, ask1,
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (topBidSize - topAskSize) / (topBidSize + topAskSize || 1),
    orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1),
    bidShare: bidSize / (bidSize + askSize || 1),
  }
}

function rsi14(rows) {
  if (rows.length < 15) return NaN
  let gains = 0
  let losses = 0
  for (let index = rows.length - 14; index < rows.length; index++) {
    const change = rows[index].close - rows[index - 1].close
    if (change > 0) gains += change
    else losses -= change
  }
  return losses ? 100 - 100 / (1 + gains / losses) : 100
}

function greenVolumeShare(rows) {
  const volume = sum(rows.map((row) => row.volume))
  return volume ? sum(rows.filter((row) => row.close >= row.open).map((row) => row.volume)) / volume : 0
}

function vwapGap(rows) {
  const volume = sum(rows.map((row) => row.volume))
  if (!volume) return NaN
  const vwap = sum(rows.map((row) =>
    row.volume * (row.high + row.low + row.close) / 3)) / volume
  return pct(rows.at(-1).close, vwap)
}

function branchFor(metrics) {
  const sustainedSelling = metrics.rsi14 > 24.5 && metrics.greenVolume50 <= 0.30 &&
    metrics.vwapGap10 <= -0.08 && metrics.greenVolume15 > 0.14
  if (sustainedSelling) return "sustained_selling_volume"

  const weakRecovery = metrics.rsi14 > 24.5 && metrics.rsi14 < 38 &&
    metrics.greenVolume50 > 0.29 && metrics.vwapGap50 > -0.45 &&
    metrics.recovery15 > 0.40 && metrics.bidDrift15 <= -0.70
  if (weakRecovery) return "weak_recovery_falling_bid"

  const temporaryRecovery = metrics.rsi14 > 24.5 && metrics.greenVolume50 <= 0.30 &&
    metrics.vwapGap10 >= 0 && metrics.greenVolume30 > 0.25 &&
    metrics.return15 > -1.60 && metrics.volumeRatio3 > 2 && metrics.normalizedOfi15 > 0
  return temporaryRecovery ? "temporary_price_recovery" : null
}

export function createMultiFrameDepthSellRadar({
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
    candlesByStock.clear()
    depthByStock.clear()
    booksByStock.clear()
    evaluatedByStock.clear()
    signals.length = 0
    signalIds.clear()
    usedStock.clear()
    publish()
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) resetDay(today)
    resetLiveState()
    const completedBefore = Math.floor(now() / MINUTE) * MINUTE
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_CANDLES })
        const candles = rows.map(normalizeCandle).filter((row) => row &&
          indiaDate(row.time * 1000) === sessionDate && row.time * 1000 + MINUTE <= completedBefore)
        candlesByStock.set(symbol, candles.slice(-MAX_CANDLES))
      } catch {
        candlesByStock.set(symbol, [])
      }
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
    if (candle.high >= active.stop) active.status = "Stopped"
    else if (candle.low <= active.target) active.status = "Target reached"
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
    const previous = state.book
    const book = bookMetrics(state.fields)
    state.book = book
    state.lastAt = at
    booksByStock.set(symbol, state)
    if (!book) return

    let normalizedOfi = 0
    if (previous) {
      let orderFlow = 0
      orderFlow += book.bid > previous.bid ? book.bid1
        : book.bid === previous.bid ? book.bid1 - previous.bid1 : -previous.bid1
      orderFlow -= book.ask < previous.ask ? book.ask1
        : book.ask === previous.ask ? book.ask1 - previous.ask1 : -previous.ask1
      normalizedOfi = orderFlow / (book.bid1 + book.ask1 || 1)
    }

    const minute = Math.floor(at / MINUTE) * MINUTE
    let buckets = depthByStock.get(symbol)
    if (!buckets) buckets = new Map()
    const bucket = buckets.get(minute) || {
      count: 0, full: 0, top2: 0, orders: 0, bidShare: 0, normalizedOfi: 0,
      firstBid: book.bid, lastBid: book.bid,
    }
    bucket.count++
    bucket.full += book.full
    bucket.top2 += book.top2
    bucket.orders += book.orders
    bucket.bidShare += book.bidShare
    bucket.normalizedOfi += normalizedOfi
    bucket.lastBid = book.bid
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
    if (price >= active.stop) active.status = "Stopped"
    else if (price <= active.target) active.status = "Target reached"
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
    const recovery15 = pct(last.close, Math.min(...last15.map((row) => row.low)))
    const vwapGap15 = vwapGap(last15)
    const dayReturn = pct(last.close, rows[0].open)
    if (!(return15 <= -1 && rsi >= 15 && rsi <= 40 &&
        recovery15 >= 0.20 && recovery15 <= 1.20 &&
        vwapGap15 <= 0 && dayReturn >= -6)) return

    const buckets = depthByStock.get(symbol)
    if (!buckets) return
    const depth = []
    for (let minute = signalMinute - 15 * MINUTE; minute < signalMinute; minute += MINUTE) {
      const bucket = buckets.get(minute)
      if (bucket?.count >= 3) depth.push(bucket)
    }
    if (depth.length < 10) return
    const depthImbalance15 = mean(depth.map((bucket) => bucket.full / bucket.count))
    const bidDrift15 = pct(depth.at(-1).lastBid, depth[0].firstBid)
    if (!(bidDrift15 <= -0.25 && depthImbalance15 < 0.30)) return

    const last10 = rows.slice(-10)
    const last30 = rows.slice(-30)
    const last50 = rows.slice(-50)
    const previous3Volume = mean(rows.slice(-6, -3).map((row) => row.volume))
    const metrics = {
      return15,
      rsi14: rsi,
      recovery15,
      vwapGap15,
      dayReturn,
      depthMinutes: depth.length,
      bidDrift15,
      depthImbalance15,
      normalizedOfi15: mean(depth.map((bucket) => bucket.normalizedOfi / bucket.count)),
      top2Imbalance15: mean(depth.map((bucket) => bucket.top2 / bucket.count)),
      orderImbalance15: mean(depth.map((bucket) => bucket.orders / bucket.count)),
      bidShare15: mean(depth.map((bucket) => bucket.bidShare / bucket.count)),
      greenVolume15: greenVolumeShare(last15),
      greenVolume30: greenVolumeShare(last30),
      greenVolume50: greenVolumeShare(last50),
      vwapGap10: vwapGap(last10),
      vwapGap50: vwapGap(last50),
      volumeRatio3: previous3Volume > 0
        ? mean(rows.slice(-3).map((row) => row.volume)) / previous3Volume : NaN,
    }
    const branch = branchFor(metrics)
    if (!branch) return

    const quote = booksByStock.get(symbol)
    const entry = quote?.book?.bid
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(quote.lastAt) ||
        quote.lastAt < signalMinute || at - quote.lastAt > 5_000) return
    const id = `${symbol}:${Math.floor(signalMinute / 1000)}:multi-frame-depth-sell`
    if (signalIds.has(id)) return
    const signal = {
      id,
      strategy: "Multi-Frame Depth Continuation",
      symbol,
      direction: "SELL",
      pattern: branch === "sustained_selling_volume"
        ? "Sustained selling below short VWAP"
        : branch === "weak_recovery_falling_bid"
          ? "Weak recovery with a falling best bid"
          : "Temporary price recovery without order-book recovery",
      time: new Date(at).toISOString(),
      price: entry,
      stop: entry * (1 + STOP_PCT / 100),
      target: entry * (1 - TARGET_PCT / 100),
      status: "Active",
      candleMinute: last.time,
      metrics: { ...metrics, filterBranch: branch },
    }
    signals.push(signal)
    signalIds.add(id)
    usedStock.add(symbol)
    publish()
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

  function resetLiveState() {
    depthByStock.clear()
    booksByStock.clear()
    evaluatedByStock.clear()
  }

  return {
    seed, observeCandle, observeDepth, observePrice, flushCompleted,
    resetLiveState, snapshot,
  }
}
