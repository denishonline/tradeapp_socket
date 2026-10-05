import { depthUpdateFields } from "./market-depth.js"
import { toStockName } from "./market-data.js"

export const DEPTH_MOMENTUM_RULE = Object.freeze({
  lookbackCandles: 10,
  breakoutCandles: 5,
  minimumVolume: 1_000,
  minimumVolumeMultiple: 5,
  minimumCloseLocation: 0.7,
  depthMinutes: 3,
  minimumDepthImbalance: 0.4,
  minimumTop2Imbalance: 0.4,
  shallowBreakoutPct: 0.05,
  minimumShallowBreakoutTop2Imbalance: 0.55,
  maximumBreakoutPct: 0.15,
  cooldownMinutes: 10,
  maximumSignals: 1_000,
})

export const DEPTH_CONTINUATION_RULE = Object.freeze({
  ...DEPTH_MOMENTUM_RULE,
  minimumVolumeMultiple: 7,
  minimumDepthImbalance: 0.43,
  minimumTop2Imbalance: 0.48,
  minimumBreakoutPct: 0.05,
  maximumBreakoutPct: 0.15,
})

export const DEPTH_CONTINUATION_SHORT_RULE = Object.freeze({
  ...DEPTH_CONTINUATION_RULE,
  minimumCloseLocation: 0.3,
})

export const DEPTH_SHORT_BREAKDOWN_RULE = Object.freeze({
  lookbackCandles: 10,
  breakoutCandles: 5,
  minimumVolumeMultiple: 1,
  maximumCloseLocation: 0.3,
  depthMinutes: 3,
  sellDepthImbalance: 0.2,
  sellTop2Imbalance: 0.3,
  bidDepthImbalance: 0.15,
  bidTop2Imbalance: 0.3,
  minimumBreakdownPct: 0.05,
  maximumBreakdownPct: 0.15,
  cooldownMinutes: 10,
})

export const DEPTH_LONG_ABSORPTION_RULE = Object.freeze({
  lookbackCandles: 50,
  breakoutCandles: 5,
  depthMinutes: 3,
  minimumCandleScore: 5,
  confirmationMaxDelayMinutes: 2,
  maximumCandidateDriftPct: 0.5,
  maximumSupportedDepthImbalance: 0.1,
  maximumAbsorptionTop2Imbalance: -0.15,
  minimumAbsorptionPersistence: 0.5,
  minimumAbsorptionOrderImbalance: 0,
  minimumAbsorptionOrderFlowImbalance: 0,
  targetPct: 1.51,
  stopPct: 0.5,
  cooldownMinutes: 10,
})

// Candle closes are evaluated with the three completed depth minutes ending at that candle.
export const STRICT_LONG_ABSORPTION_RULE = Object.freeze({
  lookbackCandles: 30,
  depthMinutes: 3,
  minimumBreakoutPct: 0.05,
  minimumCloseLocation: 0.8,
  minimumVolumeMultiple5: 2,
  minimumReturn10Pct: 0.05,
  maximumReturn10Pct: 0.15,
  maximumReturn30Pct: 0.15,
  maximumPrior3VolumeMultiple10: 0.5,
  maximumDepthImbalance: 0,
  maximumTop2Imbalance: -0.3,
  targetPct: 1.51,
  stopPct: 0.5,
  cooldownMinutes: 10,
})

