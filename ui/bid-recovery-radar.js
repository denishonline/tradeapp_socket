import { depthUpdateFields } from "./market-depth.js"
import { toStockName } from "./market-data.js"

const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const MAX_CANDLES = 900
const WINDOWS = [25, 20, 15]
const TARGET_PCT = 1
const STOP_PCT = 0.4

const indiaDate = (time) => new Date(time + IST_OFFSET).toISOString().slice(0, 10)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0)
const average = (rows, field) => sum(rows, field) / rows.length

function normalizeCandle(input) {
  if (!input || input.partial) return null
  const row = { time: Math.floor(Number(input.time) / 60) * 60,
    open: Number(input.open), high: Number(input.high), low: Number(input.low),
    close: Number(input.close), volume: Number(input.volume) }
  return Number.isFinite(row.time) &&
    [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) &&
    row.open > 0 && row.low > 0 && row.high >= row.low && row.volume >= 0 ? row : null
}

function bookMetrics(fields) {
  let bids = 0, asks = 0, topBids = 0, topAsks = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const bidSize = Number(fields[`bid_size${level}`])
    const askSize = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    bids += bidSize
    asks += askSize
    if (level <= 2) { topBids += bidSize; topAsks += askSize }
  }
  return { bid: Number(fields.bid_price1), ask: Number(fields.ask_price1),
    bid1: Number(fields.bid_size1), ask1: Number(fields.ask_size1),
    full: (bids - asks) / (bids + asks || 1),
    top2: (topBids - topAsks) / (topBids + topAsks || 1) }
}

function emaSeries(closes, period) {
  if (closes.length < period) return []
  let value = closes.slice(0, period).reduce((total, close) => total + close, 0) / period
  const values = Array(period - 1).fill(null)
  values.push(value)
  for (const close of closes.slice(period)) {
    value += (close - value) * 2 / (period + 1)
    values.push(value)
  }
  return values
}

function rsi14(rows) {
  if (rows.length < 15) return NaN
  const closes = rows.slice(-15).map((row) => row.close)
  let gains = 0, losses = 0
  for (let index = 1; index < closes.length; index++) {
    const change = closes[index] - closes[index - 1]
    if (change > 0) gains += change
    else losses -= change
  }
  return losses ? 100 - 100 / (1 + gains / losses) : 100
}

function recovery(rows, length) {
  const trailing = rows.slice(-length)
  const low = Math.min(...trailing.map((row) => row.low))
  const lowIndex = trailing.findIndex((row) => row.low === low)
  return lowIndex <= length - 3 ? pct(trailing.at(-1).close, low) : NaN
}

function candleSetup(today, prior) {
  if (today.length < 15 || prior.length < 60) return null
  const current = today.at(-1)
  const dayOpenAt = Date.parse(`${indiaDate(current.time * 1000)}T03:45:00Z`) / 1000
  if (today[0].time !== dayOpenAt) return null
  const history = [...prior.slice(-60), ...today]
  const closes = history.map((row) => row.close)
  const ema20 = emaSeries(closes, 20)
  const ema50 = emaSeries(closes, 50)
  const emaDown = ema20.at(-1) < ema50.at(-1)
  const emaSlope5Pct = pct(ema20.at(-1), ema20.at(-6))
  if (!emaDown && emaSlope5Pct >= 0) return null
  const rsi = rsi14(today)
  const dayOpen = today[0].open
  const dayPct = pct(current.close, dayOpen)
  const dayVolume = sum(today, "volume")
  if (!dayVolume) return null
  const vwap = today.reduce((total, row) =>
    total + row.volume * (row.high + row.low + row.close) / 3, 0) / dayVolume
  const vwapGap = pct(current.close, vwap)
  return { emaDown, emaSlope5Pct, rsi, dayPct, vwapGap }
}

