import { depthUpdateFields } from "./market-depth.js"
import { toStockName } from "./market-data.js"
import { passesRevisedAbsorptionQuality } from "./strategy-quality-gates.js"

const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const MAX_CANDLES = 900
const EVALUATION_DELAY_MS = 2_000
const OPENING_MINUTE = 9 * 60 + 16
const INTRADAY_START = 9 * 60 + 30
const INTRADAY_END = 14 * 60 + 30
const INITIAL_STOP_PCT = 0.4
const TRAIL_ARM_PCT = 1.5
const TRAIL_LOCK_PCT = 0.4
const TRAIL_DISTANCE_PCT = 1.0

const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const median = (values) => {
  if (!values.length) return NaN
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const minuteOfDay = (at) => {
  const value = new Date(at + IST_OFFSET)
  return value.getUTCHours() * 60 + value.getUTCMinutes()
}

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
  let bidSize = 0, askSize = 0, bid = NaN, ask = NaN, bid1 = NaN, ask1 = NaN
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBid = Number(fields[`bid_size${level}`])
    const currentAsk = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBid, currentAsk].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBid < 0 || currentAsk < 0) return null
    if (level === 1) { bid = bidPrice; ask = askPrice; bid1 = currentBid; ask1 = currentAsk }
    bidSize += currentBid
    askSize += currentAsk
  }
  return { bid, ask, bid1, ask1, bidShare: bidSize / (bidSize + askSize || 1), mid: (bid + ask) / 2 }
}

function createDepthBucket(minute) {
  return {
    minute, updates: 0, maxGapSec: 0, lastAt: null, bidShare: 0, bidDominant: 0,
    ofi: 0, traded: 0, signed: 0, firstPrice: null, lastPrice: null,
    firstMid: null, lastMid: null, spreadPct: NaN,
  }
}

function finalizeDepth(bucket) {
  if (!bucket?.updates) return null
  return {
    updates: bucket.updates,
    maxGapSec: bucket.maxGapSec,
    avgBidPct: 100 * bucket.bidShare / bucket.updates,
    bidDominantPct: 100 * bucket.bidDominant / bucket.updates,
    ofi: bucket.ofi / bucket.updates,
    deltaPct: bucket.traded > 0 ? 100 * bucket.signed / bucket.traded : 0,
    depthPricePct: pct(bucket.lastPrice, bucket.firstPrice),
    midReturnPct: pct(bucket.lastMid, bucket.firstMid),
    spreadPct: bucket.spreadPct,
  }
}

function candleContext(rows, index) {
  if (index < 0 || index >= rows.length) return null
  const candle = rows[index]
  const history = rows.slice(0, index + 1)
  const range = candle.high - candle.low
  const sessionVolume = history.reduce((total, row) => total + row.volume, 0)
  const vwap = sessionVolume > 0
    ? history.reduce((total, row) => total + row.volume * (row.high + row.low + row.close) / 3, 0) / sessionVolume
    : NaN
  const priorVolumes = history.slice(0, -1).slice(-10).map((row) => row.volume)
  const returnFor = (length) => history.length >= length ? pct(candle.close, history.at(-length).open) : NaN
  return {
    candleReturnPct: pct(candle.close, candle.open),
    closeLocationPct: range ? 100 * (candle.close - candle.low) / range : 50,
    upperWickPct: range ? 100 * (candle.high - Math.max(candle.open, candle.close)) / range : 0,
    volumeRatio10: priorVolumes.length ? candle.volume / median(priorVolumes) : NaN,
    return3Pct: returnFor(3), return10Pct: returnFor(10), return30Pct: returnFor(30),
    dayReturnPct: pct(candle.close, history[0].open), vwapGapPct: pct(candle.close, vwap),
    belowHighPct: pct(Math.max(...history.map((row) => row.high)), candle.close),
    recoveryLowPct: pct(candle.close, Math.min(...history.map((row) => row.low))),
  }
}

function openingBase(context, depth) {
  return depth.updates >= 10 && depth.maxGapSec <= 10 &&
    context.candleReturnPct >= 0.20 && context.closeLocationPct >= 75 &&
    context.upperWickPct <= 25 && depth.midReturnPct >= 0.20 &&
    depth.ofi > 0 && depth.spreadPct <= 0.10
}

function intradayBase(context, depth, confirmation, confirmDepth) {
  return depth.updates >= 20 && depth.maxGapSec <= 6 && depth.spreadPct <= 0.06 &&
    context.return10Pct >= 0.20 && context.return30Pct >= 0.40 && context.vwapGapPct >= 0 &&
    context.belowHighPct <= 1.10 && context.recoveryLowPct >= 0.70 &&
    Math.abs(depth.deltaPct) >= 15 && (depth.avgBidPct >= 55 || depth.deltaPct >= 60) &&
    confirmation.close > context.close && confirmation.closeLocationPct >= 50 && Boolean(confirmDepth)
}

