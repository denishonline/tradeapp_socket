import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { readdir } from "node:fs/promises"
import { DEPTH_LONG_ABSORPTION_RULE as rule, evaluateDepthLongAbsorption,
  confirmDepthLongAbsorption, evaluateStrictLongAbsorptionCandle,
  confirmStrictLongAbsorptionDepth, STRICT_LONG_ABSORPTION_RULE } from "../ui/depth-momentum.js"

const root = process.cwd()
const depthRoot = path.join(root, "db", "cash-depth")
const candleRoot = path.join(root, "db", "candles")
const dates = (await readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
  .map((entry) => entry.name).sort()
const date = process.argv[2] || dates.at(-1)
const useFinalFilters = !process.argv.includes("--unfiltered")
const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice("--mode=".length) || "ask_ofi"
const strictCandidateMode = !process.argv.includes("--broad") || process.argv.includes("--strict-candidate")
const immediateStrict = strictCandidateMode && !process.argv.includes("--confirm=delayed")
const breakoutOption = process.argv.find((argument) => argument.startsWith("--max-breakout="))
const return10Option = process.argv.find((argument) => argument.startsWith("--max-return10="))
const candleOverrides = {
  ...(breakoutOption ? { maximumBreakoutPct: Number(breakoutOption.split("=")[1]) } : {}),
  ...(return10Option ? { maximumReturn10Pct: Number(return10Option.split("=")[1]) } : {}),
}
if (Object.values(candleOverrides).some((value) => !Number.isFinite(value))) throw new Error("Invalid candle threshold")
if (!date || !dates.includes(date)) throw new Error(`No cash-depth archive for ${date || "the requested date"}`)

const sessionDate = (at) => new Date(at + 330 * 60_000).toISOString().slice(0, 10)
const timeLabel = (at) => new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(at))

async function* lines(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const reader = readline.createInterface({ input, crlfDelay: Infinity })
  try { for await (const line of reader) if (line.trim()) yield line }
  finally { reader.close(); input.destroy() }
}

function depthMetrics(book) {
  let bid = 0, ask = 0, nearBid = 0, nearAsk = 0, bidOrders = 0, askOrders = 0
  let previousBid = Infinity, previousAsk = 0
  let bestBid = 0, bestAsk = 0, bestBidSize = 0, bestAskSize = 0
  for (let level = 1; level <= 5; level++) {
    const bp = Number(book[`bid_price${level}`]), bq = Number(book[`bid_size${level}`])
    const ap = Number(book[`ask_price${level}`]), aq = Number(book[`ask_size${level}`])
    if (![bp, bq, ap, aq].every(Number.isFinite) || bp <= 0 || ap <= 0 || bq < 0 || aq < 0 ||
        bp > previousBid || ap < previousAsk || (level === 1 && bp >= ap)) return null
    previousBid = bp
    previousAsk = ap
    if (level === 1) { bestBid = bp; bestAsk = ap; bestBidSize = bq; bestAskSize = aq }
    bid += bq
    ask += aq
    bidOrders += Number(book[`bid_order${level}`]) || 0
    askOrders += Number(book[`ask_order${level}`]) || 0
    if (level <= 2) { nearBid += bq; nearAsk += aq }
  }
  if (bid + ask === 0) return null
  return {
    imbalance: (bid - ask) / (bid + ask), nearImbalance: (nearBid - nearAsk) / (nearBid + nearAsk || 1),
    orderImbalance: (bidOrders - askOrders) / (bidOrders + askOrders || 1),
    spreadPct: (bestAsk / bestBid - 1) * 100,
    bestLevelImbalance: (bestBidSize - bestAskSize) / (bestBidSize + bestAskSize || 1),
    mid: (bestBid + bestAsk) / 2,
    bestBid, bestAsk, bestBidSize, bestAskSize,
    bid, ask, nearBid, nearAsk,
  }
}

