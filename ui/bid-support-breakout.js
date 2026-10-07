import { depthUpdateFields, marketDepthSession } from "./market-depth.js"
import { toStockName } from "./market-data.js"

const MINUTE = 60_000
const MAX_CANDLES = 180
const TARGET_PCT = 1
const STOP_PCT = 0.5
const average = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length
const pct = (current, base) => base > 0 ? (current / base - 1) * 100 : NaN
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)

function normalizeCandle(input) {
  if (!input || input.partial || input.source !== "websocket") return null
  const at = Number(input.time) * 1000
  const candle = { at, open: Number(input.open), high: Number(input.high),
    low: Number(input.low), close: Number(input.close), volume: Number(input.volume) }
  return Number.isFinite(at) && [candle.open, candle.high, candle.low, candle.close, candle.volume]
    .every(Number.isFinite) ? candle : null
}

function setup(candles, index) {
  if (index < 9) return null
  const last10 = candles.slice(index - 9, index + 1)
  if (last10.some((row, i) => i > 0 && row.at !== last10[i - 1].at + MINUTE)) return null
  const base = last10.slice(-3)
  const baseHigh = Math.max(...base.map((row) => row.high))
  const baseLow = Math.min(...base.map((row) => row.low))
  const breakoutHigh = Math.max(...last10.map((row) => row.high))
  const trendPct = pct(base.at(-1).close, last10[0].open)
  const baseRangePct = pct(baseHigh, baseLow)
  const volumeRatio = average(base.slice(-2), "volume") / average(last10.slice(-8, -3), "volume")
  if (trendPct < 0.6 || trendPct > 4 || baseRangePct > 0.6 ||
      volumeRatio < 0.15 || volumeRatio > 0.85 || baseHigh < breakoutHigh * 0.997) return null
  return { trendPct, baseRangePct, volumeRatio, baseHigh, baseLow, breakoutHigh,
    baseVolume: average(base, "volume"), candleAt: base.at(-1).at }
}

function bookMetrics(fields) {
  const bids = [], asks = []
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const bidSize = Number(fields[`bid_size${level}`])
    const askSize = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    bids.push(bidSize)
    asks.push(askSize)
  }
  const bidSum = bids.reduce((sum, value) => sum + value, 0)
  const askSum = asks.reduce((sum, value) => sum + value, 0)
  return { bid: Number(fields.bid_price1), ask: Number(fields.ask_price1),
    bid1: bids[0], ask1: asks[0], full: (bidSum - askSum) / (bidSum + askSum || 1) }
}

