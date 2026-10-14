import { depthUpdateFields } from "./market-depth.js"
import { toStockName } from "./market-data.js"
import { passesFailedBidQuality } from "./strategy-quality-gates.js"

const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const MAX_CANDLES = 400
const TARGET_PCT = 1
const STOP_PCT = 0.4
const EVALUATION_DELAY_MS = 2_000
const COOLDOWN_MS = 30 * MINUTE

const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)

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
  let bid = NaN
  let ask = NaN
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const currentBidSize = Number(fields[`bid_size${level}`])
    const currentAskSize = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, currentBidSize, currentAskSize].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || currentBidSize < 0 || currentAskSize < 0) return null
    if (level === 1) { bid = bidPrice; ask = askPrice }
    bidSize += currentBidSize
    askSize += currentAskSize
  }
  if (bidSize <= 0 || askSize <= 0) return null
  return { bid, ask, bidSize, askSize, bidSharePct: 100 * bidSize / (bidSize + askSize) }
}

function branchFor(event, candle, prior30Average) {
  if (!Number.isFinite(prior30Average) || prior30Average <= 0 || candle.volume <= 0) return null
  const candleReturnPct = pct(candle.close, candle.open)
  const volumeRatio = candle.volume / prior30Average
  const sweepSharePct = 100 * event.volumeDelta / candle.volume
  if (sweepSharePct < 20 || sweepSharePct > 90 || event.bidSharePct > 20) return null

  const strictDepthFailure = event.priceDropPct <= -0.05 && event.bidCollapsePct >= 60 &&
    event.bidSharePct <= 20 && candleReturnPct <= -0.03 && volumeRatio >= 1.25
  if (strictDepthFailure) return {
    name: "strict_depth_failure", requiredDeclinePct: -0.15,
    candleReturnPct, volumeRatio, sweepSharePct,
  }

  const strongCandleFailure = event.priceDropPct <= -0.04 && event.bidCollapsePct >= 50 &&
    event.bidSharePct <= 35 && candleReturnPct <= -0.09 && volumeRatio >= 2
  return strongCandleFailure ? {
    name: "strong_candle_volume_failure", requiredDeclinePct: -0.20,
    candleReturnPct, volumeRatio, sweepSharePct,
  } : null
}