export function evaluateStrictLongAbsorptionCandle(current, previousCandles, overrides = null) {
  const rule = overrides ? { ...STRICT_LONG_ABSORPTION_RULE, ...overrides } : STRICT_LONG_ABSORPTION_RULE
  if (previousCandles.length !== rule.lookbackCandles ||
      previousCandles.some((row, index) => index > 0 && row.time !== previousCandles[index - 1].time + 60) ||
      current.time !== previousCandles.at(-1).time + 60) return null
  const previous10 = previousCandles.slice(-10)
  const previous5 = previousCandles.slice(-5)
  const priorHigh = Math.max(...previous5.map((row) => row.high))
  const breakoutPct = (current.close / priorHigh - 1) * 100
  const closeLocation = (current.close - current.low) / (current.high - current.low || 1)
  const avgVolume10 = previous10.reduce((sum, row) => sum + row.volume, 0) / 10
  const avgVolume5 = previous5.reduce((sum, row) => sum + row.volume, 0) / 5
  const prior3Volume = previousCandles.slice(-3).reduce((sum, row) => sum + row.volume, 0) / 3
  const return10Pct = (current.close / previousCandles.at(-10).close - 1) * 100
  const return30Pct = (current.close / previousCandles[0].close - 1) * 100
  if (current.close <= current.open || breakoutPct < rule.minimumBreakoutPct ||
      (Number.isFinite(rule.maximumBreakoutPct) && breakoutPct > rule.maximumBreakoutPct) ||
      closeLocation < rule.minimumCloseLocation ||
      current.volume < avgVolume10 || current.volume < rule.minimumVolumeMultiple5 * avgVolume5 ||
      return10Pct < rule.minimumReturn10Pct || return10Pct > rule.maximumReturn10Pct ||
      return30Pct > rule.maximumReturn30Pct ||
      prior3Volume > rule.maximumPrior3VolumeMultiple10 * avgVolume10) return null
  return { breakoutPct, closeLocation, volumeMultiple: avgVolume5 > 0 ? current.volume / avgVolume5 : 0,
    return10Pct, return30Pct }
}

export function confirmStrictLongAbsorptionDepth(depthWindow) {
  const rule = STRICT_LONG_ABSORPTION_RULE
  if (depthWindow.length !== rule.depthMinutes || depthWindow.some((row, index) =>
    !row || !Number.isFinite(row.imbalance) || !Number.isFinite(row.nearImbalance) ||
    index > 0 && row.minute !== depthWindow[index - 1].minute + 1)) return null
  const depthImbalance = depthWindow.reduce((sum, row) => sum + row.imbalance, 0) / depthWindow.length
  const top2Imbalance = depthWindow.reduce((sum, row) => sum + row.nearImbalance, 0) / depthWindow.length
  if (depthImbalance > rule.maximumDepthImbalance || top2Imbalance > rule.maximumTop2Imbalance) return null
  return { depthImbalance, top2Imbalance }
}

export function evaluateStrictLongAbsorption(current, previousCandles, depthWindow) {
  const candle = evaluateStrictLongAbsorptionCandle(current, previousCandles)
  const depth = candle && confirmStrictLongAbsorptionDepth(depthWindow)
  return depth ? { ...candle, ...depth, pattern: "Ask absorption" } : null
}

const MAX_SESSION_CANDLES = 390

function evaluateRule(current, previousCandles, depthWindow, rule) {
  if (previousCandles.length !== rule.lookbackCandles || depthWindow.length !== rule.depthMinutes) return null
  if (previousCandles.some((candle, index) => index > 0 && candle.time !== previousCandles[index - 1].time + 60)) return null
  if (current.time !== previousCandles.at(-1).time + 60) return null
  if (depthWindow.some((minute, index) => index > 0 && minute.minute !== depthWindow[index - 1].minute + 1)) return null

  const previous5 = previousCandles.slice(-rule.breakoutCandles)
  const priorHigh = Math.max(...previous5.map((candle) => candle.high))
  const avgVolume = previousCandles.reduce((sum, candle) => sum + candle.volume, 0) / previousCandles.length
  const volumeMultiple = avgVolume > 0 ? current.volume / avgVolume : 0
  const range = current.high - current.low
  const closeLocation = range > 0 ? (current.close - current.low) / range : 0
  const depthImbalance = depthWindow.reduce((sum, minute) => sum + minute.imbalance, 0) / depthWindow.length
  const top2Imbalance = depthWindow.reduce((sum, minute) => sum + minute.nearImbalance, 0) / depthWindow.length
  const breakoutPct = (current.close / priorHigh - 1) * 100

  if (current.close <= priorHigh || current.close <= current.open || current.volume < rule.minimumVolume ||
      volumeMultiple < rule.minimumVolumeMultiple || closeLocation < rule.minimumCloseLocation ||
      depthImbalance < rule.minimumDepthImbalance || top2Imbalance < rule.minimumTop2Imbalance ||
      (rule.minimumBreakoutPct && breakoutPct < rule.minimumBreakoutPct) ||
      (rule.maximumBreakoutPct && breakoutPct > rule.maximumBreakoutPct) ||
      (rule.shallowBreakoutPct && breakoutPct < rule.shallowBreakoutPct && top2Imbalance < rule.minimumShallowBreakoutTop2Imbalance)) return null
  return { priorHigh, volumeMultiple, closeLocation, depthImbalance, top2Imbalance, breakoutPct }
}

