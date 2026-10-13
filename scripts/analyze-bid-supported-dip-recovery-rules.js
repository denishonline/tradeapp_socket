import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const root = path.resolve(import.meta.dirname, "..")
const days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]
const minute = 60_000
const istOffset = 330 * minute
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const indiaDate = (at) => new Date(at + istOffset).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + istOffset).toISOString().slice(11, 16)

function parseLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function ema(values, period) {
  if (values.length < period) return NaN
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  for (const value of values.slice(period)) current += (value - current) * 2 / (period + 1)
  return current
}

function rsi14(rows) {
  if (rows.length < 15) return NaN
  const closes = rows.slice(-15).map((row) => row.close)
  let gains = 0, losses = 0
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) gains += change
    else losses -= change
  }
  return losses ? 100 - 100 / (1 + gains / losses) : 100
}

function mfi14(rows) {
  if (rows.length < 15) return NaN
  const selected = rows.slice(-15)
  let positive = 0, negative = 0
  for (let i = 1; i < selected.length; i++) {
    const priorTypical = (selected[i - 1].high + selected[i - 1].low + selected[i - 1].close) / 3
    const typical = (selected[i].high + selected[i].low + selected[i].close) / 3
    const flow = typical * selected[i].volume
    if (typical > priorTypical) positive += flow
    else if (typical < priorTypical) negative += flow
  }
  if (!negative) return 100
  return 100 - 100 / (1 + positive / negative)
}

function windowMetrics(rows, length) {
  const selected = rows.slice(-length)
  if (selected.length !== length) return null
  const volume = selected.reduce((sum, row) => sum + row.volume, 0)
  const greenVolume = selected.filter((row) => row.close > row.open)
    .reduce((sum, row) => sum + row.volume, 0)
  const redVolume = selected.filter((row) => row.close < row.open)
    .reduce((sum, row) => sum + row.volume, 0)
  const vwap = volume ? selected.reduce((sum, row) =>
    sum + row.volume * (row.high + row.low + row.close) / 3, 0) / volume : NaN
  return { returnPct: pct(selected.at(-1).close, selected[0].open),
    greenVolumePct: volume ? 100 * greenVolume / volume : NaN,
    redVolumePct: volume ? 100 * redVolume / volume : NaN,
    vwapGapPct: pct(selected.at(-1).close, vwap) }
}

function candleFeatures(symbol, day, candles, index) {
  const seen = candles.slice(0, index + 1)
  const current = seen.at(-1)
  const w3 = windowMetrics(seen, 3)
  const w5 = windowMetrics(seen, 5)
  const w10 = windowMetrics(seen, 10)
  const w15 = windowMetrics(seen, 15)
  if (!w15) return null
  const last15 = seen.slice(-15)
  if (last15.some((row, i) => i && row.at !== last15[i - 1].at + minute)) return null
  const closes = seen.map((row) => row.close)
  const ema3 = ema(closes, 3)
  const ema8 = ema(closes, 8)
  return { symbol, day, at: current.at, time: indiaTime(current.at + minute),
    returnOpen: pct(current.close, candles[0].open), return3: w3.returnPct,
    return5: w5.returnPct, return10: w10.returnPct, return15: w15.returnPct,
    rsi14: rsi14(seen), mfi14: mfi14(seen), vwapGap5: w5.vwapGapPct,
    vwapGap15: w15.vwapGapPct, greenVolume5: w5.greenVolumePct,
    greenVolume10: w10.greenVolumePct, redVolume5: w5.redVolumePct,
    redVolume10: w10.redVolumePct, ema3Gap8: pct(ema3, ema8),
    recoveryLow: pct(current.close, Math.min(...seen.map((row) => row.low))),
    pullbackHigh: pct(Math.max(...seen.map((row) => row.high)), current.close) }
}

function baselineCandle(row, side) {
  if (side === "BUY") return row.returnOpen >= -0.80 && row.returnOpen <= -0.15 &&
    row.return5 >= -0.20 && row.return5 <= 0.25 && row.rsi14 >= 33 && row.rsi14 <= 46 &&
    row.vwapGap15 >= -0.45 && row.vwapGap15 <= 0.30 && row.greenVolume5 >= 55 &&
    row.recoveryLow >= 0.45 && row.recoveryLow <= 1.10 &&
    row.pullbackHigh >= 0.75 && row.pullbackHigh <= 1.70
  return row.returnOpen >= 0.15 && row.returnOpen <= 0.80 &&
    row.return5 >= -0.25 && row.return5 <= 0.20 && row.rsi14 >= 54 && row.rsi14 <= 67 &&
    row.vwapGap15 >= -0.30 && row.vwapGap15 <= 0.45 && row.redVolume5 >= 55 &&
    row.pullbackHigh >= 0.45 && row.pullbackHigh <= 1.10 &&
    row.recoveryLow >= 0.75 && row.recoveryLow <= 1.70
}

