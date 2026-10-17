import { depthUpdateFields, marketDepthSession } from "./market-depth.js"
import { toStockName } from "./market-data.js"

const MINUTE = 60_000
const INDIA_OFFSET = 330 * MINUTE
const MAX_CANDLES = 60
const WINDOW_CANDLES = 5
const TARGET_PCT = 1
const STOP_PCT = 0.5
const BREAKEVEN_TRIGGER_PCT = 0.5
const TRAIL_DISTANCE_PCT = 0.4
const MAX_HOLD_MINUTES = 120
const MIN_VOLUME_HISTORY = 4

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position), upper = Math.ceil(position)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function indiaDate(epoch) {
  return new Date(epoch + INDIA_OFFSET).toISOString().slice(0, 10)
}

function normalizeCandle(input) {
  const time = Number(input?.time)
  const open = Number(input?.open), high = Number(input?.high)
  const low = Number(input?.low), close = Number(input?.close)
  if (!Number.isSafeInteger(time) || ![open, high, low, close].every(Number.isFinite) ||
      open <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) return null
  return { time, open, high, low, close }
}

function bookMetrics(fields) {
  let bids = 0, asks = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const bidSize = Number(fields[`bid_size${level}`])
    const askSize = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    if (level > 1 && (bidPrice > fields[`bid_price${level - 1}`] || askPrice < fields[`ask_price${level - 1}`])) return null
    bids += bidSize
    asks += askSize
  }
  return bids + asks > 0 ? 100 * bids / (bids + asks) : null
}

function createState(day, candles = []) {
  return {
    day,
    candles: candles.slice(-MAX_CANDLES),
    fields: {},
    previousVolume: null,
    previousAsk1: null,
    lastDepthAt: 0,
    depthBuckets: new Map(),
    volumeHistory: [],
    lastWindowEnd: 0,
    activeId: null,
  }
}

function updateTrailing(signal, state, high, at = Date.now()) {
  state.highWater = Math.max(state.highWater ?? signal.entry, high)
  if (state.highWater >= signal.entry * (1 + BREAKEVEN_TRIGGER_PCT / 100)) {
    signal.stop = Math.max(signal.stop, signal.entry)
  }
  if (state.highWater >= signal.target) {
    signal.targetReachedAt ??= new Date(at).toISOString()
    signal.stop = Math.max(signal.stop, signal.entry,
      state.highWater * (1 - TRAIL_DISTANCE_PCT / 100))
  }
}

function closeSignal(signal, state, status, at, price) {
  signal.status = status
  signal.resolvedAt = new Date(at).toISOString()
  signal.exitPrice = Number(price.toFixed(2))
  signal.returnPct = 100 * (price / signal.entry - 1)
  signal.finalEligible = signal.returnPct > TARGET_PCT
  state.activeId = null
}