export function evaluateDepthMomentum(current, previousCandles, depthWindow) {
  return evaluateRule(current, previousCandles, depthWindow, DEPTH_MOMENTUM_RULE)
}

export function evaluateDepthContinuation(current, previousCandles, depthWindow) {
  return evaluateRule(current, previousCandles, depthWindow, DEPTH_CONTINUATION_RULE)
}

export function evaluateDepthContinuationShort(current, previousCandles, depthWindow) {
  const rule = DEPTH_CONTINUATION_SHORT_RULE
  if (previousCandles.length !== rule.lookbackCandles || depthWindow.length !== rule.depthMinutes) return null
  if (previousCandles.some((candle, index) => index > 0 && candle.time !== previousCandles[index - 1].time + 60)) return null
  if (current.time !== previousCandles.at(-1).time + 60) return null
  if (depthWindow.some((minute, index) => index > 0 && minute.minute !== depthWindow[index - 1].minute + 1)) return null

  const previous5 = previousCandles.slice(-rule.breakoutCandles)
  const priorLow = Math.min(...previous5.map((candle) => candle.low))
  const avgVolume = previousCandles.reduce((sum, candle) => sum + candle.volume, 0) / previousCandles.length
  const volumeMultiple = avgVolume > 0 ? current.volume / avgVolume : 0
  const range = current.high - current.low
  const closeLocation = range > 0 ? (current.close - current.low) / range : 0
  const sellDepthImbalance = -depthWindow.reduce((sum, minute) => sum + minute.imbalance, 0) / depthWindow.length
  const sellTop2Imbalance = -depthWindow.reduce((sum, minute) => sum + minute.nearImbalance, 0) / depthWindow.length
  const breakoutPct = (1 - current.close / priorLow) * 100

  if (current.close >= priorLow || current.close >= current.open || current.volume < rule.minimumVolume ||
      volumeMultiple < rule.minimumVolumeMultiple || closeLocation > rule.minimumCloseLocation ||
      sellDepthImbalance < rule.minimumDepthImbalance || sellTop2Imbalance < rule.minimumTop2Imbalance ||
      breakoutPct < rule.minimumBreakoutPct || breakoutPct > rule.maximumBreakoutPct) return null
  return { priorLow, volumeMultiple, closeLocation, depthImbalance: sellDepthImbalance, top2Imbalance: sellTop2Imbalance, breakoutPct }
}

export function evaluateDepthShortBreakdown(current, previousCandles, depthWindow) {
  const rule = DEPTH_SHORT_BREAKDOWN_RULE
  if (previousCandles.length !== rule.lookbackCandles || depthWindow.length !== rule.depthMinutes) return null
  if (previousCandles.some((candle, index) => index > 0 && candle.time !== previousCandles[index - 1].time + 60)) return null
  if (current.time !== previousCandles.at(-1).time + 60) return null
  if (depthWindow.some((minute, index) => index > 0 && minute.minute !== depthWindow[index - 1].minute + 1)) return null

  const priorLow = Math.min(...previousCandles.slice(-rule.breakoutCandles).map((candle) => candle.low))
  const avgVolume = previousCandles.reduce((sum, candle) => sum + candle.volume, 0) / previousCandles.length
  const volumeMultiple = avgVolume > 0 ? current.volume / avgVolume : 0
  const closeLocation = (current.close - current.low) / (current.high - current.low || 1)
  const depthImbalance = depthWindow.reduce((sum, minute) => sum + minute.imbalance, 0) / depthWindow.length
  const top2Imbalance = depthWindow.reduce((sum, minute) => sum + minute.nearImbalance, 0) / depthWindow.length
  const breakdownPct = (1 - current.close / priorLow) * 100
  const pattern = depthImbalance <= -rule.sellDepthImbalance && top2Imbalance <= -rule.sellTop2Imbalance
    ? "Sell pressure confirms breakdown"
    : depthImbalance >= rule.bidDepthImbalance && top2Imbalance >= rule.bidTop2Imbalance
      ? "Breakdown despite bid-heavy depth"
      : null

  if (current.close >= current.open || closeLocation > rule.maximumCloseLocation || current.volume <= 0 ||
      volumeMultiple < rule.minimumVolumeMultiple || breakdownPct < rule.minimumBreakdownPct ||
      breakdownPct > rule.maximumBreakdownPct || !pattern) return null
  return { priorLow, volumeMultiple, closeLocation, depthImbalance, top2Imbalance, breakoutPct: breakdownPct, pattern }
}