export function createBidRecoveryRadar({ onUpdate = () => {}, initialSignals = [], now = () => Date.now() } = {}) {
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
    const currentMinute = Math.floor(now() / MINUTE)
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_CANDLES })
        candlesByStock.set(symbol, rows.map(normalizeCandle).filter((row) =>
          row && Math.floor(row.time / 60) < currentMinute).slice(-MAX_CANDLES))
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
    rows.sort((a, b) => a.time - b.time)
    candlesByStock.set(symbol, rows.slice(-MAX_CANDLES))
  }

  function observeDepth(data, receivedAt) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!symbol || !Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    const fields = depthUpdateFields(data)
    if (!fields) return
    let state = booksByStock.get(symbol)
    if (!state || at - state.lastAt > 90_000) state = { fields: {}, book: null, lastAt: at }
    for (const [key, value] of fields) state.fields[key] = value
    const book = bookMetrics(state.fields)
    const previous = state.book
    state.lastAt = at
    state.book = book
    booksByStock.set(symbol, state)
    if (!book) return

    const ofi = previous ? (book.bid >= previous.bid ? book.bid1 : 0) -
      (book.bid <= previous.bid ? previous.bid1 : 0) -
      (book.ask <= previous.ask ? book.ask1 : 0) +
      (book.ask >= previous.ask ? previous.ask1 : 0) : 0
    const ofiDepth = previous ?
      (book.bid1 + book.ask1 + previous.bid1 + previous.ask1) / 2 : 0
    const minute = Math.floor(at / MINUTE) * MINUTE
    let buckets = depthByStock.get(symbol)
    if (!buckets) buckets = new Map()
    const bucket = buckets.get(minute) || { count: 0, full: 0, top2: 0, ofi: 0, ofiDepth: 0 }
    bucket.count++
    bucket.full += book.full
    bucket.top2 += book.top2
    bucket.ofi += ofi
    bucket.ofiDepth += ofiDepth
    buckets.set(minute, bucket)
    for (const key of buckets.keys()) if (key < minute - 25 * MINUTE) buckets.delete(key)
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
    const rows = candlesByStock.get(symbol) || []
    const last = rows.findLast((row) => row.time * 1000 + MINUTE === signalMinute)
    if (!last || at - signalMinute > 30_000) return
    const today = rows.filter((row) => indiaDate(row.time * 1000) === sessionDate && row.time <= last.time)
    const prior = rows.filter((row) => indiaDate(row.time * 1000) < sessionDate)
    const common = candleSetup(today, prior)
    if (!common) return
    const buckets = depthByStock.get(symbol)
    if (!buckets) return

    for (const length of WINDOWS) {
      const window = today.slice(-length)
      if (window.length !== length || window.some((row, index) =>
        index > 0 && row.time !== window[index - 1].time + 60)) continue
      const depth = []
      for (const candle of window) {
        const bucket = buckets.get(candle.time * 1000)
        if (!bucket || bucket.count < 3 || bucket.full <= 0 || bucket.top2 <= 0) break
        depth.push(bucket)
      }
      if (depth.length !== length) continue
      const candleReturn = pct(window.at(-1).close, window[0].open)
      if (candleReturn > -0.2) continue
      const greenVolume = 100 * sum(window.filter((row) => row.close > row.open), "volume") /
        (sum(window, "volume") || 1)
      if (greenVolume <= 30) continue
      const recovery10 = recovery(today, 10)
      const recovery15 = recovery(today, 15)
      const recoveryPct = Math.max(...[recovery10, recovery15].filter(Number.isFinite))
      if (!(recoveryPct >= 0.15)) continue
      const recentDepth = depth.slice(-5)
      const flows = recentDepth.map((bucket) => bucket.ofi / (bucket.ofiDepth || 1))
      const positiveFlowMinutes = flows.filter((flow) => flow > 0).length
      const meanFlow = flows.reduce((total, flow) => total + flow, 0) / flows.length
      if (positiveFlowMinutes < 3 || meanFlow <= 0) continue

      // The first complete base setup is the one counted for a stock each day.
      usedStock.add(symbol)
      if (!(common.rsi <= 45)) return
      const vwapPath = common.vwapGap >= -0.31 && greenVolume <= 46.5
      const oversoldPath = common.rsi <= 30 && common.dayPct > 0
      if (!vwapPath && !oversoldPath) return
      const ask = booksByStock.get(symbol)?.book?.ask
      const quoteAt = booksByStock.get(symbol)?.lastAt
      if (!Number.isFinite(ask) || ask <= 0 || !Number.isFinite(quoteAt) ||
          quoteAt < signalMinute || at - quoteAt > 5_000) return
      const id = `${symbol}:${Math.floor(signalMinute / 1000)}:bid-recovery-radar`
      if (signalIds.has(id)) return
      const signal = {
        id, strategy: "Bid-Dominant Recovery", symbol, direction: "BUY",
        pattern: vwapPath ? "Bid recovery near VWAP" : "Oversold recovery above open",
        time: new Date(at).toISOString(), price: ask,
        stop: ask * (1 - STOP_PCT / 100),
        target: ask * (1 + TARGET_PCT / 100), status: "Active",
        metrics: { depthMinutes: length, candleReturnPct: candleReturn,
          greenVolumePct: greenVolume, recoveryPct, rsi14: common.rsi,
          dayPctFromOpen: common.dayPct, vwapGapPct: common.vwapGap,
          ema20Below50: common.emaDown, ema20Slope5Pct: common.emaSlope5Pct,
          positiveFlowMinutes, meanFlow, filterPath: vwapPath ? "vwap_and_volume" : "oversold_positive_day",
          fullBidSharePct: 50 * (1 + average(depth.map((bucket) => ({ value: bucket.full / bucket.count })), "value")),
          top2BidSharePct: 50 * (1 + average(depth.map((bucket) => ({ value: bucket.top2 / bucket.count })), "value")) },
      }
      signals.push(signal)
      signalIds.add(id)
      publish()
      return
    }
  }

  function flushCompleted(timestamp = now()) {
    const at = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp)
    if (!Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date > sessionDate) resetDay(date)
    // Wait for the prior minute to close, and never use depth from the entry minute.
    const signalMinute = Math.floor((at - 2_000) / MINUTE) * MINUTE
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

  return { seed, observeCandle, observeDepth, observePrice, flushCompleted,
    resetLiveState, snapshot }
}