export function createCandleDepthTargetRadar({
  initialSignals = [], onUpdate = () => {}, now = () => Date.now(),
} = {}) {
  const states = new Map()
  const signals = initialSignals.slice()
  const signalIds = new Set(signals.map((signal) => signal.id))
  let sessionDate = indiaDate(now())

  function snapshot() { return signals.slice().reverse() }
  function publish() { onUpdate(snapshot(), sessionDate) }

  function resetDay(date = indiaDate(now())) {
    sessionDate = date
    states.clear()
    signals.length = 0
    signalIds.clear()
    publish()
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) resetDay(today)
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_CANDLES })
        const candles = rows
          .map(normalizeCandle)
          .filter(Boolean)
          .filter((candle) => indiaDate(candle.time * 1000) === sessionDate &&
            candle.time * 1000 < Math.floor(now() / MINUTE) * MINUTE)
        states.set(symbol, createState(sessionDate, candles))
      } catch {
        states.set(symbol, createState(sessionDate))
      }
    }))
  }

  function stateFor(symbol, at) {
    const day = indiaDate(at)
    let state = states.get(symbol)
    if (!state || state.day !== day) {
      if (day !== sessionDate) resetDay(day)
      state = createState(day)
      states.set(symbol, state)
    }
    return state
  }

  function resolveFromPrice(symbol, at, price) {
    const state = states.get(symbol)
    const signal = state?.activeId && signals.find((row) => row.id === state.activeId && row.status === "Active")
    if (!signal || !Number.isFinite(price) || price <= 0) return
    if (at >= signal.expiresAt) {
      closeSignal(signal, state, "TIME", at, price)
      publish()
      return
    }
    updateTrailing(signal, state, price, at)
    if (price <= signal.stop) {
      closeSignal(signal, state, signal.targetReachedAt ? "TRAIL_STOP" : "STOP", at, signal.stop)
      publish()
    }
  }

  function observePrice(data, receivedAt) {
    const symbol = toStockName(data?.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    const price = Number(data?.ltp)
    if (!symbol || !Number.isFinite(at) || !Number.isFinite(price)) return
    stateFor(symbol, at)
    resolveFromPrice(symbol, at, price)
  }

  function observeDepth(data, receivedAt, marketContext = null) {
    const symbol = toStockName(data?.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!symbol || !Number.isFinite(at) || indiaDate(at) !== sessionDate) return
    const session = marketDepthSession(new Date(at))
    if (!session.open) return
    const fields = depthUpdateFields(data)
    if (!fields) return
    const state = stateFor(symbol, at)
    if (state.lastDepthAt && at - state.lastDepthAt > 90_000) {
      state.fields = {}
      state.previousVolume = null
      state.previousAsk1 = null
      state.depthBuckets.clear()
    }
    for (const [key, value] of fields) state.fields[key] = value
    const bidShare = bookMetrics(state.fields)
    const minute = Math.floor(at / MINUTE) * MINUTE
    const bucket = state.depthBuckets.get(minute) || {
      volume: 0, askLiftVolume: 0, bidShareSum: 0, bidShareSamples: 0,
    }
    const cumulativeVolume = Number(marketContext?.cumulativeVolume)
    const ask1 = Number(state.fields.ask_price1)
    if (Number.isFinite(cumulativeVolume) && state.previousVolume !== null && cumulativeVolume >= state.previousVolume) {
      const executed = cumulativeVolume - state.previousVolume
      bucket.volume += executed
      if (executed > 0 && Number.isFinite(ask1) && Number.isFinite(state.previousAsk1) && ask1 > state.previousAsk1) {
        bucket.askLiftVolume += executed
      }
    }
    if (Number.isFinite(bidShare)) {
      bucket.bidShareSum += bidShare
      bucket.bidShareSamples++
    }
    state.depthBuckets.set(minute, bucket)
    state.previousVolume = Number.isFinite(cumulativeVolume) ? cumulativeVolume : state.previousVolume
    state.previousAsk1 = Number.isFinite(ask1) ? ask1 : state.previousAsk1
    state.lastDepthAt = at
    for (const key of state.depthBuckets.keys()) if (key < minute - 20 * MINUTE) state.depthBuckets.delete(key)
  }

  function evaluateWindow(symbol, state, candles) {
    if (candles.length < WINDOW_CANDLES) return
    const five = candles.slice(-WINDOW_CANDLES)
    if (five.some((row, index) => index && row.time !== five[index - 1].time + 60)) return
    const start = five[0].time * 1000
    const end = five.at(-1).time * 1000 + MINUTE
    if (end <= state.lastWindowEnd) return
    state.lastWindowEnd = end
    const depth = five.map((_, index) => state.depthBuckets.get(start + index * MINUTE))
    if (depth.some((row) => !row)) return
    const high = Math.max(...five.map((row) => row.high))
    const low = Math.min(...five.map((row) => row.low))
    const range = high - low
    const volume = depth.reduce((sum, row) => sum + row.volume, 0)
    const askLiftVolume = depth.reduce((sum, row) => sum + row.askLiftVolume, 0)
    const bidSamples = depth.reduce((sum, row) => sum + row.bidShareSamples, 0)
    const bidShare = bidSamples ? depth.reduce((sum, row) => sum + row.bidShareSum, 0) / bidSamples : 0
    const metrics = {
      volume,
      up: five.filter((row) => row.close > row.open).length,
      candleReturn: 100 * (five.at(-1).close / five[0].open - 1),
      closeLocation: range > 0 ? 100 * (five.at(-1).close - low) / range : 0,
      bodyEfficiency: range > 0 ? 100 * five.reduce((sum, row) => sum + Math.abs(row.close - row.open), 0) / range : 0,
      askLift: volume > 0 ? 100 * askLiftVolume / volume : 0,
      bidShare,
    }
    const volumeThreshold = percentile(state.volumeHistory, 0.75)
    state.volumeHistory.push(volume)
    if (state.volumeHistory.length > 240) state.volumeHistory.shift()
    if (state.volumeHistory.length < MIN_VOLUME_HISTORY || state.activeId) return
    if (metrics.up < 3 || metrics.candleReturn <= 0 || metrics.closeLocation < 80 ||
        metrics.bodyEfficiency < 80 || metrics.volume < volumeThreshold ||
        metrics.askLift < 50 || metrics.bidShare <= 50) return
    const id = `${symbol}:${end}:candle-depth-target`
    if (signalIds.has(id)) return
    const entry = five.at(-1).close
    const signal = {
      id,
      strategy: "Five-Candle Depth Target",
      symbol,
      direction: "BUY",
      time: new Date(end).toISOString(),
      entry,
      stop: entry * (1 - STOP_PCT / 100),
      target: entry * (1 + TARGET_PCT / 100),
      status: "Active",
      candleMinute: five.at(-1).time,
      expiresAt: end + MAX_HOLD_MINUTES * MINUTE,
      metrics: { ...metrics, volumeThreshold, volumeHistorySamples: state.volumeHistory.length },
    }
    state.activeId = id
    state.highWater = entry
    signals.push(signal)
    signalIds.add(id)
    publish()
  }

  function observeCandle(symbol, input) {
    const candle = normalizeCandle(input)
    const at = candle ? candle.time * 1000 : NaN
    if (!candle || !symbol || !Number.isFinite(at) || indiaDate(at) !== sessionDate || input.partial) return
    const state = stateFor(symbol, at)
    const rows = state.candles
    const existing = rows.findIndex((row) => row.time === candle.time)
    if (existing >= 0) rows[existing] = candle
    else rows.push(candle)
    rows.sort((left, right) => left.time - right.time)
    state.candles = rows.slice(-MAX_CANDLES)
    const active = state.activeId && signals.find((row) => row.id === state.activeId && row.status === "Active")
    if (active && candle.time * 1000 > active.candleMinute * 1000) {
      if (candle.low <= active.stop) {
        closeSignal(active, state, active.targetReachedAt ? "TRAIL_STOP" : "STOP", candle.time * 1000, active.stop)
        publish()
      } else {
        updateTrailing(active, state, candle.high, candle.time * 1000)
        if (candle.time * 1000 + MINUTE >= active.expiresAt) {
          closeSignal(active, state, "TIME", candle.time * 1000 + MINUTE, candle.close)
          publish()
        }
      }
    }
    evaluateWindow(symbol, state, state.candles)
  }

  function resetLiveState() {
    states.clear()
  }

  function flushCompleted() {
    // Price/candle observations resolve active trades; retained for the common
    // radar timer interface used by the dashboard.
  }

  return { seed, observeDepth, observePrice, observeCandle, resetLiveState, flushCompleted, snapshot }
}
