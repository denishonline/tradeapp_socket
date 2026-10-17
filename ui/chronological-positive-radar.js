import { depthUpdateFields, marketDepthSession } from "./market-depth.js"
import { toStockName } from "./market-data.js"
import {
  CHRONOLOGICAL_POSITIVE_CONFIG,
  chronologicalPositiveBranch,
} from "./chronological-positive-rules.js"

const MINUTE = 60_000
const INDIA_OFFSET = 330 * MINUTE
const MAX_CANDLES = 400
const WINDOW_CANDLES = 5
const {
  initialStopPct: INITIAL_STOP_PCT,
  targetPct: TARGET_PCT,
  breakevenTriggerPct: BREAKEVEN_TRIGGER_PCT,
  trailDistancePct: TRAIL_DISTANCE_PCT,
  maxHoldMinutes: MAX_HOLD_MINUTES,
} = CHRONOLOGICAL_POSITIVE_CONFIG

function indiaDate(epoch) {
  return new Date(epoch + INDIA_OFFSET).toISOString().slice(0, 10)
}

function indiaMinute(epoch) {
  const value = new Date(epoch + INDIA_OFFSET)
  return value.getUTCHours() * 60 + value.getUTCMinutes()
}

function pct(current, base) {
  return Number.isFinite(current) && Number.isFinite(base) && base !== 0 ? 100 * (current / base - 1) : 0
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position), upper = Math.ceil(position)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function normalizeCandle(input) {
  const time = Number(input?.time)
  const open = Number(input?.open), high = Number(input?.high)
  const low = Number(input?.low), close = Number(input?.close)
  const volume = Math.max(0, Number(input?.volume) || 0)
  if (!Number.isSafeInteger(time) || ![open, high, low, close].every(Number.isFinite) ||
      open <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) return null
  return { time, open, high, low, close, volume }
}

function bookMetrics(fields) {
  let bid = 0, ask = 0, topBid = 0, topAsk = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const bidSize = Number(fields[`bid_size${level}`])
    const askSize = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, bidSize, askSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bidSize < 0 || askSize < 0) return null
    if (level > 1 && (bidPrice > Number(fields[`bid_price${level - 1}`]) ||
        askPrice < Number(fields[`ask_price${level - 1}`]))) return null
    bid += bidSize
    ask += askSize
    if (level <= 2) { topBid += bidSize; topAsk += askSize }
  }
  const bestBid = Number(fields.bid_price1), bestAsk = Number(fields.ask_price1)
  return {
    bid, ask, bestBid, bestAsk, mid: (bestBid + bestAsk) / 2,
    bidShare: 100 * bid / (bid + ask || 1),
    top2BidShare: 100 * topBid / (topBid + topAsk || 1),
  }
}

function newDepthBucket() {
  return {
    volume: 0, askLiftVolume: 0, samples: 0, bidShareSum: 0, top2BidShareSum: 0,
    ofiSum: 0, ofiSamples: 0, firstMid: null, lastMid: null,
  }
}

function createState(day, candles = []) {
  return {
    day,
    candles: candles.slice(-MAX_CANDLES),
    fields: {},
    previousVolume: null,
    previousBook: null,
    lastDepthAt: 0,
    depthBuckets: new Map(),
    volumeHistory: [],
    lastWindowEnd: 0,
    activeId: null,
    highWater: null,
  }
}

function windowReturn(rows, count) {
  const selected = rows.slice(-count)
  return selected.length ? pct(selected.at(-1).close, selected[0].open) : 0
}

function updateTrailing(signal, state, high, at) {
  state.highWater = Math.max(state.highWater ?? signal.highWater ?? signal.entry, high)
  signal.highWater = state.highWater
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
  signal.returnPct = pct(price, signal.entry)
  signal.finalEligible = signal.returnPct > TARGET_PCT
  state.activeId = null
}