export function evaluateDepthLongAbsorption(current, previousCandles) {
  const rule = DEPTH_LONG_ABSORPTION_RULE
  if (!Array.isArray(previousCandles) || previousCandles.length < rule.lookbackCandles) return null
  const candles = [...previousCandles, current]
  if (candles.some((candle, index) => index > 0 && candle.time <= candles[index - 1].time)) return null

  const closes = candles.map((candle) => candle.close)
  const ema = (period) => {
    const alpha = 2 / (period + 1)
    const emaCloses = closes.slice(-period * 3)
    return emaCloses.reduce((value, close, index) =>
      index === 0 ? close : close * alpha + value * (1 - alpha), emaCloses[0])
  }
  const ema20 = ema(20)
  const ema50 = ema(50)
  const last15 = candles.slice(-15)
  const changes = last15.slice(1).map((candle, index) => candle.close - last15[index].close)
  const avgGain = changes.reduce((sum, change) => sum + Math.max(0, change), 0) / changes.length
  const avgLoss = changes.reduce((sum, change) => sum + Math.max(0, -change), 0) / changes.length
  const rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  let positiveMoneyFlow = 0
  let negativeMoneyFlow = 0
  const mfiCandles = last15
  for (let index = 1; index < mfiCandles.length; index++) {
    const previous = mfiCandles[index - 1]
    const candle = mfiCandles[index]
    const typical = (candle.high + candle.low + candle.close) / 3
    const previousTypical = (previous.high + previous.low + previous.close) / 3
    const flow = typical * candle.volume
    if (typical > previousTypical) positiveMoneyFlow += flow
    else if (typical < previousTypical) negativeMoneyFlow += flow
  }
  const mfi14 = negativeMoneyFlow === 0 ? 100 : 100 - 100 / (1 + positiveMoneyFlow / negativeMoneyFlow)

  const sessionVolume = candles.reduce((sum, candle) => sum + candle.volume, 0)
  const vwap = sessionVolume > 0
    ? candles.reduce((sum, candle) => sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume, 0) / sessionVolume
    : 0
  const prior10 = candles.slice(-11, -1)
  const prior20 = candles.slice(-21, -1)
  const prior5 = candles.slice(-(rule.breakoutCandles + 1), -1)
  if (prior10.length !== 10 || prior20.length !== 20) return null
  const prior10High = Math.max(...prior10.map((candle) => candle.high))
  const prior20High = Math.max(...prior20.map((candle) => candle.high))
  const prior5High = Math.max(...prior5.map((candle) => candle.high))
  const avgPrior5Volume = prior5.reduce((sum, candle) => sum + candle.volume, 0) / prior5.length
  const avgPrior20Volume = prior20.reduce((sum, candle) => sum + candle.volume, 0) / prior20.length
  const volumeMultiple20 = avgPrior20Volume > 0 ? current.volume / avgPrior20Volume : 0
  const volumeMultiple5 = avgPrior5Volume > 0 ? current.volume / avgPrior5Volume : 0
  const closeLocation = (current.close - current.low) / (current.high - current.low || 1)
  const breakout5Pct = (current.close / prior5High - 1) * 100
  const return5Pct = (current.close / candles.at(-6).close - 1) * 100
  const return10Pct = (current.close / candles.at(-11).close - 1) * 100
  const return20Pct = (current.close / candles.at(-21).close - 1) * 100
  const return30Pct = (current.close / candles.at(-31).close - 1) * 100
  const prior10Volume = candles.slice(-11, -1).reduce((sum, candle) => sum + candle.volume, 0) / 10
  const prior3Volume = candles.slice(-4, -1).reduce((sum, candle) => sum + candle.volume, 0) / 3
  const prior3VolumeMultiple10 = prior10Volume > 0 ? prior3Volume / prior10Volume : Infinity
  const last21 = candles.slice(-21)
  const moves20 = last21.slice(1).map((candle, index) => candle.close - last21[index].close)
  const trendEfficiency20 = moves20.reduce((sum, move) => sum + move, 0) /
    (moves20.reduce((sum, move) => sum + Math.abs(move), 0) || 1)
  const last15ForAtr = candles.slice(-15)
  const trueRanges = last15ForAtr.slice(1).map((candle, index) =>
    Math.max(candle.high - candle.low, Math.abs(candle.high - last15ForAtr[index].close),
      Math.abs(candle.low - last15ForAtr[index].close)))
  const atr14Pct = trueRanges.reduce((sum, range) => sum + range, 0) / trueRanges.length / current.close * 100
  const emaBullish = current.close > ema20 && ema20 > ema50
  const breakout = current.close > prior10High
  const checks = {
    emaBullish,
    aboveVwap: current.close > vwap,
    rsiPositive: rsi14 >= 50 && rsi14 <= 78,
    mfiPositive: mfi14 >= 50,
    momentum5: return5Pct > 0,
    momentum10: return10Pct > 0,
    breakout,
    volumeExpansion: volumeMultiple20 >= 1.2,
    strongClose: closeLocation >= 0.6,
  }
  const candleScore = Object.values(checks).filter(Boolean).length
  if (candleScore < rule.minimumCandleScore || !emaBullish) return null

  return {
    candleScore, checks, ema20, ema50, rsi14, mfi14, vwap, return5Pct, return10Pct,
    return20Pct, return30Pct, prior3VolumeMultiple10, trendEfficiency20, atr14Pct,
    volumeMultiple20, volumeMultiple5, avgPrior20Volume, closeLocation,
    breakout5Pct, prior5High, prior10High, prior20High,
    pattern: "Bullish candle setup awaiting depth confirmation",
  }
}

