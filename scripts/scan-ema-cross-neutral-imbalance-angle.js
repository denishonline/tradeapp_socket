import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const ROOT = process.cwd()
const DATE = process.argv[2] || "2026-10-14"
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const TREND_CANDLES = 15
const DEPTH_MINUTES = 3
const MAX_ABS_IMBALANCE_PCT = 20
const MIN_TREND_ANGLE_DEG = 90
const candleRoot = path.join(ROOT, "db", "candles")
const depthRoot = path.join(ROOT, "db", "cash-depth", DATE)

const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 19)
const mean = (values) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length : NaN
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

async function* records(filename) {
  const input = fs.createReadStream(filename, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      try { yield JSON.parse(line) } catch { /* Ignore an incomplete final record. */ }
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

function regressionSlope(values) {
  const count = values.length
  if (count < 2) return NaN
  const sumX = count * (count - 1) / 2
  const sumY = values.reduce((total, value) => total + value, 0)
  const sumXX = (count - 1) * count * (2 * count - 1) / 6
  const sumXY = values.reduce((total, value, index) => total + index * value, 0)
  const denominator = count * sumXX - sumX * sumX
  return denominator ? (count * sumXY - sumX * sumY) / denominator : NaN
}

function atr14(rows, index) {
  if (index < 14) return NaN
  const ranges = []
  for (let cursor = index - 13; cursor <= index; cursor++) {
    const row = rows[cursor]
    const previousClose = rows[cursor - 1].close
    ranges.push(Math.max(row.high - row.low, Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose)))
  }
  return mean(ranges)
}

function trendAngle(rows, index) {
  const before = rows.slice(index - TREND_CANDLES + 1, index + 1)
  const after = rows.slice(index, index + TREND_CANDLES)
  if (before.length !== TREND_CANDLES || after.length !== TREND_CANDLES) return null
  if (before.some((row, cursor) => cursor && row.at !== before[cursor - 1].at + MINUTE) ||
      after.some((row, cursor) => cursor && row.at !== after[cursor - 1].at + MINUTE)) return null
  const atr = atr14(rows, index)
  if (!(atr > 0)) return null
  const beforeSlope = regressionSlope(before.map((row) => row.close))
  const afterSlope = regressionSlope(after.map((row) => row.close))
  const scale = (TREND_CANDLES - 1) / atr
  const beforeHeading = Math.atan(beforeSlope * scale) * 180 / Math.PI
  const afterHeading = Math.atan(afterSlope * scale) * 180 / Math.PI
  return {
    angle: Math.abs(afterHeading - beforeHeading),
    beforeHeading,
    afterHeading,
    beforeSlopeAtr: beforeSlope * scale,
    afterSlopeAtr: afterSlope * scale,
  }
}

function loadCandles(symbol) {
  const rows = fs.readFileSync(path.join(candleRoot, `${symbol}.jsonl`), "utf8")
    .split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try {
        const row = JSON.parse(line)
        const candle = { at: Number(row.time) * 1000, open: Number(row.open),
          high: Number(row.high), low: Number(row.low), close: Number(row.close) }
        return Object.values(candle).every(Number.isFinite) && candle.close > 0 ? [candle] : []
      } catch { return [] }
    }).sort((left, right) => left.at - right.at)

  let ema15 = null, ema30 = null, previousSign = 0
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    ema15 = ema15 == null ? row.close : row.close * 2 / 16 + ema15 * 14 / 16
    ema30 = ema30 == null ? row.close : row.close * 2 / 31 + ema30 * 29 / 31
    const sign = ema15 > ema30 ? 1 : ema15 < ema30 ? -1 : 0
    row.ema15 = ema15
    row.ema30 = ema30
    row.cross = index >= 29 && previousSign && sign && sign !== previousSign
    row.side = sign > 0 ? "BUY" : "SELL"
    if (index >= 29 && sign) previousSign = sign
  }
  return rows
}

function completeBook(fields) {
  let bidSize = 0, askSize = 0, bidTop2 = 0, askTop2 = 0
  for (let level = 1; level <= 5; level++) {
    const bidPrice = Number(fields[`bid_price${level}`])
    const askPrice = Number(fields[`ask_price${level}`])
    const bid = Number(fields[`bid_size${level}`])
    const ask = Number(fields[`ask_size${level}`])
    if (![bidPrice, askPrice, bid, ask].every(Number.isFinite) ||
        bidPrice <= 0 || askPrice <= bidPrice || bid < 0 || ask < 0) return null
    bidSize += bid
    askSize += ask
    if (level <= 2) { bidTop2 += bid; askTop2 += ask }
  }
  return {
    full: 100 * (bidSize - askSize) / (bidSize + askSize || 1),
    top2: 100 * (bidTop2 - askTop2) / (bidTop2 + askTop2 || 1),
  }
}