function originalCandle(row, side) {
  if (side === "BUY") return row.returnOpen >= -0.60 && row.returnOpen <= -0.25 &&
    row.return5 >= -0.15 && row.return5 <= 0.15 && row.rsi14 >= 35 && row.rsi14 <= 42 &&
    row.vwapGap15 >= -0.45 && row.vwapGap15 <= 0.30 && row.greenVolume5 >= 55 &&
    row.recoveryLow >= 0.55 && row.recoveryLow <= 0.80 &&
    row.pullbackHigh >= 0.85 && row.pullbackHigh <= 1.70
  return row.returnOpen >= 0.25 && row.returnOpen <= 0.60 &&
    row.return5 >= -0.15 && row.return5 <= 0.15 && row.rsi14 >= 58 && row.rsi14 <= 65 &&
    row.vwapGap15 >= -0.30 && row.vwapGap15 <= 0.45 && row.redVolume5 >= 55 &&
    row.pullbackHigh >= 0.55 && row.pullbackHigh <= 0.80 &&
    row.recoveryLow >= 0.85 && row.recoveryLow <= 1.70
}

function broadCandle(row, side) {
  if (side === "BUY") return row.returnOpen >= -1.20 && row.returnOpen <= -0.05 &&
    row.return5 >= -0.35 && row.return5 <= 0.40 && row.rsi14 >= 28 && row.rsi14 <= 52 &&
    row.vwapGap15 >= -0.65 && row.vwapGap15 <= 0.45 && row.greenVolume5 >= 48 &&
    row.recoveryLow >= 0.30 && row.recoveryLow <= 1.45 &&
    row.pullbackHigh >= 0.55 && row.pullbackHigh <= 2.10
  return row.returnOpen >= 0.05 && row.returnOpen <= 1.20 &&
    row.return5 >= -0.40 && row.return5 <= 0.35 && row.rsi14 >= 48 && row.rsi14 <= 72 &&
    row.vwapGap15 >= -0.45 && row.vwapGap15 <= 0.65 && row.redVolume5 >= 48 &&
    row.pullbackHigh >= 0.30 && row.pullbackHigh <= 1.45 &&
    row.recoveryLow >= 0.55 && row.recoveryLow <= 2.10
}

async function readDepthMinutes(symbol, day) {
  const file = path.join(root, "db", "cash-depth", day, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const fields = {}
  const buckets = new Map()
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    const at = Date.parse(row.receivedAt)
    if (!Number.isFinite(at)) continue
    const data = row.data || {}
    for (let level = 1; level <= 5; level++) {
      for (const side of ["bid", "ask"]) for (const field of ["price", "size"]) {
        const key = `${side}_${field}${level}`
        if (Number.isFinite(Number(data[key]))) fields[key] = Number(data[key])
      }
    }
    let bids = 0, asks = 0, topBids = 0, topAsks = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = fields[`bid_price${level}`], ap = fields[`ask_price${level}`]
      const bs = fields[`bid_size${level}`], as = fields[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) {
        valid = false
        break
      }
      bids += bs; asks += as
      if (level <= 2) { topBids += bs; topAsks += as }
    }
    if (!valid || bids + asks <= 0 || topBids + topAsks <= 0) continue
    const key = Math.floor(at / minute) * minute
    const bucket = buckets.get(key) || { count: 0, full: 0, top2: 0 }
    bucket.count++
    bucket.full += (bids - asks) / (bids + asks)
    bucket.top2 += (topBids - topAsks) / (topBids + topAsks)
    buckets.set(key, bucket)
  }
  return new Map([...buckets].map(([at, row]) => [at,
    { imbalance: row.full / row.count, top2: row.top2 / row.count, count: row.count }]))
}