export function createChronologicalPositiveRadar({
  initialSignals = [], onUpdate = () => {}, now = () => Date.now(),
} = {}) {
  const states = new Map()
  const signals = initialSignals.slice()
  const signalIds = new Set(signals.map((signal) => signal.id))
  const signaledSymbols = new Set(signals.map((signal) => signal.symbol))
  let sessionDate = indiaDate(now())

  function snapshot() { return signals.slice().reverse() }
  function publish() { onUpdate(snapshot(), sessionDate) }

  function resetDay(date = indiaDate(now())) {
    sessionDate = date
    states.clear()
    signals.length = 0
    signalIds.clear()
    signaledSymbols.clear()
    publish()
  }

  function restorePosition(symbol, state) {
    const active = signals.find((signal) => signal.symbol === symbol && signal.status === "Active")
    if (!active) return
    state.activeId = active.id
    state.highWater = active.highWater ?? active.entry
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) resetDay(today)
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_CANDLES })
        const completed = rows.map(normalizeCandle).filter(Boolean)
          .filter((candle) => indiaDate(candle.time * 1000) === sessionDate &&
            candle.time * 1000 < Math.floor(now() / MINUTE) * MINUTE)
        const state = createState(sessionDate, completed)
        restorePosition(symbol, state)
        states.set(symbol, state)
      } catch {
        const state = createState(sessionDate)
        restorePosition(symbol, state)
        states.set(symbol, state)
      }
    }))
  }

  function stateFor(symbol, at) {
    const day = indiaDate(at)
    let state = states.get(symbol)
    if (!state || state.day !== day) {
      if (day !== sessionDate) resetDay(day)
      state = createState(day)
      restorePosition(symbol, state)
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
    if (price <= signal.stop) {
      closeSignal(signal, state, signal.targetReachedAt ? "TRAIL_STOP" : "STOP", at, signal.stop)
      publish()
      return
    }
    updateTrailing(signal, state, price, at)
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
    const receivedEpoch = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    const contextEpoch = Date.parse(marketContext?.priceAt)
    const at = Number.isFinite(contextEpoch) ? contextEpoch : receivedEpoch
    if (!symbol || !Number.isFinite(at) || indiaDate(at) !== sessionDate) return
    if (!marketDepthSession(new Date(at)).open) return
    const updates = depthUpdateFields(data)
    if (!updates) return
    const state = stateFor(symbol, at)
    if (state.lastDepthAt && at - state.lastDepthAt > 90_000) {
      state.fields = {}
      state.previousVolume = null
      state.previousBook = null
      state.depthBuckets.clear()
    }
    for (const [key, value] of updates) state.fields[key] = value
    const book = bookMetrics(state.fields)
    if (!book) return
    const minute = Math.floor(at / MINUTE) * MINUTE
    const bucket = state.depthBuckets.get(minute) || newDepthBucket()
    const cumulativeVolume = Number(marketContext?.cumulativeVolume)
    const executed = Number.isFinite(cumulativeVolume) && state.previousVolume !== null &&
      cumulativeVolume >= state.previousVolume ? cumulativeVolume - state.previousVolume : 0
    bucket.volume += executed
    if (executed > 0 && state.previousBook && book.bestAsk > state.previousBook.bestAsk) {
      bucket.askLiftVolume += executed
    }
    bucket.samples++
    bucket.bidShareSum += book.bidShare
    bucket.top2BidShareSum += book.top2BidShare
    bucket.firstMid ??= book.mid
    bucket.lastMid = book.mid
    if (state.previousBook) {
      const bidChange = book.bid - state.previousBook.bid
      const askChange = book.ask - state.previousBook.ask
      const denominator = Math.abs(bidChange) + Math.abs(askChange)
      if (denominator > 0) {
        bucket.ofiSum += (bidChange - askChange) / denominator
        bucket.ofiSamples++
      }
    }
    state.depthBuckets.set(minute, bucket)
    if (Number.isFinite(cumulativeVolume)) state.previousVolume = cumulativeVolume
    state.previousBook = book
    state.lastDepthAt = at
    for (const key of state.depthBuckets.keys()) if (key < minute - 30 * MINUTE) state.depthBuckets.delete(key)
  }

  function evaluateWindow(symbol, state) {
    if (state.candles.length < WINDOW_CANDLES || signaledSymbols.has(symbol)) return
    const five = state.candles.slice(-WINDOW_CANDLES)
    if (five.some((row, index) => index && row.time !== five[index - 1].time + 60)) return
    const start = five[0].time * 1000
    const end = five.at(-1).time * 1000 + MINUTE
    if (end <= state.lastWindowEnd) return
    state.lastWindowEnd = end
    const depth = five.map((_, index) => state.depthBuckets.get(start + index * MINUTE))
    if (depth.some((row) => !row)) return

    const depthVolume = depth.reduce((sum, row) => sum + row.volume, 0)
    const volumeThreshold = percentile(state.volumeHistory, 0.75)
    const volumeRatio = volumeThreshold > 0 ? depthVolume / volumeThreshold : 0
    state.volumeHistory.push(depthVolume)
    if (state.volumeHistory.length > 240) state.volumeHistory.shift()

    const high = Math.max(...five.map((row) => row.high))
    const low = Math.min(...five.map((row) => row.low))
    const range = high - low
    const last = five.at(-1)
    const samples = depth.reduce((sum, row) => sum + row.samples, 0)
    const ofiSamples = depth.reduce((sum, row) => sum + row.ofiSamples, 0)
    const firstDepth = depth.find((row) => Number.isFinite(row.firstMid))
    const lastDepth = [...depth].reverse().find((row) => Number.isFinite(row.lastMid))
    const dayVolume = state.candles.reduce((sum, row) => sum + row.volume, 0)
    const vwap = dayVolume > 0 ? state.candles.reduce((sum, row) =>
      sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / dayVolume : last.close
    const features = {
      timeMinute: indiaMinute(last.time * 1000),
      openingReturn: pct(last.close, state.candles[0].open),
      return1: windowReturn(state.candles, 1),
      return3: windowReturn(state.candles, 3),
      return5: windowReturn(state.candles, 5),
      green5: five.filter((row) => row.close > row.open).length,
      closeLocation: range > 0 ? 100 * (last.close - low) / range : 0,
      bodyEfficiency: range > 0
        ? 100 * five.reduce((sum, row) => sum + Math.abs(row.close - row.open), 0) / range : 0,
      vwapGap: pct(last.close, vwap),
      volumeRatio,
      askLift: depthVolume > 0
        ? 100 * depth.reduce((sum, row) => sum + row.askLiftVolume, 0) / depthVolume : 0,
      bidShare: samples ? depth.reduce((sum, row) => sum + row.bidShareSum, 0) / samples : 0,
      top2BidShare: samples ? depth.reduce((sum, row) => sum + row.top2BidShareSum, 0) / samples : 0,
      depthMidReturn: firstDepth && lastDepth ? pct(lastDepth.lastMid, firstDepth.firstMid) : 0,
      normalizedOfi: ofiSamples ? depth.reduce((sum, row) => sum + row.ofiSum, 0) / ofiSamples : 0,
    }
    const branch = chronologicalPositiveBranch(features)
    if (!branch) return
    const id = `${symbol}:${end}:chronological-positive`
    if (signalIds.has(id)) return
    const entry = last.close
    const signal = {
      id,
      strategy: "Chronological Positive Filter",
      calibration: "2026-10-16 in-sample",
      symbol,
      direction: "BUY",
      branch,
      time: new Date(end).toISOString(),
      price: entry,
      entry,
      stop: entry * (1 - INITIAL_STOP_PCT / 100),
      target: entry * (1 + TARGET_PCT / 100),
      highWater: entry,
      status: "Active",
      candleMinute: last.time,
      expiresAt: end + MAX_HOLD_MINUTES * MINUTE,
      metrics: { ...features, depthVolume, volumeThreshold },
    }
    state.activeId = id
    state.highWater = entry
    signals.push(signal)
    signalIds.add(id)
    signaledSymbols.add(symbol)
    publish()
  }

  function observeCandle(symbol, input) {
    const candle = normalizeCandle(input)
    const at = candle ? candle.time * 1000 : NaN
    if (!candle || !symbol || !Number.isFinite(at) || indiaDate(at) !== sessionDate || input.partial) return
    const state = stateFor(symbol, at)
    const existing = state.candles.findIndex((row) => row.time === candle.time)
    if (existing >= 0) state.candles[existing] = candle
    else state.candles.push(candle)
    state.candles.sort((left, right) => left.time - right.time)
    state.candles = state.candles.slice(-MAX_CANDLES)

    const active = state.activeId && signals.find((row) => row.id === state.activeId && row.status === "Active")
    if (active && candle.time > active.candleMinute) {
      if (candle.low <= active.stop) {
        closeSignal(active, state, active.targetReachedAt ? "TRAIL_STOP" : "STOP", at, active.stop)
        publish()
      } else {
        updateTrailing(active, state, candle.high, at)
        if (at + MINUTE >= active.expiresAt) {
          closeSignal(active, state, "TIME", at + MINUTE, candle.close)
          publish()
        }
      }
    }
    evaluateWindow(symbol, state)
  }

  function resetLiveState() {
    states.clear()
  }

  function flushCompleted() {
    // Price and completed-candle observations resolve active positions.
  }

  return { seed, observeDepth, observePrice, observeCandle, resetLiveState, flushCompleted, snapshot }
}