async function loadDepth(symbol) {
  const filename = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return []
  const fields = {}
  const samples = []
  let previousAt = 0
  for await (const record of records(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at) || indiaDate(at) !== DATE) continue
    if (previousAt && at - previousAt > 90_000) {
      for (const key of Object.keys(fields)) delete fields[key]
    }
    previousAt = at
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    const book = completeBook(fields)
    if (book) samples.push({ at, ...book })
  }
  return samples
}

function depthAt(samples, signalAt) {
  const selected = samples.filter((row) =>
    row.at >= signalAt - DEPTH_MINUTES * MINUTE && row.at < signalAt)
  if (selected.length < 10) return null
  const gaps = selected.slice(1).map((row, index) => (row.at - selected[index].at) / 1000)
  const spanSeconds = (selected.at(-1).at - selected[0].at) / 1000
  const maxGapSeconds = gaps.length ? Math.max(...gaps) : Infinity
  if (spanSeconds < 150 || maxGapSeconds > 15) return null
  return {
    updates: selected.length,
    spanSeconds,
    maxGapSeconds,
    averageImbalancePct: mean(selected.map((row) => row.full)),
    averageTop2ImbalancePct: mean(selected.map((row) => row.top2)),
  }
}

if (!fs.existsSync(depthRoot)) throw new Error(`Missing depth archive: ${depthRoot}`)
const symbols = (await fsp.readdir(depthRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
const matches = []
let crossCount = 0, depthQualifiedCrosses = 0
let cursor = 0
await Promise.all(Array.from({ length: 8 }, async () => {
  while (cursor < symbols.length) {
    const symbol = symbols[cursor++]
    try {
      const rows = loadCandles(symbol)
      const samples = await loadDepth(symbol)
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]
        if (!row.cross || indiaDate(row.at) !== DATE) continue
        crossCount++
        const signalAt = row.at + MINUTE
        const depth = depthAt(samples, signalAt)
        if (!depth) continue
        depthQualifiedCrosses++
        const trend = trendAngle(rows, index)
        const direction = row.side === "BUY" ? 1 : -1
        const angleAlignedWithCross = direction * trend?.beforeHeading < 0 &&
          direction * trend?.afterHeading > 0
        if (!trend || Math.abs(depth.averageImbalancePct) >= MAX_ABS_IMBALANCE_PCT ||
            trend.angle <= MIN_TREND_ANGLE_DEG || !angleAlignedWithCross) continue
        matches.push({ date: DATE, timeIst: indiaTime(signalAt), symbol, side: row.side,
          averageImbalancePct: round(depth.averageImbalancePct),
          averageTop2ImbalancePct: round(depth.averageTop2ImbalancePct),
          depthUpdates: depth.updates, depthSpanSeconds: round(depth.spanSeconds, 1),
          depthMaxGapSeconds: round(depth.maxGapSeconds, 1),
          trendAngleDeg: round(trend.angle, 2),
          beforeHeadingDeg: round(trend.beforeHeading, 2),
          afterHeadingDeg: round(trend.afterHeading, 2),
          ema15: round(row.ema15), ema30: round(row.ema30) })
      }
    } catch { /* Continue scanning the remaining universe. */ }
  }
}))

matches.sort((left, right) => left.timeIst.localeCompare(right.timeIst) ||
  left.symbol.localeCompare(right.symbol))
const columns = Object.keys(matches[0] || { date: null, timeIst: null, symbol: null, side: null,
  averageImbalancePct: null, averageTop2ImbalancePct: null, depthUpdates: null,
  depthSpanSeconds: null, depthMaxGapSeconds: null, trendAngleDeg: null, beforeHeadingDeg: null,
  afterHeadingDeg: null, ema15: null, ema30: null })
const output = path.join(ROOT, "csv", `${DATE}-ema15-30-neutral-imbalance-angle.csv`)
const csv = [columns.join(","), ...matches.map((row) => columns.map((column) => row[column]).join(","))]
await fsp.writeFile(output, `${csv.join("\n")}\n`)
console.log(JSON.stringify({ date: DATE, stocksScanned: symbols.length, crossCount,
  depthQualifiedCrosses, criteria: { depthMinutes: DEPTH_MINUTES,
    minimumDepthSpanSeconds: 150, maximumDepthGapSeconds: 15,
    absoluteAverageImbalanceBelowPct: MAX_ABS_IMBALANCE_PCT,
    trendCandlesEachSide: TREND_CANDLES, trendAngleAboveDeg: MIN_TREND_ANGLE_DEG },
  matches: matches.length, rows: matches, output }, null, 2))