function addDepth(row, depth) {
  const selected = [...depth.entries()].filter(([at]) => at >= row.at - 14 * minute && at <= row.at)
  const last3 = selected.slice(-3)
  row.depthMinutes = selected.length
  row.positiveDepth = selected.length ? 100 * selected.filter(([, item]) => item.imbalance > 0).length / selected.length : 0
  row.negativeDepth = selected.length ? 100 * selected.filter(([, item]) => item.imbalance < 0).length / selected.length : 0
  row.positiveTop2 = selected.length ? 100 * selected.filter(([, item]) => item.top2 > 0).length / selected.length : 0
  row.negativeTop2 = selected.length ? 100 * selected.filter(([, item]) => item.top2 < 0).length / selected.length : 0
  row.depthImbalance3 = last3.length ? last3.reduce((sum, [, item]) => sum + item.imbalance, 0) / last3.length : 0
  return row
}

function confirmationScore(row, side) {
  if (side === "BUY") return [row.return3 >= -0.05,
    row.return3 - 0.60 * row.return5 >= 0, row.ema3Gap8 >= 0,
    row.vwapGap5 >= -0.05, row.greenVolume10 >= 50,
    row.mfi14 >= 35 && row.mfi14 <= 70, row.depthImbalance3 > 0]
  return [row.return3 <= 0.05,
    row.return3 - 0.60 * row.return5 <= 0, row.ema3Gap8 <= 0,
    row.vwapGap5 <= 0.05, row.redVolume10 >= 50,
    row.mfi14 >= 30 && row.mfi14 <= 65, row.depthImbalance3 < 0]
}

function depthPass(row, side, broad = false) {
  const share = side === "BUY" ? row.positiveDepth : row.negativeDepth
  return row.depthMinutes >= 10 && share >= (broad ? 55 : 60)
}

const candleRows = []
for (const file of fs.readdirSync(path.join(root, "db", "candles")).filter((name) => name.endsWith(".jsonl"))) {
  const symbol = path.basename(file, ".jsonl")
  const parsed = parseLines(path.join(root, "db", "candles", file)).map((row) => ({
    at: Number(row.time) * 1000, open: Number(row.open), high: Number(row.high),
    low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }))
    .filter((row) => [row.at, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite))
  for (const day of days) {
    const candles = parsed.filter((row) => indiaDate(row.at) === day).sort((a, b) => a.at - b.at)
    for (let i = 14; i < candles.length; i++) {
      const row = candleFeatures(symbol, day, candles, i)
    if (row && (["BUY", "SELL"].some((side) => originalCandle(row, side) || baselineCandle(row, side) || broadCandle(row, side)))) candleRows.push(row)
    }
  }
}

const pairs = [...new Set(candleRows.map((row) => `${row.day}|${row.symbol}`))]
const rowsByPair = new Map(pairs.map((pair) => [pair, []]))
for (const row of candleRows) rowsByPair.get(`${row.day}|${row.symbol}`).push(row)
for (let offset = 0; offset < pairs.length; offset += 8) {
  await Promise.all(pairs.slice(offset, offset + 8).map(async (pair) => {
    const [day, symbol] = pair.split("|")
    const depth = await readDepthMinutes(symbol, day)
    rowsByPair.get(pair).forEach((row) => addDepth(row, depth))
  }))
}

function uniqueSignals(side, kind, minimumScore = 0) {
  const selected = candleRows.filter((row) => {
    if (kind === "original") return originalCandle(row, side) && depthPass(row, side)
    if (kind === "baseline") return baselineCandle(row, side) && depthPass(row, side)
    return broadCandle(row, side) && depthPass(row, side, true) &&
      confirmationScore(row, side).filter(Boolean).length >= minimumScore
  }).sort((a, b) => a.at - b.at)
  const firstByStockDay = new Map()
  for (const row of selected) {
    const key = `${row.day}|${row.symbol}`
    if (!firstByStockDay.has(key)) firstByStockDay.set(key, row)
  }
  return [...firstByStockDay.values()]
}

function counts(signals) {
  return Object.fromEntries(days.map((day) => [day, signals.filter((row) => row.day === day).length]))
}

const variants = []
const baselines = Object.fromEntries(["BUY", "SELL"].map((side) => [side, uniqueSignals(side, "baseline")]))
const signalKeys = (signals, day) => new Set(signals.filter((row) => row.day === day)
  .map((row) => `${row.day}|${row.symbol}`))
