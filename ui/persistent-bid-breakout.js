import { depthUpdateFields } from "./market-depth.js"
import { toStockName } from "./market-data.js"

const MINUTE = 60_000
const MAX_CANDLES = 180
const WINDOW_CANDLES = 120
const MINIMUM_POSITIVE_STREAK = 31
const TARGET_PCT = 1.5
const STOP_PCT = 0.5

const mean = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length

function bookMetrics(book) {
  let bids = 0, asks = 0, topBids = 0, topAsks = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(book[`bid_price${level}`])
    const askPrice = Number(book[`ask_price${level}`])
    const bidSize = Number(book[`bid_size${level}`])
    const askSize = Number(book[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    bids += bidSize
    asks += askSize
    if (level <= 2) { topBids += bidSize; topAsks += askSize }
  }
  const bestBid = Number(book.bid_price1)
  const bestAsk = Number(book.ask_price1)
  const bid1 = Number(book.bid_size1)
  const ask1 = Number(book.ask_size1)
  return {
    bestBid, bestAsk, bid1, ask1,
    full: (bids - asks) / (bids + asks || 1),
    top2: (topBids - topAsks) / (topBids + topAsks || 1),
  }
}

export function createPersistentBidBreakout({ onUpdate = () => {}, initialSignals = [], now = () => Date.now() } = {}) {
  const candlesByStock = new Map()
  const booksByStock = new Map()
  const bookStateByStock = new Map()
  const signals = initialSignals.slice()
  const signalIds = new Set(signals.map((signal) => signal.id))
  const usedDepthRuns = new Set(signals.map((signal) =>
    `${signal.symbol}:${Date.parse(signal.metrics?.positiveDepthStreakFrom)}`))
  let sessionDate = indiaDate(now())

  function publish() { onUpdate(snapshot(), sessionDate) }
  function snapshot() { return signals.slice().reverse() }

  function resetDay(date) {
    sessionDate = date
    candlesByStock.clear()
    booksByStock.clear()
    bookStateByStock.clear()
    signals.length = 0
    signalIds.clear()
    usedDepthRuns.clear()
    publish()
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) resetDay(today)
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_CANDLES })
        const currentMinute = Math.floor(now() / MINUTE)
        const history = rows.filter((row) => Math.floor(row.time / 60) < currentMinute &&
          indiaDate(row.time * 1000) === sessionDate)
        candlesByStock.set(symbol, history.map(normalizeCandle).filter(Boolean).slice(-MAX_CANDLES))
      } catch { candlesByStock.set(symbol, []) }
    }))
  }

  function observeDepth(data, receivedAt, marketContext = null) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const time = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!symbol || !Number.isFinite(time) || indiaDate(time) !== sessionDate) return
    const fields = depthUpdateFields(data)
    if (!fields) return

    let state = bookStateByStock.get(symbol)
    if (!state || time - state.lastAt > 90_000) state = { fields: {}, lastAt: time, book: null }
    const previous = state.book
    for (const [key, value] of fields) state.fields[key] = value
    const current = bookMetrics(state.fields)
    state.lastAt = time
    if (!current) { state.book = null; bookStateByStock.set(symbol, state); return }

    const ofi = previous
      ? (current.bestBid >= previous.bestBid ? current.bid1 : 0) -
        (current.bestBid <= previous.bestBid ? previous.bid1 : 0) -
        (current.bestAsk <= previous.bestAsk ? current.ask1 : 0) +
        (current.bestAsk >= previous.bestAsk ? previous.ask1 : 0)
      : 0
    const ofiDepth = previous ? (current.bid1 + current.ask1 + previous.bid1 + previous.ask1) / 2 : 0
    const minute = Math.floor(time / MINUTE) * MINUTE
    let buckets = booksByStock.get(symbol)
    if (!buckets) buckets = new Map()
    let bucket = buckets.get(minute)
    const volume = Number(marketContext?.cumulativeVolume)
    if (!bucket) bucket = { minute, count: 0, full: 0, top2: 0, ofi: 0, ofiDepth: 0,
      positiveBoth: 0, firstBid: current.bestBid, lastBid: current.bestBid,
      firstVolume: volume, lastVolume: volume }
    bucket.count++
    bucket.full += current.full
    bucket.top2 += current.top2
    bucket.ofi += ofi
    bucket.ofiDepth += ofiDepth
    if (current.full > 0 && current.top2 > 0) bucket.positiveBoth++
    bucket.lastBid = current.bestBid
    if (Number.isFinite(volume)) bucket.lastVolume = volume
    buckets.set(minute, bucket)
    for (const key of buckets.keys()) if (key < minute - 150 * MINUTE) buckets.delete(key)
    state.book = current
    bookStateByStock.set(symbol, state)
    booksByStock.set(symbol, buckets)
  }

  function observeCandle(symbol, input) {
    const current = normalizeCandle(input)
    if (!symbol || !current || input.partial) return
    const date = indiaDate(current.time * 1000)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)

    const rows = candlesByStock.get(symbol) || []
    const existing = rows.findIndex((row) => row.time === current.time)
    if (existing >= 0) rows[existing] = current
    else rows.push(current)
    rows.sort((a, b) => a.time - b.time)
    const history = rows.slice(-MAX_CANDLES)
    candlesByStock.set(symbol, history)

    resolveActive(symbol, current)
    const candles = history.slice(-WINDOW_CANDLES)
    if (candles.length < WINDOW_CANDLES || !hasCandleContext(candles)) return

    const buckets = booksByStock.get(symbol)
    if (!buckets) return
    const currentMinute = Math.floor(current.time / 60) * MINUTE
    const persistent = findPersistentPositiveDepth(buckets, currentMinute)
    if (!persistent) return
    const runKey = `${symbol}:${persistent.start}`
    if (usedDepthRuns.has(runKey)) return
    const passive = findPartialSupport(buckets, currentMinute, persistent.start)
    if (!passive) return
    const passiveWindow = consecutiveMinutes(buckets, persistent.start + 9 * MINUTE, 10)
    if (!passiveWindow || mean(passiveWindow, "full") < 0.2 || mean(passiveWindow, "ofi") >= 0) return
    const flowShift = findFlowShift(buckets, currentMinute, persistent.end)
    if (!flowShift) return
    const candleTrigger = candleMomentumTrigger(candles)
    if (!candleTrigger) return
    const liveDepth = depthConfirmation(buckets, currentMinute)
    if (!liveDepth) return

    const id = `${symbol}:${current.time}:persistent-bid-breakout`
    if (signalIds.has(id)) return
    const entry = current.close
    const signal = {
      id,
      strategy: "Persistent Bid Absorption Breakout",
      symbol,
      direction: "BUY",
      pattern: "Passive bid support shifted to active buying",
      time: new Date((current.time + 60) * 1000).toISOString(),
      price: entry,
      stop: entry * (1 - STOP_PCT / 100),
      target: entry * (1 + TARGET_PCT / 100),
      status: "Active",
      candleMinute: current.time,
      metrics: {
        candlesUsed: candles.length,
        return120Pct: candleTrigger.return120Pct,
        trendEfficiency120: candleTrigger.efficiency120,
        momentumVolumeBarsAboveMedian: candleTrigger.volumeBarsAboveMedian,
        partialBuyerAccelerationFrom: new Date(passive.start).toISOString(),
        positiveDepthStreakMinutes: persistent.length,
        positiveDepthStreakFrom: new Date(persistent.start).toISOString(),
        passiveDepthFlow: mean(passiveWindow, "ofi"),
        flowShiftAt: new Date(flowShift.end + MINUTE).toISOString(),
        fullImbalance: liveDepth.full,
        top2Imbalance: liveDepth.top2,
        normalizedOrderFlow: liveDepth.ofi,
        latestMinuteOrderFlow: liveDepth.latestMinuteOfi,
        risingBestBid: liveDepth.risingBestBid,
      },
    }
    signals.push(signal)
    signalIds.add(id)
    usedDepthRuns.add(runKey)
    onUpdate(snapshot(), sessionDate)
  }

  function resolveActive(symbol, candle) {
    const active = signals.find((signal) => signal.symbol === symbol && signal.status === "Active")
    if (!active || candle.time <= active.candleMinute) return
    if (candle.low <= active.stop) {
      active.status = "Stopped"
      active.resolvedAt = new Date(candle.time * 1000).toISOString()
      publish()
    } else if (candle.high >= active.target) {
      active.status = "Target reached"
      active.resolvedAt = new Date(candle.time * 1000).toISOString()
      publish()
    }
  }

  function hasCandleContext(rows) {
    return rows.slice(1).every((row, index) => row.time > rows[index].time)
  }

  function findPersistentPositiveDepth(buckets, currentMinute) {
    for (let end = currentMinute - MINUTE; end >= currentMinute - 60 * MINUTE; end -= MINUTE) {
      let length = 0
      for (let minute = end; minute >= currentMinute - 60 * MINUTE; minute -= MINUTE) {
        const row = summarizeBucket(buckets.get(minute))
        if (!row || row.full <= 0) break
        length++
      }
      if (length >= MINIMUM_POSITIVE_STREAK) return { start: end - (length - 1) * MINUTE, end, length }
    }
    return null
  }

  function findPartialSupport(buckets, currentMinute, before) {
    for (let end = before - MINUTE; end >= currentMinute - 60 * MINUTE; end -= MINUTE) {
      const recent = consecutiveMinutes(buckets, end, 3)
      const prior = consecutiveMinutes(buckets, end - 3 * MINUTE, 3)
      if (!recent || !prior) continue
      const full = mean(recent, "full")
      const top2 = mean(recent, "top2")
      const flow = mean(recent, "ofi")
      if (full >= 0.2 && top2 >= 0.05 && flow < 0 &&
          full - mean(prior, "full") >= 0.1 && top2 - mean(prior, "top2") >= 0.1) {
        return { start: end - 2 * MINUTE, end }
      }
    }
    return null
  }

  function findFlowShift(buckets, currentMinute, afterPersistentRun) {
    for (let end = currentMinute - MINUTE; end >= currentMinute - 20 * MINUTE; end -= MINUTE) {
      const recent = consecutiveMinutes(buckets, end, 3)
      const prior = consecutiveMinutes(buckets, end - 3 * MINUTE, 5)
      if (!recent || !prior || end - 2 * MINUTE < afterPersistentRun) continue
      if (mean(prior, "ofi") < 0 && mean(recent, "ofi") > 0 &&
          mean(recent, "full") > 0.15 && mean(recent, "top2") > 0.05 &&
          recent.at(-1).lastBid > recent[0].firstBid) return { start: end - 2 * MINUTE, end }
    }
    return null
  }

  function candleMomentumTrigger(rows) {
    const last = rows.slice(-3)
    if (last.length !== 3 || last.some((row, index) => index > 0 && row.time !== last[index - 1].time + 60)) return null
    if (!last.every((row) => row.close > row.open) ||
        !last.every((row, index) => index === 0 || row.close > last[index - 1].close)) return null
    const previous = rows.slice(-13, -3)
    if (previous.length < 8 || last.at(-1).close <= Math.max(...previous.map((row) => row.close))) return null
    const medianVolume = median(rows.map((row) => row.volume))
    const volumeBarsAboveMedian = last.filter((row) => row.volume >= medianVolume).length
    if (mean(last, "volume") < 1.5 * medianVolume || volumeBarsAboveMedian < 2) return null
    const return120Pct = (rows.at(-1).close / rows[0].close - 1) * 100
    const travel = rows.slice(1).reduce((sum, row, index) => sum + Math.abs(row.close - rows[index].close), 0)
    const efficiency120 = Math.abs(rows.at(-1).close - rows[0].close) / (travel || 1)
    if (return120Pct < -1.5 || return120Pct > 1.5 || efficiency120 > 0.35) return null
    return { return120Pct, efficiency120, volumeBarsAboveMedian }
  }

  function depthConfirmation(buckets, currentMinute) {
    const rows = consecutiveMinutes(buckets, currentMinute, 3)
    if (!rows) return null
    const full = mean(rows, "full")
    const top2 = mean(rows, "top2")
    const ofi = mean(rows, "ofi")
    const latestMinuteOfi = rows.at(-1).ofi
    const risingBestBid = rows.at(-1).lastBid > rows[0].firstBid
    const positiveConfirmations = Number(top2 > 0.1) + Number(ofi > 0) + Number(risingBestBid)
    return full > 0 && latestMinuteOfi > 0 && positiveConfirmations >= 2
      ? { full, top2, ofi, latestMinuteOfi, risingBestBid } : null
  }

  function consecutiveMinutes(buckets, end, length) {
    const rows = []
    for (let offset = length - 1; offset >= 0; offset--) {
      const row = summarizeBucket(buckets.get(end - offset * MINUTE))
      if (!row) return null
      rows.push(row)
    }
    return rows
  }

  return { observeDepth, observeCandle, seed, snapshot, resetLiveState: () => {
    booksByStock.clear()
    bookStateByStock.clear()
  } }
}

function summarizeBucket(bucket) {
  if (!bucket?.count) return null
  return {
    minute: bucket.minute,
    full: bucket.full / bucket.count,
    top2: bucket.top2 / bucket.count,
    ofi: bucket.ofi / (bucket.ofiDepth || 1),
    positiveBoth: bucket.positiveBoth / bucket.count,
    firstBid: bucket.firstBid,
    lastBid: bucket.lastBid,
    firstVolume: bucket.firstVolume,
    lastVolume: bucket.lastVolume,
  }
}

function normalizeCandle(row) {
  if (!row) return null
  const time = Math.floor(Number(row.time) / 60) * 60
  const candle = { time, open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume) }
  return Number.isFinite(time) &&
    [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ? candle : null
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
}

function indiaDate(timestamp) {
  return new Date(timestamp + 330 * MINUTE).toISOString().slice(0, 10)
}