export function confirmDepthLongAbsorption(features, depthWindow, candidatePrice, currentPrice) {
  const rule = DEPTH_LONG_ABSORPTION_RULE
  if (!features?.checks?.emaBullish || depthWindow.length !== rule.depthMinutes ||
      depthWindow.some((row, index) => !row || row.count <= 0 ||
        index > 0 && row.minute !== depthWindow[index - 1].minute + 1)) return null

  const depthImbalance = depthWindow.reduce((sum, row) => sum + row.imbalance, 0) / depthWindow.length
  const top2Imbalance = depthWindow.reduce((sum, row) => sum + row.nearImbalance, 0) / depthWindow.length
  const orderImbalance = depthWindow.reduce((sum, row) => sum + row.orderImbalance, 0) / depthWindow.length
  const bestLevelImbalance = depthWindow.reduce((sum, row) => sum + row.bestLevelImbalance, 0) / depthWindow.length
  const orderFlowImbalance = depthWindow.reduce((sum, row) => sum + row.ofi, 0) /
    (depthWindow.reduce((sum, row) => sum + row.ofiDepth, 0) || 1)
  const askPersistence = depthWindow.reduce((sum, row) => sum + row.askAbsorptionCount, 0) /
    depthWindow.reduce((sum, row) => sum + row.count, 0)
  const driftPct = (currentPrice / candidatePrice - 1) * 100
  if (depthImbalance > rule.maximumSupportedDepthImbalance ||
      top2Imbalance > rule.maximumAbsorptionTop2Imbalance ||
      orderImbalance <= rule.minimumAbsorptionOrderImbalance ||
      askPersistence < rule.minimumAbsorptionPersistence ||
      orderFlowImbalance <= rule.minimumAbsorptionOrderFlowImbalance ||
      driftPct < 0 || driftPct > rule.maximumCandidateDriftPct) return null

  return { depthImbalance, top2Imbalance, orderImbalance, bestLevelImbalance,
    orderFlowImbalance, askPersistence, driftPct }
}