for (const side of ["BUY", "SELL"]) {
  const original = uniqueSignals(side, "original")
  variants.push({ side, variant: "original", minimumScore: null, counts: counts(original), total: original.length })
  const baseline = baselines[side]
  variants.push({ side, variant: "baseline", minimumScore: null, counts: counts(baseline), total: baseline.length })
  const baseline9Keys = signalKeys(baseline, "2026-10-09")
  for (let score = 3; score <= 7; score++) {
    const signals = uniqueSignals(side, "broad", score)
    const candidate9Keys = signalKeys(signals, "2026-10-09")
    const retainedBaseline9 = [...baseline9Keys].filter((key) => candidate9Keys.has(key)).length
    variants.push({ side, variant: "broad", minimumScore: score, counts: counts(signals), total: signals.length,
      retainedBaseline9, filteredBaseline9: baseline9Keys.size - retainedBaseline9 })
  }
}

const buyBaseline = baselines.BUY
const baseline9 = buyBaseline.filter((row) => row.day === "2026-10-09").length
const eligibleBuyVariants = variants.filter((row) => row.side === "BUY" && row.variant === "broad" &&
  row.retainedBaseline9 >= Math.max(0, baseline9 - 2))
const chosenScore = eligibleBuyVariants.sort((a, b) => {
  return b.minimumScore - a.minimumScore
})[0]?.minimumScore ?? 4

const chosen = ["BUY", "SELL"].flatMap((side) => uniqueSignals(side, "broad", chosenScore)
  .map((row) => ({ day: row.day, time: row.time, symbol: row.symbol, side,
    confirmationScore: confirmationScore(row, side).filter(Boolean).length,
    returnOpen: round(row.returnOpen), return3: round(row.return3), return5: round(row.return5),
    return10: round(row.return10), return15: round(row.return15), rsi14: round(row.rsi14),
    mfi14: round(row.mfi14), vwapGap5: round(row.vwapGap5), vwapGap15: round(row.vwapGap15),
    directionVolume5: round(side === "BUY" ? row.greenVolume5 : row.redVolume5),
    directionVolume10: round(side === "BUY" ? row.greenVolume10 : row.redVolume10),
    recoveryLow: round(row.recoveryLow), pullbackHigh: round(row.pullbackHigh),
    directionalDepth: round(side === "BUY" ? row.positiveDepth : row.negativeDepth),
    directionalTop2: round(side === "BUY" ? row.positiveTop2 : row.negativeTop2),
    depthMinutes: row.depthMinutes, depthImbalance3: round(row.depthImbalance3) })))