export function createRevisedAbsorptionBreakoutRadar({
  onUpdate = () => {}, initialSignals = [], now = () => Date.now(),
} = {}) {
  const candlesByStock = new Map()
  const depthByStock = new Map()
  const bookStates = new Map()
  const quotes = new Map()
  const sessionOpenByStock = new Map()
  const evaluatedByStock = new Map()
  const breadthCache = new Map()
  const signals = initialSignals.slice()
  const signalIds = new Set(signals.map((signal) => signal.id))
  const signaledStocks = new Set(signals.map((signal) => signal.symbol))
  let sessionDate = indiaDate(now())
  let universeSize = 0

  function snapshot() { return signals.slice().reverse() }
  function publish() { onUpdate(snapshot(), sessionDate) }

  function resetDay(date) {
    sessionDate = date
    candlesByStock.clear()
    depthByStock.clear()
    bookStates.clear()
    quotes.clear()
    sessionOpenByStock.clear()
    evaluatedByStock.clear()
    breadthCache.clear()
    signals.length = 0
    signalIds.clear()
    signaledStocks.clear()
    publish()
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) resetDay(today)
    universeSize = stocks.length
    resetLiveState()
    const completedBefore = Math.floor(now() / MINUTE) * MINUTE
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_CANDLES })
        const history = rows.map(normalizeCandle).filter((row) => row && row.time * 1000 + MINUTE <= completedBefore)
        candlesByStock.set(symbol, history.slice(-MAX_CANDLES))
        const todayRows = history.filter((row) => indiaDate(row.time * 1000) === sessionDate)
        if (todayRows.length) sessionOpenByStock.set(symbol, todayRows[0].open)
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
    if (!sessionOpenByStock.has(symbol)) sessionOpenByStock.set(symbol, candle.open)
    breadthCache.delete(candle.time * 1000)
    updateSignalsFromCandle(symbol, candle)
  }

  function observeDepth(data, receivedAt, marketContext = null) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!symbol || !Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date < sessionDate) return
    if (date > sessionDate) resetDay(date)
    const update = depthUpdateFields(data)
    if (!update) return

    let state = bookStates.get(symbol)
    if (!state || at - state.lastAt > 90_000) {
      state = { fields: {}, book: null, lastAt: at, price: NaN, volume: NaN, direction: 0 }
    }
    for (const [key, value] of update) state.fields[key] = value
    const current = bookMetrics(state.fields)
    if (!current) return
    const contextPrice = Number(marketContext?.price)
    const contextVolume = Number(marketContext?.cumulativeVolume)
    const price = Number.isFinite(contextPrice) && contextPrice > 0 ? contextPrice : current.mid
    const volume = Number.isFinite(contextVolume) && contextVolume >= 0 ? contextVolume : NaN
    const previous = state.book && Number.isFinite(state.price)
      ? { at: state.lastAt, book: state.book, price: state.price, volume: state.volume, direction: state.direction }
      : null

    let normalizedOfi = 0, traded = 0, signed = 0
    if (previous && at - previous.at <= 90_000) {
      const rawOfi = (current.bid >= previous.book.bid ? current.bid1 : 0) -
        (current.bid <= previous.book.bid ? previous.book.bid1 : 0) -
        (current.ask <= previous.book.ask ? current.ask1 : 0) +
        (current.ask >= previous.book.ask ? previous.book.ask1 : 0)
      const size = (current.bid1 + current.ask1 + previous.book.bid1 + previous.book.ask1) / 2
      normalizedOfi = rawOfi / (size || 1)
      if (Number.isFinite(volume) && Number.isFinite(previous.volume)) traded = Math.max(0, volume - previous.volume)
      if (price > previous.price) state.direction = 1
      else if (price < previous.price) state.direction = -1
      signed = traded * state.direction
    }

    state.book = current
    state.lastAt = at
    state.price = price
    state.volume = volume
    bookStates.set(symbol, state)
    if (!sessionOpenByStock.has(symbol)) sessionOpenByStock.set(symbol, price)
    quotes.set(symbol, { at, ask: current.ask, bid: current.bid, price })

    const minute = Math.floor(at / MINUTE) * MINUTE
    let buckets = depthByStock.get(symbol)
    if (!buckets) buckets = new Map()
    let bucket = buckets.get(minute)
    if (!bucket) bucket = createDepthBucket(minute)
    bucket.maxGapSec = bucket.lastAt ? Math.max(bucket.maxGapSec, (at - bucket.lastAt) / 1000) : 0
    bucket.lastAt = at
    bucket.updates++
    bucket.bidShare += current.bidShare
    bucket.bidDominant += current.bidShare > 0.5 ? 1 : 0
    bucket.ofi += normalizedOfi
    bucket.traded += traded
    bucket.signed += signed
    bucket.firstPrice ??= price
    bucket.lastPrice = price
    bucket.firstMid ??= current.mid
    bucket.lastMid = current.mid
    bucket.spreadPct = pct(current.ask, current.bid)
    buckets.set(minute, bucket)
    for (const key of buckets.keys()) if (key < minute - 40 * MINUTE) buckets.delete(key)
    depthByStock.set(symbol, buckets)
  }

  function sessionRows(symbol, date = sessionDate) {
    return (candlesByStock.get(symbol) || []).filter((row) => indiaDate(row.time * 1000) === date)
  }

  function historicalContext(symbol, setup) {
    const all = candlesByStock.get(symbol) || []
    const dates = [...new Set(all.map((row) => indiaDate(row.time * 1000)).filter((date) => date < sessionDate))].sort()
    const priorDate = dates.at(-1)
    const prior = priorDate ? all.filter((row) => indiaDate(row.time * 1000) === priorDate) : []
    return {
      gapPct: prior.length ? pct(setup.open, prior.at(-1).close) : NaN,
      prior30ReturnPct: prior.length >= 30 ? pct(prior.at(-1).close, prior.at(-30).open) : NaN,
    }
  }

  function breadthAt(minute) {
    if (breadthCache.has(minute)) return breadthCache.get(minute)
    const metrics = []
    for (const symbol of candlesByStock.keys()) {
      const rows = sessionRows(symbol).filter((row) => row.time * 1000 <= minute)
      const index = rows.findIndex((row) => row.time * 1000 === minute)
      if (index < 0) continue
      const context = candleContext(rows, index)
      const sessionOpen = sessionOpenByStock.get(symbol) || rows[0].open
      metrics.push({ day: pct(rows[index].close, sessionOpen), return3: context.return3Pct })
    }
    const minimumCoverage = Math.max(1, Math.ceil(universeSize * 0.90))
    if (metrics.length < minimumCoverage) return null
    const validReturn3 = metrics.filter((row) => Number.isFinite(row.return3))
    const result = {
      stocks: metrics.length,
      positivePct: 100 * metrics.filter((row) => row.day > 0).length / metrics.length,
      above05Pct: 100 * metrics.filter((row) => row.day >= 0.5).length / metrics.length,
      return3PositivePct: validReturn3.length
        ? 100 * validReturn3.filter((row) => row.return3 > 0).length / validReturn3.length : NaN,
    }
    breadthCache.set(minute, result)
    return result
  }

  function emitSignal(symbol, pattern, signalMinute, context, depth, breadth, extra = {}) {
    if (signaledStocks.has(symbol)) return false
    const quote = quotes.get(symbol)
    const currentAt = now()
    if (!quote || currentAt - quote.at > 5_000 || !(quote.ask > 0)) return null
    const id = `${symbol}:${Math.floor(signalMinute / 1000)}:revised-absorption-breakout`
    if (signalIds.has(id)) return false
    const entry = quote.ask
    const metrics = {
      candleReturnPct: context.candleReturnPct, return3Pct: context.return3Pct,
      return10Pct: context.return10Pct, return30Pct: context.return30Pct,
      vwapGapPct: context.vwapGapPct, volumeRatio10: context.volumeRatio10,
      depthUpdates: depth.updates, avgBidPct: depth.avgBidPct,
      bidDominantPct: depth.bidDominantPct, ofi: depth.ofi,
      deltaPct: depth.deltaPct, midReturnPct: depth.midReturnPct,
      breadthStocks: breadth.stocks, breadthPositivePct: breadth.positivePct,
      breadthAbove05Pct: breadth.above05Pct,
      breadthReturn3PositivePct: breadth.return3PositivePct,
      ...extra,
    }
    if (!passesRevisedAbsorptionQuality(pattern, metrics)) return false
    const signal = {
      id, strategy: "Revised Absorption Breakout", symbol, direction: "BUY", pattern,
      time: new Date(currentAt).toISOString(), price: entry,
      stop: entry * (1 - INITIAL_STOP_PCT / 100),
      target: entry * (1 + TRAIL_ARM_PCT / 100), status: "Active",
      trailArmed: false, peakPrice: entry, trailingStop: null,
      exitPlan: {
        type: "armed_trailing", initialStopFraction: INITIAL_STOP_PCT / 100,
        armFraction: TRAIL_ARM_PCT / 100, lockFraction: TRAIL_LOCK_PCT / 100,
        trailingFraction: TRAIL_DISTANCE_PCT / 100,
      },
      metrics,
    }
    signals.push(signal)
    signalIds.add(id)
    signaledStocks.add(symbol)
    publish()
    return true
  }

  function evaluateOpening(symbol, completedMinute, breadth) {
    if (minuteOfDay(completedMinute) !== OPENING_MINUTE) return false
    const rows = sessionRows(symbol).filter((row) => row.time * 1000 <= completedMinute)
    const index = rows.findIndex((row) => row.time * 1000 === completedMinute)
    const depth = finalizeDepth(depthByStock.get(symbol)?.get(completedMinute))
    if (index < 0 || !depth || !breadth) return null
    const context = candleContext(rows, index)
    if (!openingBase(context, depth)) return false
    const historical = historicalContext(symbol, rows[index])
    const broadParticipation = historical.gapPct >= -0.10 && historical.prior30ReturnPct <= 0.25 &&
      depth.deltaPct <= 50 && depth.updates >= 12 && context.candleReturnPct > 0 &&
      depth.depthPricePct / context.candleReturnPct >= 0.95 && depth.avgBidPct <= 50 &&
      breadth.positivePct >= 70 && breadth.above05Pct <= 20
    const hiddenBuyFlow = depth.avgBidPct <= 40 && depth.ofi >= 0.20 &&
      historical.gapPct <= 1.00 && historical.prior30ReturnPct <= 0.50
    if (!broadParticipation && !hiddenBuyFlow) return false
    return emitSignal(symbol,
      broadParticipation ? "Opening broad participation" : "Opening hidden buy flow",
      completedMinute, context, depth, breadth, historical)
  }

  function evaluateIntraday(symbol, completedMinute, breadth) {
    const setupMinute = completedMinute - MINUTE
    const setupMinuteOfDay = minuteOfDay(setupMinute)
    if (setupMinuteOfDay < INTRADAY_START || setupMinuteOfDay > INTRADAY_END) return false
    const rows = sessionRows(symbol).filter((row) => row.time * 1000 <= completedMinute)
    const setupIndex = rows.findIndex((row) => row.time * 1000 === setupMinute)
    const confirmIndex = rows.findIndex((row) => row.time * 1000 === completedMinute)
    const depth = finalizeDepth(depthByStock.get(symbol)?.get(setupMinute))
    const confirmDepth = finalizeDepth(depthByStock.get(symbol)?.get(completedMinute))
    if (setupIndex < 0 || confirmIndex < 0 || !depth || !confirmDepth || !breadth) return null
    const context = candleContext(rows, setupIndex)
    const confirmContext = candleContext(rows, confirmIndex)
    const confirmation = { ...rows[confirmIndex], ...confirmContext }
    if (!intradayBase({ ...context, close: rows[setupIndex].close }, depth, confirmation, confirmDepth)) return false

    const lateBreadth = setupMinuteOfDay >= 13 * 60 + 50 && context.return3Pct >= 0.13 &&
      context.candleReturnPct <= 0.15 && confirmDepth.avgBidPct >= 51 &&
      confirmDepth.avgBidPct <= 64 && breadth.positivePct >= 75
    const smoothConfirmation = context.volumeRatio10 <= 1.00 &&
      confirmDepth.midReturnPct >= 0.20 && confirmDepth.midReturnPct <= 0.30 &&
      breadth.positivePct >= 40 && breadth.return3PositivePct >= 70
    const balancedContinuation = depth.ofi >= 0.10 && confirmDepth.midReturnPct >= 0.20 &&
      confirmContext.volumeRatio10 <= 2.00 && breadth.positivePct >= 40
    if (!lateBreadth && !smoothConfirmation && !balancedContinuation) return false
    const pattern = lateBreadth ? "Late breadth-confirmed absorption"
      : smoothConfirmation ? "Smooth depth confirmation" : "Balanced flow continuation"
    return emitSignal(symbol, pattern, completedMinute, context, depth, breadth, {
      confirmationCandleReturnPct: confirmContext.candleReturnPct,
      confirmationVolumeRatio10: confirmContext.volumeRatio10,
      confirmationAvgBidPct: confirmDepth.avgBidPct,
      confirmationOfi: confirmDepth.ofi,
      confirmationMidReturnPct: confirmDepth.midReturnPct,
    })
  }

  function applyPrice(signal, price, at) {
    if (signal.status !== "Active" || at <= Date.parse(signal.time)) return false
    if (!signal.trailArmed) {
      if (price <= signal.stop) {
        signal.status = "Stopped"
        signal.resolvedAt = new Date(at).toISOString()
        signal.exitPrice = price
        return true
      }
      signal.peakPrice = Math.max(Number(signal.peakPrice) || signal.price, price)
      if (signal.peakPrice < signal.target) return false
      signal.trailArmed = true
      signal.trailingStop = Math.max(
        signal.price * (1 + TRAIL_LOCK_PCT / 100),
        signal.peakPrice * (1 - TRAIL_DISTANCE_PCT / 100),
      )
      return true
    }
    const previousStop = Number(signal.trailingStop) || 0
    signal.peakPrice = Math.max(Number(signal.peakPrice) || signal.price, price)
    signal.trailingStop = Math.max(
      signal.price * (1 + TRAIL_LOCK_PCT / 100),
      signal.peakPrice * (1 - TRAIL_DISTANCE_PCT / 100),
    )
    if (price <= signal.trailingStop) {
      signal.status = "Trail exited"
      signal.resolvedAt = new Date(at).toISOString()
      signal.exitPrice = price
      return true
    }
    return signal.trailingStop - previousStop >= signal.price * 0.0005
  }

  function observePrice(data, receivedAt) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    const price = Number(data.ltp)
    if (!symbol || !Number.isFinite(at) || !(price > 0)) return
    if (!sessionOpenByStock.has(symbol)) sessionOpenByStock.set(symbol, price)
    let changed = false
    for (const signal of signals) if (signal.symbol === symbol) changed = applyPrice(signal, price, at) || changed
    if (changed) publish()
  }

  function updateSignalsFromCandle(symbol, candle) {
    let changed = false
    const at = candle.time * 1000
    for (const signal of signals) {
      if (signal.symbol !== symbol || signal.status !== "Active" || at <= Date.parse(signal.time)) continue
      if (!signal.trailArmed) {
        if (candle.low <= signal.stop) {
          signal.status = "Stopped"
          signal.resolvedAt = new Date(at).toISOString()
          signal.exitPrice = signal.stop
          changed = true
        } else if (candle.high >= signal.target) {
          signal.trailArmed = true
          signal.peakPrice = Math.max(Number(signal.peakPrice) || signal.price, candle.high)
          signal.trailingStop = Math.max(signal.price * 1.004, signal.peakPrice * 0.99)
          changed = true
        }
        continue
      }
      const currentStop = Number(signal.trailingStop)
      if (candle.low <= currentStop) {
        signal.status = "Trail exited"
        signal.resolvedAt = new Date(at).toISOString()
        signal.exitPrice = currentStop
        changed = true
      } else {
        const previousStop = currentStop
        signal.peakPrice = Math.max(Number(signal.peakPrice) || signal.price, candle.high)
        signal.trailingStop = Math.max(signal.price * 1.004, signal.peakPrice * 0.99)
        if (signal.trailingStop - previousStop >= signal.price * 0.0005) changed = true
      }
    }
    if (changed) publish()
  }

  function flushCompleted(timestamp = now()) {
    const at = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp)
    if (!Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date > sessionDate) resetDay(date)
    const signalMinute = Math.floor((at - EVALUATION_DELAY_MS) / MINUTE) * MINUTE
    const completedMinute = signalMinute - MINUTE
    const completedMinuteOfDay = minuteOfDay(completedMinute)
    const setupMinute = completedMinute - MINUTE
    const setupMinuteOfDay = minuteOfDay(setupMinute)
    const breadthMinute = completedMinuteOfDay === OPENING_MINUTE ? completedMinute
      : setupMinuteOfDay >= INTRADAY_START && setupMinuteOfDay <= INTRADAY_END ? setupMinute : null
    if (breadthMinute === null) return
    const breadth = breadthAt(breadthMinute)
    if (!breadth) return
    for (const symbol of candlesByStock.keys()) {
      if (signaledStocks.has(symbol) || evaluatedByStock.get(symbol) >= completedMinute) continue
      const openingResult = evaluateOpening(symbol, completedMinute, breadth)
      const result = openingResult === false
        ? evaluateIntraday(symbol, completedMinute, breadth) : openingResult
      if (result !== null) evaluatedByStock.set(symbol, completedMinute)
    }
  }

  function resetLiveState() {
    depthByStock.clear()
    bookStates.clear()
    quotes.clear()
    evaluatedByStock.clear()
    breadthCache.clear()
  }

  return { seed, observeCandle, observeDepth, observePrice, flushCompleted, resetLiveState, snapshot }
}