export function createBidSupportBreakout({ onUpdate = () => {}, initialSignals = [], now = () => Date.now() } = {}) {
  const candlesByStock = new Map()
  const depthByStock = new Map()
  const signals = initialSignals.slice()
  const signalIds = new Set(signals.map((signal) => signal.id))
  const lastSignalAtByStock = new Map()
  for (const signal of signals) {
    const at = Date.parse(signal.time)
    if (Number.isFinite(at)) lastSignalAtByStock.set(signal.symbol,
      Math.max(lastSignalAtByStock.get(signal.symbol) || 0, at))
  }
  let sessionDate = indiaDate(now())

  function snapshot() { return signals.slice().reverse() }
  function publish() { onUpdate(snapshot(), sessionDate) }

  function resetDay(date) {
    sessionDate = date
    candlesByStock.clear()
    depthByStock.clear()
    signals.length = 0
    signalIds.clear()
    lastSignalAtByStock.clear()
    publish()
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) resetDay(today)
    depthByStock.clear()
    const currentTime = now()
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_CANDLES })
        candlesByStock.set(symbol, rows.map(normalizeCandle).filter((row) => row &&
          indiaDate(row.at) === sessionDate && row.at + MINUTE + 2000 <= currentTime)
          .slice(-MAX_CANDLES))
      } catch { candlesByStock.set(symbol, []) }
    }))
  }

  function observeCandle(symbol, input) {
    const candle = normalizeCandle(input)
    if (!symbol || !candle) return
    const date = indiaDate(candle.at)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    const rows = candlesByStock.get(symbol) || []
    const index = rows.findIndex((row) => row.at === candle.at)
    if (index >= 0) rows[index] = candle
    else rows.push(candle)
    rows.sort((left, right) => left.at - right.at)
    candlesByStock.set(symbol, rows.slice(-MAX_CANDLES))
    const depth = depthByStock.get(symbol)
    if (depth) depth.cachedSetupKey = ""
    for (const signal of signals) {
      if (signal.symbol !== symbol || signal.status !== "Active" ||
          candle.at <= Math.floor(Date.parse(signal.time) / MINUTE) * MINUTE) continue
      if (candle.low <= signal.stop) {
        signal.status = "Stopped"
        signal.resolvedAt = new Date(candle.at).toISOString()
        publish()
      } else if (candle.high >= signal.target) {
        signal.status = "Target reached"
        signal.resolvedAt = new Date(candle.at).toISOString()
        publish()
      }
    }
  }

  function observeDepth(data, receivedAt, marketContext = null) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!symbol || !Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    if (!marketDepthSession(new Date(at)).open) return
    const update = depthUpdateFields(data)
    if (!update) return
    let state = depthByStock.get(symbol)
    if (!state) state = { fields: {}, previous: null, currentMinute: -1,
      baselineVolume: null, buckets: new Map(), cachedSetupKey: "", cachedSetup: null }
    if (state.previous && at - state.previous.at > 90_000) {
      state.fields = {}
      state.previous = null
    }
    for (const [key, value] of update) state.fields[key] = value
    const book = bookMetrics(state.fields)
    if (!book) { depthByStock.set(symbol, state); return }
    const prior = state.previous
    const depthMinute = Math.floor(at / MINUTE) * MINUTE
    if (depthMinute !== state.currentMinute) {
      state.baselineVolume = prior && depthMinute - prior.at <= 30_000 ? prior.volume : null
      state.currentMinute = depthMinute
      for (const key of state.buckets.keys()) if (key < depthMinute - 4 * MINUTE) state.buckets.delete(key)
    }
    const ofi = prior ? (book.bid >= prior.bid ? book.bid1 : 0) -
      (book.bid <= prior.bid ? prior.bid1 : 0) -
      (book.ask <= prior.ask ? book.ask1 : 0) +
      (book.ask >= prior.ask ? prior.ask1 : 0) : 0
    const ofiDepth = prior ? (book.bid1 + book.ask1 + prior.bid1 + prior.ask1) / 2 : 0
    const bucket = state.buckets.get(depthMinute) || { count: 0, full: 0, positive: 0,
      ofi: 0, ofiDepth: 0 }
    bucket.count++
    bucket.full += book.full
    bucket.positive += book.full > 0 ? 1 : 0
    bucket.ofi += ofi
    bucket.ofiDepth += ofiDepth
    state.buckets.set(depthMinute, bucket)
    state.previous = { ...book, at, volume: Number(marketContext?.cumulativeVolume) }
    depthByStock.set(symbol, state)

    const candles = candlesByStock.get(symbol) || []
    let index = candles.length - 1
    while (index >= 0 && candles[index].at + MINUTE + 2000 > at) index--
    const setupKey = `${depthMinute}:${index}`
    if (setupKey !== state.cachedSetupKey) {
      state.cachedSetupKey = setupKey
      state.cachedSetup = setup(candles, index)
    }
    const candidate = state.cachedSetup
    if (!candidate || at - (candidate.candleAt + MINUTE) > 2 * MINUTE ||
        at - (lastSignalAtByStock.get(symbol) ?? -Infinity) < 30 * MINUTE ||
        bucket.count < 3 || at - depthMinute < 15_000 || book.bid <= candidate.breakoutHigh) return
    const price = Number(marketContext?.price)
    const priceAt = Date.parse(marketContext?.priceAt)
    const volume = Number(marketContext?.cumulativeVolume)
    if (!Number.isFinite(priceAt) || at - priceAt > 5000 || price <= candidate.breakoutHigh ||
        !Number.isFinite(volume) || !Number.isFinite(state.baselineVolume) ||
        volume < state.baselineVolume) return
    const flow = bucket.ofi / (bucket.ofiDepth || 1)
    const volumePace = ((volume - state.baselineVolume) * MINUTE / (at - depthMinute)) / candidate.baseVolume
    const spreadPct = pct(book.ask, book.bid)
    const extensionPct = pct(book.ask, candidate.breakoutHigh)
    if (flow <= 0.1 || volumePace < 1.5 || spreadPct > 0.15 || extensionPct > 0.3) return
    const support = []
    for (let offset = 3; offset >= 1; offset--) {
      const minuteAt = depthMinute - offset * MINUTE
      const priorBucket = state.buckets.get(minuteAt)
      if (priorBucket?.count >= 3 && priorBucket.full / priorBucket.count >= 0.4 &&
          priorBucket.positive / priorBucket.count >= 0.75) {
        support.push({ minuteAt, full: priorBucket.full / priorBucket.count,
          positivePct: 100 * priorBucket.positive / priorBucket.count })
      }
    }
    if (!support.length) return
    const strongest = support.sort((left, right) => right.full - left.full)[0]
    const id = `${symbol}:${Math.floor(at / 1000)}:bid-support-breakout`
    if (signalIds.has(id)) return
    const signal = { id, strategy: "Bid Support Breakout", symbol, direction: "BUY",
      pattern: "Bid-supported candle base with active breakout",
      time: new Date(at).toISOString(), price: book.ask,
      target: book.ask * (1 + TARGET_PCT / 100),
      stop: book.ask * (1 - STOP_PCT / 100), status: "Active",
      candleMinute: candidate.candleAt / 1000,
      metrics: { trendPct: candidate.trendPct, baseRangePct: candidate.baseRangePct,
        volumeRatio: candidate.volumeRatio, breakoutHigh: candidate.breakoutHigh,
        baseLow: candidate.baseLow, supportAt: new Date(strongest.minuteAt).toISOString(),
        supportFull: strongest.full, supportPositivePct: strongest.positivePct,
        liveFlow: flow, liveVolumePace: volumePace, spreadPct, extensionPct } }
    signals.push(signal)
    signalIds.add(id)
    lastSignalAtByStock.set(symbol, at)
    publish()
  }

  function resetLiveState() { depthByStock.clear() }

  return { seed, observeCandle, observeDepth, resetLiveState, snapshot }
}