async function readDepth(filename) {
  const byMinute = new Map(), fields = {}
  let lastAt = 0
  let previousBook = null
  for await (const line of lines(filename)) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || sessionDate(at) !== date) continue
    if (lastAt && at - lastAt > 90_000) {
      for (const key of Object.keys(fields)) delete fields[key]
      previousBook = null
    }
    lastAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    const metrics = depthMetrics(fields)
    const priceAt = Date.parse(record.marketContext?.priceAt)
    const marketAt = Number.isFinite(priceAt) ? priceAt : at
    if (!metrics || sessionDate(marketAt) !== date) continue
    const ofi = previousBook
      ? (metrics.bestBid >= previousBook.bestBid ? metrics.bestBidSize : 0) -
        (metrics.bestBid <= previousBook.bestBid ? previousBook.bestBidSize : 0) -
        (metrics.bestAsk <= previousBook.bestAsk ? metrics.bestAskSize : 0) +
        (metrics.bestAsk >= previousBook.bestAsk ? previousBook.bestAskSize : 0)
      : 0
    const ofiDepth = previousBook
      ? (metrics.bestBidSize + metrics.bestAskSize + previousBook.bestBidSize + previousBook.bestAskSize) / 2
      : 0
    previousBook = metrics
    const minute = Math.floor(marketAt / 60_000)
    const bucket = byMinute.get(minute) || { minute, count: 0, imbalance: 0, nearImbalance: 0,
      orderImbalance: 0, spreadPct: 0, bestLevelImbalance: 0, bid: 0, ask: 0,
      bidSupportedCount: 0, askAbsorptionCount: 0, ofi: 0, ofiDepth: 0,
      firstMid: metrics.mid, lastMid: metrics.mid,
      firstVolume: Number(record.marketContext?.cumulativeVolume), lastVolume: Number(record.marketContext?.cumulativeVolume) }
    bucket.count++
    bucket.imbalance += metrics.imbalance
    bucket.nearImbalance += metrics.nearImbalance
    bucket.orderImbalance += metrics.orderImbalance
    bucket.spreadPct += metrics.spreadPct
    bucket.bestLevelImbalance += metrics.bestLevelImbalance
    bucket.bid += metrics.bid
    bucket.ask += metrics.ask
    bucket.ofi += ofi
    bucket.ofiDepth += ofiDepth
    if (metrics.imbalance >= 0.15 && metrics.nearImbalance >= 0.15) bucket.bidSupportedCount++
    if (metrics.imbalance <= rule.maximumSupportedDepthImbalance &&
        metrics.nearImbalance <= rule.maximumAbsorptionTop2Imbalance) bucket.askAbsorptionCount++
    bucket.lastMid = metrics.mid
    bucket.lastVolume = Number(record.marketContext?.cumulativeVolume)
    byMinute.set(minute, bucket)
  }
  for (const bucket of byMinute.values()) {
    bucket.imbalance /= bucket.count
    bucket.nearImbalance /= bucket.count
    bucket.orderImbalance /= bucket.count
    bucket.spreadPct /= bucket.count
    bucket.bestLevelImbalance /= bucket.count
    bucket.bid /= bucket.count
    bucket.ask /= bucket.count
    bucket.ofiNormalized = bucket.ofiDepth > 0 ? bucket.ofi / bucket.ofiDepth : 0
  }
  return byMinute
}

async function readCandles(symbol) {
  const filename = path.join(candleRoot, `${symbol}.jsonl`)
  const byMinute = new Map()
  if (!fs.existsSync(filename)) return []
  for await (const line of lines(filename)) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    const time = Math.floor(Number(row.time) / 60) * 60
    if (!Number.isFinite(time) || sessionDate(time * 1000) !== date) continue
    const candle = { time, open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume) }
    if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) continue
    byMinute.set(time, candle)
  }
  return [...byMinute.values()].sort((a, b) => a.time - b.time)
}

