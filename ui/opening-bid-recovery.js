import { depthUpdateFields, marketDepthSession } from "./market-depth.js"
import { toStockName } from "./market-data.js"

const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const MAX_CANDLES = 900
const TARGET_PCT = 1.5
const STOP_PCT = 0.4

const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0)

function indiaMinuteOfDay(at) {
  const date = new Date(at + IST_OFFSET)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}

function normalizeCandle(input) {
  if (!input || input.partial) return null
  const row = { time: Math.floor(Number(input.time) / 60) * 60,
    open: Number(input.open), high: Number(input.high), low: Number(input.low),
    close: Number(input.close), volume: Number(input.volume) }
  return Number.isFinite(row.time) &&
    [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) &&
    row.open > 0 && row.low > 0 && row.high >= row.low && row.volume >= 0 ? row : null
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

function windowMetrics(rows) {
  const volume = sum(rows, "volume")
  const greenVolume = sum(rows.filter((row) => row.close > row.open), "volume")
  const vwap = volume ? rows.reduce((total, row) =>
    total + row.volume * (row.high + row.low + row.close) / 3, 0) / volume : NaN
  return { returnPct: pct(rows.at(-1).close, rows[0].open),
    greenVolumePct: volume ? 100 * greenVolume / volume : NaN,
    vwapGapPct: pct(rows.at(-1).close, vwap) }
}

function candleSetup(today, prior) {
  if (today.length < 15 || !prior.length) return null
  const expectedOpen = Date.parse(`${indiaDate(today.at(-1).time * 1000)}T03:45:00Z`) / 1000
  if (today[0].time !== expectedOpen) return null
  const last15 = today.slice(-15)
  if (last15.some((row, index) => index && row.time !== last15[index - 1].time + 60)) return null
  const last5 = today.slice(-5)
  const current = today.at(-1)
  const metrics5 = windowMetrics(last5)
  const metrics15 = windowMetrics(last15)
  const returnOpen = pct(current.close, today[0].open)
  const rsi = rsi14(today)
  const recoveryLow = pct(current.close, Math.min(...today.map((row) => row.low)))
  const pullbackHigh = pct(Math.max(...today.map((row) => row.high)), current.close)
  const greenCloses5 = last5.filter((row) => row.close > row.open).length
  const priorDate = indiaDate(prior.at(-1).time * 1000)
  const previousSession = prior.filter((row) => indiaDate(row.time * 1000) === priorDate)
  const priorDayReturn = previousSession.length ? pct(previousSession.at(-1).close, previousSession[0].open) : NaN
  if (![returnOpen, metrics5.returnPct, metrics15.returnPct, rsi, metrics15.vwapGapPct,
    metrics5.greenVolumePct, recoveryLow, pullbackHigh, priorDayReturn].every(Number.isFinite)) return null
  if (returnOpen < -1.20 || returnOpen > -0.05 ||
      metrics5.returnPct < -0.35 || metrics5.returnPct > 0.40 ||
      metrics15.returnPct < -0.75 || rsi < 28 || rsi > 52 ||
      metrics15.vwapGapPct < -0.65 || metrics15.vwapGapPct > 0.45 ||
      metrics5.greenVolumePct < 48 || greenCloses5 < 3 ||
      recoveryLow < 0.55 || recoveryLow > 1.45 ||
      pullbackHigh < 0.55 || pullbackHigh > 2.10 || priorDayReturn > 0) return null
  return { returnOpen, return5: metrics5.returnPct, return15: metrics15.returnPct,
    rsi14: rsi, vwapGap15: metrics15.vwapGapPct,
    greenVolume5: metrics5.greenVolumePct, greenCloses5,
    recoveryLow, pullbackHigh, priorDayReturn }
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
  if (bids + asks <= 0 || topBids + topAsks <= 0) return null
  return { bid: Number(fields.bid_price1), ask: Number(fields.ask_price1),
    full: (bids - asks) / (bids + asks), top2: (topBids - topAsks) / (topBids + topAsks) }
}

export function createOpeningBidRecoveryRadar({ onUpdate = () => {}, initialSignals = [], now = () => Date.now() } = {}) {
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
    rows.sort((left, right) => left.time - right.time)
    candlesByStock.set(symbol, rows.slice(-MAX_CANDLES))
  }

  function observeDepth(data, receivedAt, marketContext = null) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!symbol || !Number.isFinite(at) || !marketDepthSession(new Date(at)).open) return
    const date = indiaDate(at)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    const update = depthUpdateFields(data)
    if (!update) return
    let state = booksByStock.get(symbol)
    if (!state || at - state.lastAt > 90_000) state = { fields: {}, book: null, lastAt: at }
    for (const [key, value] of update) state.fields[key] = value
    const book = bookMetrics(state.fields)
    state.book = book
    state.lastAt = at
    booksByStock.set(symbol, state)
    if (!book) return

    const minuteAt = Math.floor(at / MINUTE) * MINUTE
    const marketPrice = Number(marketContext?.price)
    const mid = (book.bid + book.ask) / 2
    const price = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : mid
    let buckets = depthByStock.get(symbol)
    if (!buckets) buckets = new Map()
    const bucket = buckets.get(minuteAt) || { count: 0, full: 0, top2: 0,
      bidDominant: 0, firstPrice: price, lastPrice: price }
    bucket.count++
    bucket.full += book.full
    bucket.top2 += book.top2
    bucket.bidDominant += book.full > 0 ? 1 : 0
    bucket.lastPrice = price
    buckets.set(minuteAt, bucket)
    for (const key of buckets.keys()) if (key < minuteAt - 20 * MINUTE) buckets.delete(key)
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
    if (usedStock.has(symbol) || indiaMinuteOfDay(signalMinute) > 9 * 60 + 50) return
    const rows = candlesByStock.get(symbol) || []
    const last = rows.findLast((row) => row.time * 1000 + MINUTE === signalMinute)
    if (!last || at - signalMinute > 30_000) return
    const today = rows.filter((row) => indiaDate(row.time * 1000) === sessionDate && row.time <= last.time)
    const prior = rows.filter((row) => indiaDate(row.time * 1000) < sessionDate)
    const setup = candleSetup(today, prior)
    if (!setup) return
    const buckets = depthByStock.get(symbol)
    if (!buckets) return
    const depth = [...buckets.entries()].filter(([minuteAt]) =>
      minuteAt >= signalMinute - 15 * MINUTE && minuteAt < signalMinute)
      .sort(([left], [right]) => left - right).map(([, bucket]) => bucket)
    if (depth.length < 10) return
    const positiveDepthPct = 100 * depth.filter((bucket) => bucket.full / bucket.count > 0).length / depth.length
    const tickCount = sum(depth, "count")
    if (!tickCount) return
    const bidDominantTicksPct = 100 * sum(depth, "bidDominant") / tickCount
    const top2BidSharePct = 50 * (1 + sum(depth, "top2") / tickCount)
    const last3 = depth.slice(-3)
    const depthImbalance3 = last3.reduce((total, bucket) => total + bucket.full / bucket.count, 0) / last3.length
    const depthPriceReturn15 = pct(depth.at(-1).lastPrice, depth[0].firstPrice)
    if (positiveDepthPct < 55 || bidDominantTicksPct < 56 || top2BidSharePct < 47.5 ||
        depthImbalance3 > 0.31 || depthPriceReturn15 > 0.13) return
    const bookState = booksByStock.get(symbol)
    const ask = bookState?.book?.ask
    if (!Number.isFinite(ask) || ask <= 0 || !Number.isFinite(bookState?.lastAt) ||
        bookState.lastAt < signalMinute || at - bookState.lastAt > 5_000) return
    const id = `${symbol}:${Math.floor(signalMinute / 1000)}:opening-bid-recovery`
    if (signalIds.has(id)) return
    const signal = { id, strategy: "Bid Supported Dip Recovery", symbol, direction: "BUY",
      pattern: "Early dip recovery with persistent tick-level bid support",
      time: new Date(at).toISOString(), price: ask,
      stop: ask * (1 - STOP_PCT / 100), target: ask * (1 + TARGET_PCT / 100), status: "Active",
      metrics: { ...setup, depthMinutes: depth.length, depthTicks: tickCount,
        positiveDepthPct, bidDominantTicksPct, top2BidSharePct,
        depthImbalance3, depthPriceReturn15 } }
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
    const signalMinute = Math.floor((at - 2_000) / MINUTE) * MINUTE
    if (indiaMinuteOfDay(signalMinute) > 9 * 60 + 50) return
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