function bookImbalance(book) {
  let bid = 0, ask = 0, nearBid = 0, nearAsk = 0
  let bidOrders = 0, askOrders = 0
  const bidPrices = [], askPrices = []
  let bestBidSize = 0, bestAskSize = 0
  for (let level = 1; level <= 5; level++) {
    const bp = Number(book[`bid_price${level}`]), bq = Number(book[`bid_size${level}`])
    const ap = Number(book[`ask_price${level}`]), aq = Number(book[`ask_size${level}`])
    if (![bp, bq, ap, aq].every(Number.isFinite) || bp <= 0 || ap <= 0 || bq < 0 || aq < 0) return null
    if (level > 1 && (bp > bidPrices.at(-1) || ap < askPrices.at(-1))) return null
    bidPrices.push(bp); askPrices.push(ap)
    if (level === 1) { bestBidSize = bq; bestAskSize = aq }
    bid += bq; ask += aq
    bidOrders += Number(book[`bid_order${level}`]) || 0
    askOrders += Number(book[`ask_order${level}`]) || 0
    if (level <= 2) { nearBid += bq; nearAsk += aq }
  }
  if (bid + ask === 0 || bidPrices[0] >= askPrices[0]) return null
  return {
    imbalance: (bid - ask) / (bid + ask),
    nearImbalance: (nearBid - nearAsk) / (nearBid + nearAsk || 1),
    orderImbalance: (bidOrders - askOrders) / (bidOrders + askOrders || 1),
    bestLevelImbalance: (bestBidSize - bestAskSize) / (bestBidSize + bestAskSize || 1),
    bestBid: bidPrices[0], bestAsk: askPrices[0], bestBidSize, bestAskSize,
  }
}

function indiaDate(timestamp) {
  return new Date(timestamp + 330 * 60_000).toISOString().slice(0, 10)
}