export function createFailedBidAbsorptionRadar({
  onUpdate = () => {}, initialSignals = [], now = () => Date.now(),
} = {}) {
  const candlesByStock = new Map()
  const booksByStock = new Map()
  const depthByStock = new Map()
  const rawSweepsByStock = new Map()
  const candidatesByStock = new Map()
  const lastSignalByStock = new Map()
  const signals = initialSignals.slice()
  const signalIds = new Set(signals.map((signal) => signal.id))
  let sessionDate = indiaDate(now())

  for (const signal of signals) {
    const at = Date.parse(signal.time)
    if (signal.symbol && Number.isFinite(at)) {
      lastSignalByStock.set(signal.symbol, Math.max(lastSignalByStock.get(signal.symbol) || 0, at))
    }
  }

  function snapshot() { return signals.slice().reverse() }
  function publish() { onUpdate(snapshot(), sessionDate) }

  function resetDay(date) {
    sessionDate = date
    candlesByStock.clear()
    booksByStock.clear()
    depthByStock.clear()
    rawSweepsByStock.clear()
    candidatesByStock.clear()
    lastSignalByStock.clear()
    signals.length = 0
    signalIds.clear()
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
        const current = rows.map(normalizeCandle).filter((row) => row &&
          indiaDate(row.time * 1000) === sessionDate && row.time * 1000 + MINUTE <= completedBefore)
        candlesByStock.set(symbol, current.slice(-MAX_CANDLES))
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

    let changed = false
    for (const signal of signals) {
      if (signal.symbol !== symbol || signal.status !== "Active" ||
          candle.time * 1000 <= Date.parse(signal.time)) continue
      if (candle.high >= signal.stop) signal.status = "Stopped"
      else if (candle.low <= signal.target) signal.status = "Target reached"
      else continue
      signal.resolvedAt = new Date(candle.time * 1000).toISOString()
      changed = true
    }
    if (changed) publish()
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

    let state = booksByStock.get(symbol)
    if (!state || at - state.lastAt > 90_000) state = { fields: {}, book: null, lastAt: at, price: NaN, volume: NaN }
    for (const [key, value] of update) state.fields[key] = value
    const previous = state.book && Number.isFinite(state.price) && Number.isFinite(state.volume)
      ? { at: state.lastAt, book: state.book, price: state.price, volume: state.volume } : null
    const book = bookMetrics(state.fields)
    if (!book) return
    const contextPrice = Number(marketContext?.price)
    const contextVolume = Number(marketContext?.cumulativeVolume)
    const price = Number.isFinite(contextPrice) && contextPrice > 0 ? contextPrice : (book.bid + book.ask) / 2
    const volume = Number.isFinite(contextVolume) && contextVolume >= 0 ? contextVolume : NaN
    state.book = book
    state.lastAt = at
    state.price = price
    state.volume = volume
    booksByStock.set(symbol, state)

    const minute = Math.floor(at / MINUTE) * MINUTE
    let depth = depthByStock.get(symbol)
    if (!depth) depth = new Map()
    const bucket = depth.get(minute) || { count: 0, bidShareTotal: 0, firstPrice: price, lastPrice: price }
    bucket.count++
    bucket.bidShareTotal += book.bidSharePct
    bucket.lastPrice = price
    depth.set(minute, bucket)
    for (const key of depth.keys()) if (key < minute - 12 * MINUTE) depth.delete(key)
    depthByStock.set(symbol, depth)

    if (previous && at - previous.at > 0 && at - previous.at <= 15_000 &&
        Number.isFinite(volume) && volume >= previous.volume) {
      const priceDropPct = pct(price, previous.price)
      const bidCollapsePct = 100 * (1 - book.bidSize / previous.book.bidSize)
      const volumeDelta = volume - previous.volume
      if (priceDropPct <= -0.04 && bidCollapsePct >= 50 && book.bidSharePct <= 35 && volumeDelta > 0) {
        const event = { at, minute, price, priceDropPct, bidCollapsePct,
          bidSharePct: book.bidSharePct, volumeDelta }
        const sweeps = rawSweepsByStock.get(symbol) || []
        sweeps.push(event)
        rawSweepsByStock.set(symbol, sweeps.filter((item) => item.minute >= minute - 2 * MINUTE).slice(-40))
      }
    }
  }

  function observePrice(data, receivedAt) {
    if (!data || typeof data.symbol !== "string") return
    const symbol = toStockName(data.symbol)
    const at = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    const price = Number(data.ltp)
    if (!symbol || !Number.isFinite(at) || !Number.isFinite(price) || price <= 0) return
    let changed = false
    for (const signal of signals) {
      if (signal.symbol !== symbol || signal.status !== "Active" || at <= Date.parse(signal.time)) continue
      if (price >= signal.stop) signal.status = "Stopped"
      else if (price <= signal.target) signal.status = "Target reached"
      else continue
      signal.resolvedAt = new Date(at).toISOString()
      changed = true
    }
    if (changed) publish()
  }

  function finalizeSweepMinute(symbol, completedMinute) {
    const sweeps = rawSweepsByStock.get(symbol) || []
    const current = sweeps.filter((event) => event.minute <= completedMinute)
    if (!current.length) return
    const rows = (candlesByStock.get(symbol) || []).filter((row) =>
      indiaDate(row.time * 1000) === sessionDate && row.time * 1000 <= completedMinute)
    const candidates = candidatesByStock.get(symbol) || []
    const pending = sweeps.filter((event) => event.minute > completedMinute)
    for (const event of current) {
      const candle = rows.find((row) => row.time * 1000 === event.minute)
      const prior = rows.filter((row) => row.time * 1000 < event.minute).slice(-30)
      if (!candle || prior.length < 20) {
        if (completedMinute - event.minute < 2 * MINUTE) pending.push(event)
        continue
      }
      const prior30Average = sum(prior.map((row) => row.volume)) / prior.length
      const branch = branchFor(event, candle, prior30Average)
      if (branch) candidates.push({ ...event, ...branch, matches: [], lastEvaluated: -Infinity })
    }
    candidatesByStock.set(symbol, candidates.slice(-30))
    rawSweepsByStock.set(symbol, pending)
  }

  function emitSignal(symbol, candidate, signalMinute, at) {
    const lastSignalAt = lastSignalByStock.get(symbol) || -Infinity
    if (signalMinute - lastSignalAt < COOLDOWN_MS) return false
    const quote = booksByStock.get(symbol)
    const entry = quote?.book?.bid
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(quote.lastAt) ||
        quote.lastAt < signalMinute || at - quote.lastAt > 5_000) return false
    const id = `${symbol}:${Math.floor(signalMinute / 1000)}:failed-bid-absorption`
    if (signalIds.has(id)) return false
    const qualityMetrics = {
      priceDropPct: candidate.priceDropPct,
      volumeRatio: candidate.volumeRatio,
      confirmationBidSharePct: candidate.matches.at(-1).bidSharePct,
    }
    if (!passesFailedBidQuality(qualityMetrics)) return false
    const signal = {
      id, strategy: "Failed Bid Absorption", symbol, direction: "SELL",
      pattern: candidate.name === "strict_depth_failure"
        ? "Depth collapse followed by failed bid support"
        : "High-volume red candle followed by failed bid support",
      time: new Date(at).toISOString(), price: entry,
      stop: entry * (1 + STOP_PCT / 100), target: entry * (1 - TARGET_PCT / 100),
      status: "Active",
      metrics: {
        filterBranch: candidate.name, sweepTime: new Date(candidate.at).toISOString(),
        priceDropPct: candidate.priceDropPct, bidCollapsePct: candidate.bidCollapsePct,
        postSweepBidSharePct: candidate.bidSharePct, candleReturnPct: candidate.candleReturnPct,
        volumeRatio: candidate.volumeRatio, sweepSharePct: candidate.sweepSharePct,
        failedBidMinutes: candidate.matches.length,
        confirmationBidSharePct: candidate.matches.at(-1).bidSharePct,
        confirmationDeclinePct: candidate.matches.at(-1).declinePct,
      },
    }
    signals.push(signal)
    signalIds.add(id)
    lastSignalByStock.set(symbol, signalMinute)
    publish()
    return true
  }

  function evaluateCandidates(symbol, completedMinute, signalMinute, at) {
    const depth = depthByStock.get(symbol)
    const bucket = depth?.get(completedMinute)
    const rows = candlesByStock.get(symbol) || []
    const candleMap = new Map(rows.map((row) => [row.time * 1000, row]))
    const candle = candleMap.get(completedMinute)
    const candidates = candidatesByStock.get(symbol) || []
    let emitted = false
    for (const candidate of candidates) {
      if (emitted || candidate.lastEvaluated >= completedMinute ||
          completedMinute <= candidate.minute || completedMinute > candidate.minute + 7 * MINUTE) continue
      candidate.lastEvaluated = completedMinute
      if (!bucket || bucket.count < 5 || !candle) continue
      const bidSharePct = bucket.bidShareTotal / bucket.count
      const declinePct = pct(candle.close, candidate.price)
      if (bidSharePct >= 55 && declinePct <= candidate.requiredDeclinePct) {
        candidate.matches.push({ minute: completedMinute, bidSharePct, declinePct })
      }
      if (candidate.matches.length < 3) continue
      const latestThree = [completedMinute - 2 * MINUTE, completedMinute - MINUTE, completedMinute]
        .map((minute) => candleMap.get(minute))
      if (!latestThree.every(Boolean)) continue
      const return3Pct = pct(latestThree.at(-1).close, latestThree[0].open)
      const redCandles3 = latestThree.filter((row) => row.close < row.open).length
      if (return3Pct > -0.10 || redCandles3 < 2) continue
      candidate.return3Pct = return3Pct
      candidate.redCandles3 = redCandles3
      emitted = emitSignal(symbol, candidate, signalMinute, at)
    }
    candidatesByStock.set(symbol, emitted ? [] : candidates.filter((candidate) =>
      completedMinute <= candidate.minute + 7 * MINUTE))
  }

  function flushCompleted(timestamp = now()) {
    const at = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp)
    if (!Number.isFinite(at)) return
    const date = indiaDate(at)
    if (date > sessionDate) resetDay(date)
    const signalMinute = Math.floor((at - EVALUATION_DELAY_MS) / MINUTE) * MINUTE
    const completedMinute = signalMinute - MINUTE
    const symbols = new Set([...rawSweepsByStock.keys(), ...candidatesByStock.keys()])
    for (const symbol of symbols) {
      finalizeSweepMinute(symbol, completedMinute)
      evaluateCandidates(symbol, completedMinute, signalMinute, at)
    }
  }

  function resetLiveState() {
    booksByStock.clear()
    depthByStock.clear()
    rawSweepsByStock.clear()
    candidatesByStock.clear()
  }

  return { seed, observeCandle, observeDepth, observePrice, flushCompleted, resetLiveState, snapshot }
}