const output = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-broadened-audit.csv")
const originalOutput = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-original-signals.csv")
const baselineOutput = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-baseline-signals.csv")
const score6Output = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-score6-signals.csv")
const eligibleOutput = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-eligible-signals.csv")
const columns = Object.keys(chosen[0] || { day: "", time: "", symbol: "", side: "" })
const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`
fs.writeFileSync(output, [columns.join(","), ...chosen.map((row) => columns.map((key) => escape(row[key])).join(","))].join("\n") + "\n")
const originalSignals = ["BUY", "SELL"].flatMap((side) => uniqueSignals(side, "original").map((row) => ({
  day: row.day, time: row.time, symbol: row.symbol, side,
  returnOpen: round(row.returnOpen), return3: round(row.return3), return5: round(row.return5),
  return10: round(row.return10), return15: round(row.return15), rsi14: round(row.rsi14),
  mfi14: round(row.mfi14), vwapGap5: round(row.vwapGap5), vwapGap15: round(row.vwapGap15),
  directionVolume5: round(side === "BUY" ? row.greenVolume5 : row.redVolume5),
  directionVolume10: round(side === "BUY" ? row.greenVolume10 : row.redVolume10),
  recoveryLow: round(row.recoveryLow), pullbackHigh: round(row.pullbackHigh),
  directionalDepth: round(side === "BUY" ? row.positiveDepth : row.negativeDepth),
  directionalTop2: round(side === "BUY" ? row.positiveTop2 : row.negativeTop2),
  depthMinutes: row.depthMinutes, depthImbalance3: round(row.depthImbalance3) })))
const originalColumns = Object.keys(originalSignals[0] || { day: "", time: "", symbol: "", side: "" })
fs.writeFileSync(originalOutput, [originalColumns.join(","), ...originalSignals.map((row) =>
  originalColumns.map((key) => escape(row[key])).join(","))].join("\n") + "\n")
const baselineSignals = ["BUY", "SELL"].flatMap((side) => baselines[side].map((row) => ({
  day: row.day, time: row.time, symbol: row.symbol, side,
  returnOpen: round(row.returnOpen), return3: round(row.return3), return5: round(row.return5),
  return10: round(row.return10), return15: round(row.return15), rsi14: round(row.rsi14),
  mfi14: round(row.mfi14), vwapGap5: round(row.vwapGap5), vwapGap15: round(row.vwapGap15),
  directionVolume5: round(side === "BUY" ? row.greenVolume5 : row.redVolume5),
  directionVolume10: round(side === "BUY" ? row.greenVolume10 : row.redVolume10),
  recoveryLow: round(row.recoveryLow), pullbackHigh: round(row.pullbackHigh),
  directionalDepth: round(side === "BUY" ? row.positiveDepth : row.negativeDepth),
  directionalTop2: round(side === "BUY" ? row.positiveTop2 : row.negativeTop2),
  depthMinutes: row.depthMinutes, depthImbalance3: round(row.depthImbalance3) })))
const baselineColumns = Object.keys(baselineSignals[0] || { day: "", time: "", symbol: "", side: "" })
fs.writeFileSync(baselineOutput, [baselineColumns.join(","), ...baselineSignals.map((row) =>
  baselineColumns.map((key) => escape(row[key])).join(","))].join("\n") + "\n")
const score6Signals = ["BUY", "SELL"].flatMap((side) => uniqueSignals(side, "broad", 6).map((row) => ({
  day: row.day, time: row.time, symbol: row.symbol, side,
  confirmationScore: confirmationScore(row, side).filter(Boolean).length,
  returnOpen: round(row.returnOpen), return3: round(row.return3), return5: round(row.return5),
  return10: round(row.return10), return15: round(row.return15), rsi14: round(row.rsi14),
  mfi14: round(row.mfi14), vwapGap5: round(row.vwapGap5), vwapGap15: round(row.vwapGap15),
  directionVolume5: round(side === "BUY" ? row.greenVolume5 : row.redVolume5),
  directionVolume10: round(side === "BUY" ? row.greenVolume10 : row.redVolume10),
  recoveryLow: round(row.recoveryLow), pullbackHigh: round(row.pullbackHigh),
  directionalDepth: round(side === "BUY" ? row.positiveDepth : row.negativeDepth),
  directionalTop2: round(side === "BUY" ? row.positiveTop2 : row.negativeTop2),
  depthMinutes: row.depthMinutes, depthImbalance3: round(row.depthImbalance3) })))
const score6Columns = Object.keys(score6Signals[0] || { day: "", time: "", symbol: "", side: "" })
fs.writeFileSync(score6Output, [score6Columns.join(","), ...score6Signals.map((row) =>
  score6Columns.map((key) => escape(row[key])).join(","))].join("\n") + "\n")
const eligibleSignals = ["BUY", "SELL"].flatMap((side) => uniqueSignals(side, "broad", 0).map((row) => ({
  day: row.day, time: row.time, symbol: row.symbol, side,
  confirmationScore: confirmationScore(row, side).filter(Boolean).length,
  returnOpen: round(row.returnOpen), return3: round(row.return3), return5: round(row.return5),
  return10: round(row.return10), return15: round(row.return15), rsi14: round(row.rsi14),
  mfi14: round(row.mfi14), vwapGap5: round(row.vwapGap5), vwapGap15: round(row.vwapGap15),
  directionVolume5: round(side === "BUY" ? row.greenVolume5 : row.redVolume5),
  directionVolume10: round(side === "BUY" ? row.greenVolume10 : row.redVolume10),
  recoveryLow: round(row.recoveryLow), pullbackHigh: round(row.pullbackHigh),
  directionalDepth: round(side === "BUY" ? row.positiveDepth : row.negativeDepth),
  directionalTop2: round(side === "BUY" ? row.positiveTop2 : row.negativeTop2),
  depthMinutes: row.depthMinutes, depthImbalance3: round(row.depthImbalance3) })))
const eligibleColumns = Object.keys(eligibleSignals[0] || { day: "", time: "", symbol: "", side: "" })
fs.writeFileSync(eligibleOutput, [eligibleColumns.join(","), ...eligibleSignals.map((row) =>
  eligibleColumns.map((key) => escape(row[key])).join(","))].join("\n") + "\n")

export const result = { output, originalOutput, baselineOutput, score6Output, eligibleOutput, candidateStockDays: pairs.length, variants, chosenScore,
  chosenCounts: Object.fromEntries(["BUY", "SELL"].map((side) => [side,
    counts(chosen.filter((row) => row.side === side))])), chosenSignals: chosen }

console.log(JSON.stringify({ ...result, chosenSignals: undefined }, null, 2))
