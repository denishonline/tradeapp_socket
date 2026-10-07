import { depthUpdateFields } from "./market-depth.js"
import { toStockName } from "./market-data.js"

const MINUTE = 60_000
const MAX_CANDLES = 180
const SEED_CANDLES = 500
const EVALUATION_DELAY_MS = 5_000
const TARGET_PCT = 3
const STOP_PCT = 0.5
const mean = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length
const pct = (current, base) => base > 0 ? (current / base - 1) * 100 : NaN

function indiaDate(timestamp) {
  return new Date(timestamp + 330 * MINUTE).toISOString().slice(0, 10)
}

function normalizeCandle(row) {
  if (!row || row.partial) return null
  const time = Math.floor(Number(row.time) / 60) * 60
  const candle = { time, open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume) }
  return Number.isFinite(time) && [candle.open, candle.high, candle.low, candle.close, candle.volume]
    .every(Number.isFinite) ? candle : null
}

function bookMetrics(fields) {
  let bidSum = 0, askSum = 0, bid2 = 0, ask2 = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const bidSize = Number(fields[`bid_size${level}`])
    const askSize = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    bidSum += bidSize
    askSum += askSize
    if (level <= 2) { bid2 += bidSize; ask2 += askSize }
  }
  return { bid: Number(fields.bid_price1), ask: Number(fields.ask_price1),
    bid1: Number(fields.bid_size1), ask1: Number(fields.ask_size1),
    full: (bidSum - askSum) / (bidSum + askSum || 1),
    top2: (bid2 - ask2) / (bid2 + ask2 || 1) }
}