export function createDepthMomentumRadar({ onUpdate = () => {}, now = () => Date.now() } = {}) {
  const candlesByStock = new Map()
  const bookFieldsByStock = new Map()
  const minuteDepthByStock = new Map()
  const activeByStrategyStock = new Map()
  const lastSignalMinuteByStrategyStock = new Map()
  const signals = []
  let sessionDate = indiaDate(now())

  function publish() {
    onUpdate(snapshot())
  }

  function snapshot() {
    return signals.slice(-DEPTH_MOMENTUM_RULE.maximumSignals).slice().reverse()
  }

  function resetLiveState() {
    bookFieldsByStock.clear()
    minuteDepthByStock.clear()
    let changed = false
    for (const signal of activeByStrategyStock.values()) {
      signal.status = "Paused"
      changed = true
    }
    activeByStrategyStock.clear()
    if (changed) publish()
  }

  async function seed(stocks, candleStore) {
    const today = indiaDate(now())
    if (today !== sessionDate) {
      signals.length = 0
      candlesByStock.clear()
      lastSignalMinuteByStrategyStock.clear()
      publish()
    }
    sessionDate = today
    resetLiveState()
    await Promise.all(stocks.map(async (symbol) => {
      try {
        const rows = await candleStore.read(symbol, { limit: MAX_SESSION_CANDLES })
        const currentMinute = Math.floor(now() / 60_000)
        const today = rows.filter((candle) => Math.floor(candle.time / 60) < currentMinute && indiaDate(candle.time * 1000) === sessionDate)
        candlesByStock.set(symbol, today.slice(-MAX_SESSION_CANDLES).map((candle) => ({
          time: Math.floor(candle.time / 60) * 60, open: Number(candle.open), high: Number(candle.high),
          low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume),
        })))
      } catch { candlesByStock.set(symbol, []) }
    }))
  }

  function observeDepth(data, receivedAt, marketContext = null) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    if (!symbol) return
    const timestamp = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    if (!Number.isFinite(timestamp) || indiaDate(timestamp) !== sessionDate) return
    const fields = depthUpdateFields(data)
    if (!fields) return

    let state = bookFieldsByStock.get(symbol)
    if (!state || timestamp - state.lastAt > 90_000) state = { fields: {}, lastAt: timestamp }
    const previousBook = state.book || null
    for (const [key, value] of fields) state.fields[key] = value
    state.lastAt = timestamp
    bookFieldsByStock.set(symbol, state)
    const metrics = bookImbalance(state.fields)
    if (!metrics) { state.book = null; return }
    const ofi = previousBook
      ? (metrics.bestBid >= previousBook.bestBid ? metrics.bestBidSize : 0) -
        (metrics.bestBid <= previousBook.bestBid ? previousBook.bestBidSize : 0) -
        (metrics.bestAsk <= previousBook.bestAsk ? metrics.bestAskSize : 0) +
        (metrics.bestAsk >= previousBook.bestAsk ? previousBook.bestAskSize : 0)
      : 0
    const ofiDepth = previousBook
      ? (metrics.bestBidSize + metrics.bestAskSize + previousBook.bestBidSize + previousBook.bestAskSize) / 2
      : 0
    state.book = metrics

    const marketTime = Date.parse(marketContext?.priceAt)
    const minute = Math.floor((Number.isFinite(marketTime) ? marketTime : timestamp) / 60_000)
    const stockMinutes = minuteDepthByStock.get(symbol) || new Map()
    const bucket = stockMinutes.get(minute) || { minute, count: 0, imbalance: 0, nearImbalance: 0,
      orderImbalance: 0, bestLevelImbalance: 0, askAbsorptionCount: 0, ofi: 0, ofiDepth: 0 }
    bucket.count++
    bucket.imbalance += metrics.imbalance
    bucket.nearImbalance += metrics.nearImbalance
    bucket.orderImbalance += metrics.orderImbalance
    bucket.bestLevelImbalance += metrics.bestLevelImbalance
    bucket.ofi += ofi
    bucket.ofiDepth += ofiDepth
    if (metrics.imbalance <= DEPTH_LONG_ABSORPTION_RULE.maximumSupportedDepthImbalance &&
        metrics.nearImbalance <= DEPTH_LONG_ABSORPTION_RULE.maximumAbsorptionTop2Imbalance) bucket.askAbsorptionCount++
    stockMinutes.set(minute, bucket)
    for (const row of stockMinutes.values()) {
      if (row.count > 0) {
        row.averageImbalance = row.imbalance / row.count
        row.averageNearImbalance = row.nearImbalance / row.count
        row.averageOrderImbalance = row.orderImbalance / row.count
        row.averageBestLevelImbalance = row.bestLevelImbalance / row.count
      }
    }
    for (const key of stockMinutes.keys()) if (key < minute - 4) stockMinutes.delete(key)
    minuteDepthByStock.set(symbol, stockMinutes)
  }

  function observeCandle(symbol, candle) {
    if (!symbol || !candle || candle.partial) return
    const current = {
      time: Math.floor(Number(candle.time) / 60) * 60, open: Number(candle.open), high: Number(candle.high),
      low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume),
    }
    if (!Number.isFinite(current.time) || ![current.open, current.high, current.low, current.close, current.volume].every(Number.isFinite)) return
    const timestamp = current.time * 1000
    const date = indiaDate(timestamp)
    if (date !== sessionDate) {
      if (date < sessionDate) return
      sessionDate = date
      resetLiveState()
      candlesByStock.clear()
      lastSignalMinuteByStrategyStock.clear()
      signals.length = 0
      publish()
    }

    const rows = candlesByStock.get(symbol) || []
    const existing = rows.findIndex((row) => row.time === current.time)
    if (existing >= 0) rows[existing] = current
    else rows.push(current)
    rows.sort((a, b) => a.time - b.time)
    const todayRows = rows.filter((row) => indiaDate(row.time * 1000) === sessionDate).slice(-MAX_SESSION_CANDLES)
    candlesByStock.set(symbol, todayRows)

    const strategies = [
      { key: "momentum", name: "Depth + Candle Momentum", rule: DEPTH_MOMENTUM_RULE, evaluate: evaluateDepthMomentum, targetPct: 2.01 },
      { key: "continuation", name: "Depth-Supported Continuation", rule: DEPTH_CONTINUATION_RULE, evaluate: evaluateDepthContinuation, targetPct: 1.51 },
      { key: "short-breakdown", name: "Depth + Candle Short Breakdown", rule: DEPTH_SHORT_BREAKDOWN_RULE, evaluate: evaluateDepthShortBreakdown, targetPct: 2.01, direction: "SELL" },
      { key: "long-absorption", name: "Candle + Depth Absorption Breakout", rule: STRICT_LONG_ABSORPTION_RULE, evaluate: evaluateStrictLongAbsorption, targetPct: STRICT_LONG_ABSORPTION_RULE.targetPct },
    ]
    for (const strategy of strategies) {
      const stateKey = `${strategy.key}:${symbol}`
      const active = activeByStrategyStock.get(stateKey)
      if (!active || current.time <= active.candleMinute) continue
      const stopHit = active.direction === "SELL" ? current.high >= active.stop : current.low <= active.stop
      const targetHit = active.direction === "SELL" ? current.low <= active.target : current.high >= active.target
      if (!stopHit && !targetHit) continue
      active.status = stopHit ? "Stopped" : "Target reached"
      active.resolvedAt = new Date(current.time * 1000).toISOString()
      activeByStrategyStock.delete(stateKey)
      publish()
    }

    const history = todayRows.slice(0, -1)
    if (history.length < DEPTH_MOMENTUM_RULE.lookbackCandles) return
    const minuteBuckets = minuteDepthByStock.get(symbol)
    const currentMinute = Math.floor(current.time / 60)
    const depthWindow = [currentMinute - 2, currentMinute - 1, currentMinute].map((minute) => {
      const row = minuteBuckets?.get(minute)
      return row && { minute, imbalance: row.averageImbalance, nearImbalance: row.averageNearImbalance }
    })
    let addedSignal = false
    if (depthWindow.every(Boolean)) for (const strategy of strategies) {
      const stateKey = `${strategy.key}:${symbol}`
      if (activeByStrategyStock.has(stateKey)) continue
      const historyWindow = history.slice(-strategy.rule.lookbackCandles)
      const features = strategy.evaluate(current, historyWindow, depthWindow)
      if (!features) continue
      const lastSignalMinute = lastSignalMinuteByStrategyStock.get(stateKey) ?? -Infinity
      if (currentMinute - lastSignalMinute < strategy.rule.cooldownMinutes) continue

      const entry = current.close
      const direction = strategy.direction || "BUY"
      const sign = direction === "SELL" ? -1 : 1
      const signal = {
        id: `${symbol}:${current.time}:${strategy.key}`,
        strategy: strategy.name,
        symbol,
        direction,
        pattern: features.pattern,
        time: new Date((current.time + 60) * 1000).toISOString(),
        price: entry,
        stop: entry * (1 - sign * 0.5 / 100),
        target: entry * (1 + sign * strategy.targetPct / 100),
        volumeMultiple: features.volumeMultiple,
        depthImbalance: features.depthImbalance,
        top2Imbalance: features.top2Imbalance,
        breakoutPct: features.breakoutPct,
        status: "Active",
        candleMinute: current.time,
      }
      signals.push(signal)
      if (signals.length > DEPTH_MOMENTUM_RULE.maximumSignals) signals.shift()
      activeByStrategyStock.set(stateKey, signal)
      lastSignalMinuteByStrategyStock.set(stateKey, currentMinute)
      addedSignal = true
    }

    if (addedSignal) publish()
  }

  return { observeDepth, observeCandle, seed, snapshot, resetLiveState }
}