const stockDirs = (await readdir(path.join(depthRoot, date), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
const signals = []
let candidates = 0
for (const dir of stockDirs) {
  const symbol = dir.name
  const depthFile = path.join(depthRoot, date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(depthFile)) continue
  const [depth, candles] = await Promise.all([readDepth(depthFile), readCandles(symbol)])
  let pending = null, active = null, lastSignalMinute = -Infinity
  for (let index = 0; index < candles.length; index++) {
    const current = candles[index]
    const currentMinute = Math.floor(current.time / 60)
    let canCreateCandidate = !pending
    if (active && current.time > active.candleTime) {
      const stopHit = current.low <= active.stop
      const targetHit = current.high >= active.target
      if (stopHit || targetHit) {
        active.outcome = stopHit ? "Stopped" : "Target reached"
        active.outcomeAt = timeLabel((current.time + 60) * 1000)
        active = null
      }
    }

    if (immediateStrict) {
      const features = evaluateStrictLongAbsorptionCandle(current,
        candles.slice(index - STRICT_LONG_ABSORPTION_RULE.lookbackCandles, index), candleOverrides)
      if (!features) continue
      candidates++
      const window = [currentMinute - 2, currentMinute - 1, currentMinute]
        .map((minute) => depth.get(minute))
      if (active || currentMinute - lastSignalMinute < rule.cooldownMinutes || window.some((row) => !row)) continue
      const confirmation = confirmStrictLongAbsorptionDepth(window)
      if (!confirmation) continue
      const signal = { symbol, candidateAt: timeLabel((current.time + 60) * 1000),
        signalAt: timeLabel((current.time + 60) * 1000), price: current.close,
        pattern: "Ask absorption", ...features,
        ...confirmation,
        stop: current.close * (1 - rule.stopPct / 100),
        target: current.close * (1 + rule.targetPct / 100),
        candleTime: current.time, outcome: "Unresolved" }
      signals.push(signal)
      active = signal
      lastSignalMinute = currentMinute
      continue
    }

    if (pending) {
      const age = currentMinute - pending.candidateMinute
      if (age > rule.confirmationMaxDelayMinutes) {
        pending = null
        canCreateCandidate = true
      }
      else if (age === rule.confirmationMaxDelayMinutes) {
        const window = Array.from({ length: rule.depthMinutes }, (_, offset) => depth.get(pending.candidateMinute + offset))
        if (window.every(Boolean)) {
          const depthImbalance = window.reduce((sum, row) => sum + row.imbalance, 0) / window.length
          const top2Imbalance = window.reduce((sum, row) => sum + row.nearImbalance, 0) / window.length
          const driftPct = (current.close / pending.price - 1) * 100
          const orderImbalance = window.reduce((sum, row) => sum + row.orderImbalance, 0) / window.length
          const bestLevelImbalance = window.reduce((sum, row) => sum + row.bestLevelImbalance, 0) / window.length
          const orderFlowImbalance = window.reduce((sum, row) => sum + row.ofi, 0) /
            (window.reduce((sum, row) => sum + row.ofiDepth, 0) || 1)
          const askPersistence = window.reduce((sum, row) => sum + row.askAbsorptionCount, 0) /
            window.reduce((sum, row) => sum + row.count, 0)
          const basicBidSupported = depthImbalance >= 0.15 && top2Imbalance >= 0.15
          const basicAskAbsorption = mode === "strict_basic"
            ? depthImbalance <= 0 && top2Imbalance <= -0.3
            : depthImbalance <= rule.maximumSupportedDepthImbalance &&
              top2Imbalance <= rule.maximumAbsorptionTop2Imbalance
          const orderTrend = pending.features.return30Pct <= 0.3 &&
            pending.features.trendEfficiency20 >= 0.2 && orderImbalance > 0
          const flowBid = pending.features.trendEfficiency20 >= rule.minimumBidTrendEfficiency20 &&
            bestLevelImbalance > rule.minimumBidQueueImbalance &&
            orderFlowImbalance >= rule.minimumBidOrderFlowImbalance
          const flowAsk = pending.features.checks.emaBullish && orderImbalance > rule.minimumAbsorptionOrderImbalance &&
            askPersistence >= rule.minimumAbsorptionPersistence
          const bidSupported = !["ask_only", "ask_ofi", "ask_ofi_strong", "strict_basic", "strict_flow"].includes(mode) &&
            basicBidSupported && (!useFinalFilters ||
            (mode === "order_trend" ? orderTrend :
              mode === "combined_trend" ? orderTrend && flowBid :
                mode === "flow_only" ? bestLevelImbalance > 0 && orderFlowImbalance >= 0.03 : flowBid))
          const sharedConfirmation = mode === "ask_ofi" && useFinalFilters
            ? confirmDepthLongAbsorption(pending.features, window, pending.price, current.close)
            : null
          const askAbsorption = mode !== "bid_only" && basicAskAbsorption && (!useFinalFilters ||
            (mode === "order_trend" ? orderTrend :
              mode === "combined_trend" ? orderTrend && flowAsk :
                mode === "flow_only" ? orderImbalance > 0 && askPersistence >= 0.5 :
                  mode === "strict_basic" ? true :
                    mode === "strict_flow" ? orderImbalance > 0 && askPersistence >= 0.5 && orderFlowImbalance > 0 :
                  mode === "ask_ofi" ? Boolean(sharedConfirmation) :
                    mode === "ask_ofi_strong" ? flowAsk && orderFlowImbalance >= 0.03 : flowAsk))
          if ((bidSupported || askAbsorption) && driftPct >= 0 && driftPct <= rule.maximumCandidateDriftPct &&
              currentMinute - lastSignalMinute >= rule.cooldownMinutes && !active) {
            const signal = {
              symbol,
              candidateAt: timeLabel((pending.candidateMinute + 1) * 60_000),
              signalAt: timeLabel((current.time + 60) * 1000),
              price: current.close,
              pattern: bidSupported ? "Bid supported" : "Ask absorption",
              candleScore: pending.features.candleScore,
              driftPct,
              confirmVolumeMultiple20: current.volume / (pending.features.avgPrior20Volume || 1),
              confirm3VolumeMultiple20: candles.slice(index - 2, index + 1)
                .reduce((sum, row) => sum + row.volume, 0) / (3 * (pending.features.avgPrior20Volume || 1)),
              confirmCloseLocation: (current.close - current.low) / (current.high - current.low || 1),
              confirmAbovePrior20High: current.close > pending.features.prior20High,
              depthImbalance: Number(depthImbalance.toFixed(3)),
              top2Imbalance: Number(top2Imbalance.toFixed(3)),
              depthFullStart: window[0].imbalance,
              depthFullEnd: window[2].imbalance,
              depthTop2Start: window[0].nearImbalance,
              depthTop2End: window[2].nearImbalance,
              orderImbalance,
              spreadPct: window.reduce((sum, row) => sum + row.spreadPct, 0) / window.length,
              bestLevelImbalance,
              bidSupportedFraction: window.reduce((sum, row) => sum + row.bidSupportedCount, 0) /
                window.reduce((sum, row) => sum + row.count, 0),
              askAbsorptionFraction: window.reduce((sum, row) => sum + row.askAbsorptionCount, 0) /
                window.reduce((sum, row) => sum + row.count, 0),
              bookVolumeChangePct: (window[2].bid + window[2].ask) / (window[0].bid + window[0].ask) * 100 - 100,
              bidVolumeChangePct: window[2].bid / window[0].bid * 100 - 100,
              askVolumeChangePct: window[2].ask / window[0].ask * 100 - 100,
              midReturnPct: (window[2].lastMid / window[0].firstMid - 1) * 100,
              ofiNormalized: window.reduce((sum, row) => sum + row.ofi, 0) /
                (window.reduce((sum, row) => sum + row.ofiDepth, 0) || 1),
              ofiPositiveMinutes: window.filter((row) => row.ofiNormalized > 0).length,
              cumulativeVolume: window[2].lastVolume - window[0].firstVolume,
              minDepthSamples: Math.min(...window.map((row) => row.count)),
              indicators: pending.features,
              stop: current.close * (1 - rule.stopPct / 100),
              target: current.close * (1 + rule.targetPct / 100),
              candleTime: current.time,
              outcome: "Unresolved",
            }
            signals.push(signal)
            active = signal
            lastSignalMinute = currentMinute
          }
        }
        pending = null
      }
    }

    if (canCreateCandidate && !pending && !active && currentMinute - lastSignalMinute >= rule.cooldownMinutes &&
        index >= (strictCandidateMode ? 30 : rule.lookbackCandles)) {
      const features = strictCandidateMode ? evaluateStrictLongAbsorptionCandle(current,
        candles.slice(index - STRICT_LONG_ABSORPTION_RULE.lookbackCandles, index), candleOverrides) :
        evaluateDepthLongAbsorption(current, candles.slice(0, index))
      if (features) {
        pending = { candidateMinute: currentMinute, price: current.close, features }
        candidates++
      }
    }
  }
}

signals.sort((a, b) => a.signalAt.localeCompare(b.signalAt) || a.symbol.localeCompare(b.symbol))
const outcomes = signals.reduce((result, signal) => {
  result[signal.outcome] = (result[signal.outcome] || 0) + 1
  return result
}, {})
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ date, stocks: stockDirs.length, candidates, signals }))
  process.exit(0)
}
console.log(`Staged candle + depth replay | ${date} | ${stockDirs.length} stocks`)
console.log(`Candle candidates: ${candidates} | confirmed signals: ${signals.length} | outcomes: ${JSON.stringify(outcomes)}`)
if (!process.argv.includes("--summary")) console.table(signals.map(({ symbol, candidateAt, signalAt, price, pattern, outcome, outcomeAt }) => ({
  symbol, candidateAt, signalAt, price, pattern, outcome, outcomeAt,
})).filter((row) => !process.argv.includes("--targets") || row.outcome === "Target reached"))