export function createEarlyDepthBreakout({ onUpdate = () => {}, initialSignals = [], now = () => Date.now() } = {}) {
  const candlesByStock = new Map()
  const dayOpenByStock = new Map()
  const depthByStock = new Map()
  const bookStateByStock = new Map()
  const evaluatedMinuteByStock = new Map()
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
    dayOpenByStock.clear()
    depthByStock.clear()
    bookStateByStock.clear()
    evaluatedMinuteByStock.clear()
    signals.length = 0
    signalIds.clear()
    lastSignalAtByStock.clear()
    publish()
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) resetDay(today)
    const completedBefore = Math.floor(now() / MINUTE) * MINUTE
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: SEED_CANDLES })
        const normalized = rows.map(normalizeCandle).filter((row) => row &&
          indiaDate(row.time * 1000) === sessionDate && row.time * 1000 + MINUTE <= completedBefore)
        const sessionOpenTime = Date.parse(`${sessionDate}T09:15:00+05:30`) / 1000
        const openingCandle = normalized.find((row) => row.time === sessionOpenTime)
        if (openingCandle) dayOpenByStock.set(symbol, openingCandle.open)
        candlesByStock.set(symbol, normalized.slice(-MAX_CANDLES))
      } catch { candlesByStock.set(symbol, []) }
    }))
  }

  function observeCandle(symbol, input) {
    const candle = normalizeCandle(input)
    if (!symbol || !candle) return
    const date = indiaDate(candle.time * 1000)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    const sessionOpenTime = Date.parse(`${sessionDate}T09:15:00+05:30`) / 1000
    if (candle.time === sessionOpenTime) dayOpenByStock.set(symbol, candle.open)
    const rows = candlesByStock.get(symbol) || []
    const existing = rows.findIndex((row) => row.time === candle.time)
    if (existing >= 0) rows[existing] = candle
    else rows.push(candle)
    rows.sort((a, b) => a.time - b.time)
    candlesByStock.set(symbol, rows.slice(-MAX_CANDLES))
    for (const signal of signals) {
      if (signal.symbol !== symbol || signal.status !== "Active" || candle.time * 1000 < Date.parse(signal.time)) continue
      if (candle.low <= signal.stop) {
        signal.status = "Stopped"
        signal.resolvedAt = new Date(candle.time * 1000).toISOString()
        publish()
      } else if (candle.high >= signal.target) {
        signal.status = "Target reached"
        signal.resolvedAt = new Date(candle.time * 1000).toISOString()
        publish()
      }
    }
  }

  function observeDepth(data, receivedAt) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const timestamp = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!symbol || !Number.isFinite(timestamp)) return
    const date = indiaDate(timestamp)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    const update = depthUpdateFields(data)
    if (!update) return
    let state = bookStateByStock.get(symbol)
    if (!state || timestamp - state.lastAt > 90_000) state = { fields: {}, lastAt: timestamp, book: null }
    for (const [key, value] of update) state.fields[key] = value
    const book = bookMetrics(state.fields)
    if (!book) { state.book = null; state.lastAt = timestamp; bookStateByStock.set(symbol, state); return }
    const old = state.book
    const ofi = old ? (book.bid >= old.bid ? book.bid1 : 0) - (book.bid <= old.bid ? old.bid1 : 0) -
      (book.ask <= old.ask ? book.ask1 : 0) + (book.ask >= old.ask ? old.ask1 : 0) : 0
    const ofiDepth = old ? (book.bid1 + book.ask1 + old.bid1 + old.ask1) / 2 : 0
    const minute = Math.floor(timestamp / MINUTE) * MINUTE
    let buckets = depthByStock.get(symbol)
    if (!buckets) buckets = new Map()
    const bucket = buckets.get(minute) || { count: 0, fullSum: 0, top2Sum: 0,
      ofiSum: 0, ofiDepthSum: 0, firstBid: book.bid, lastBid: book.bid,
      lastAsk: book.ask, lastAt: timestamp }
    bucket.count++
    bucket.fullSum += book.full
    bucket.top2Sum += book.top2
    bucket.ofiSum += ofi
    bucket.ofiDepthSum += ofiDepth
    bucket.lastBid = book.bid
    bucket.lastAsk = book.ask
    bucket.lastAt = timestamp
    buckets.set(minute, bucket)
    for (const key of buckets.keys()) if (key < minute - 10 * MINUTE) buckets.delete(key)
    depthByStock.set(symbol, buckets)
    state.book = book
    state.lastAt = timestamp
    bookStateByStock.set(symbol, state)
  }

  function evaluate(symbol, depthMinute) {
    const signalAt = depthMinute + MINUTE
    const rows = (candlesByStock.get(symbol) || []).filter((row) => row.time * 1000 + MINUTE <= signalAt)
    const last15 = rows.slice(-15)
    if (last15.length < 15 || last15.some((row, index) =>
      index > 0 && row.time !== last15[index - 1].time + 60)) return
    const last = last15.at(-1)
    if (signalAt - (last.time * 1000 + MINUTE) > 2 * MINUTE) return
    const previous10 = last15.slice(0, 10)
    const recent5 = last15.slice(-5)
    const return5Pct = pct(last.close, recent5[0].open)
    const dayOpen = dayOpenByStock.get(symbol)
    if (!Number.isFinite(dayOpen) || dayOpen <= 0) return
    const dayPctFromOpen = pct(last.close, dayOpen)
    const priorVolume = mean(previous10, "volume")
    const volumeMultiple = mean(recent5, "volume") / (priorVolume || 1)
    const elevatedVolumeBars = recent5.filter((row) => row.volume >= priorVolume).length
    const breakoutPct = pct(last.close, Math.max(...previous10.map((row) => row.high)))
    if (dayPctFromOpen <= 0 || return5Pct < 0.5 || volumeMultiple < 1.5 ||
        elevatedVolumeBars < 2 || breakoutPct <= 0) return
    const buckets = depthByStock.get(symbol)
    if (!buckets) return
    const books = []
    for (let offset = 4; offset >= 0; offset--) {
      const bucket = buckets.get(depthMinute - offset * MINUTE)
      if (!bucket || bucket.count < 3) return
      books.push(bucket)
    }
    const prior3Full = mean(books.slice(0, 3).map((row) => ({ value: row.fullSum / row.count })), "value")
    const prior3Top2 = mean(books.slice(0, 3).map((row) => ({ value: row.top2Sum / row.count })), "value")
    const latest2 = books.slice(-2)
    const full2 = mean(latest2.map((row) => ({ value: row.fullSum / row.count })), "value")
    const top2_2 = mean(latest2.map((row) => ({ value: row.top2Sum / row.count })), "value")
    if (latest2.some((row) => row.fullSum / row.count <= 0.15 || row.top2Sum / row.count <= 0.15) ||
        full2 - prior3Full < 0.2 || top2_2 - prior3Top2 < 0.2) return
    const latest = books.at(-1)
    const currentFlow = latest.ofiSum / (latest.ofiDepthSum || 1)
    const flow2 = latest2.reduce((sum, row) => sum + row.ofiSum, 0) /
      (latest2.reduce((sum, row) => sum + row.ofiDepthSum, 0) || 1)
    const bidMovePct = pct(latest.lastBid, books[2].firstBid)
    if (currentFlow <= 0 || flow2 <= 0 || bidMovePct < 0.25 || signalAt - latest.lastAt > 30_000) return
    const entry = latest.lastAsk
    const quoteExtensionPct = pct(entry, last.close)
    if (quoteExtensionPct > 0.5 || signalAt - (lastSignalAtByStock.get(symbol) || 0) < 30 * MINUTE) return
    const id = `${symbol}:${Math.floor(signalAt / 1000)}:early-depth-breakout`
    if (signalIds.has(id)) return
    const signal = {
      id,
      strategy: "Early Depth-Control Breakout",
      symbol,
      direction: "BUY",
      pattern: "Candle breakout confirmed by accelerating buyer depth",
      time: new Date(signalAt).toISOString(),
      price: entry,
      stop: entry * (1 - STOP_PCT / 100),
      target: entry * (1 + TARGET_PCT / 100),
      status: "Active",
      candleMinute: last.time,
      metrics: { dayPctFromOpen, return5Pct, volumeMultiple, elevatedVolumeBars, breakoutPct,
        fullImbalance2: full2, top2Imbalance2: top2_2,
        fullAcceleration: full2 - prior3Full, top2Acceleration: top2_2 - prior3Top2,
        currentQuoteFlow: currentFlow, normalizedQuoteFlow2: flow2,
        bestBidMove3Pct: bidMovePct, quoteExtensionPct,
        candleAgeMinutes: (signalAt - last.time * 1000 - MINUTE) / MINUTE },
    }
    signals.push(signal)
    signalIds.add(id)
    lastSignalAtByStock.set(symbol, signalAt)
    publish()
  }

  function flushCompleted(timestamp = now()) {
    const at = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp)
    if (!Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date > sessionDate) resetDay(date)
    const depthMinute = Math.floor((at - EVALUATION_DELAY_MS) / MINUTE) * MINUTE - MINUTE
    for (const [symbol] of depthByStock) {
      if ((evaluatedMinuteByStock.get(symbol) ?? -Infinity) >= depthMinute) continue
      evaluatedMinuteByStock.set(symbol, depthMinute)
      evaluate(symbol, depthMinute)
    }
  }

  function resetLiveState() {
    depthByStock.clear()
    bookStateByStock.clear()
    evaluatedMinuteByStock.clear()
  }

  return { seed, observeCandle, observeDepth, flushCompleted, resetLiveState, snapshot }
}
