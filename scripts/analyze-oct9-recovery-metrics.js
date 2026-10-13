import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const indiaTimeMs = (date, time) => Date.parse(`${date}T${time}+05:30`)
const indiaDate = (time) => new Date(time + IST_OFFSET).toISOString().slice(0, 10)
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const sum = (values) => values.reduce((total, value) => total + value, 0)
const mean = (values) => values.length ? sum(values) / values.length : NaN

function csvRows(filename) {
  const [header, ...lines] = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const fields = header.split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
}

function jsonLines(filename) {
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function greenVolumeShare(rows) {
  const volume = sum(rows.map((row) => row.volume))
  return volume ? sum(rows.filter((row) => row.close >= row.open).map((row) => row.volume)) / volume : 0
}

function vwapGap(rows) {
  const volume = sum(rows.map((row) => row.volume))
  if (!volume) return NaN
  const vwap = sum(rows.map((row) => row.volume * (row.high + row.low + row.close) / 3)) / volume
  return pct(rows.at(-1).close, vwap)
}

function slopePct(rows) {
  if (rows.length < 2) return NaN
  const closes = rows.map((row) => row.close)
  const count = closes.length
  const sumX = count * (count - 1) / 2
  const sumY = sum(closes)
  const sumXX = (count - 1) * count * (2 * count - 1) / 6
  const sumXY = closes.reduce((total, close, index) => total + index * close, 0)
  const denominator = count * sumXX - sumX * sumX
  return denominator && sumY ? ((count * sumXY - sumX * sumY) / denominator) / (sumY / count) * 100 : 0
}

function atr14(rows) {
  const trailing = rows.slice(-15)
  const ranges = []
  for (let index = 1; index < trailing.length; index++) {
    const row = trailing[index], previousClose = trailing[index - 1].close
    ranges.push(Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose)))
  }
  return 100 * mean(ranges) / trailing.at(-1).close
}

function rsi14(rows) {
  let gains = 0, losses = 0
  for (let index = rows.length - 14; index < rows.length; index++) {
    const change = rows[index].close - rows[index - 1].close
    if (change > 0) gains += change
    else losses -= change
  }
  return losses ? 100 - 100 / (1 + gains / losses) : 100
}

function emaSeries(values, period) {
  const multiplier = 2 / (period + 1)
  let ema = values[0]
  const result = [ema]
  for (const value of values.slice(1)) {
    ema = value * multiplier + ema * (1 - multiplier)
    result.push(ema)
  }
  return result
}

function book(record) {
  const fields = record.data || {}
  let bidSize = 0, askSize = 0, topBidSize = 0, topAskSize = 0
  for (let level = 1; level <= 5; level++) {
    const bid = Number(fields[`bid_size${level}`]), ask = Number(fields[`ask_size${level}`])
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null
    bidSize += bid; askSize += ask
    if (level <= 2) { topBidSize += bid; topAskSize += ask }
  }
  return { ask: Number(fields.ask_price1),
    full: (bidSize - askSize) / (bidSize + askSize || 1),
    top2: (topBidSize - topAskSize) / (topBidSize + topAskSize || 1) }
}

const candleCache = new Map()
function candles(symbol, date, signalMinute) {
  if (!candleCache.has(symbol)) {
    candleCache.set(symbol, jsonLines(path.join(ROOT, "db", "candles", `${symbol}.jsonl`)).map((row) => ({
      time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume),
    })))
  }
  return candleCache.get(symbol).filter((row) => indiaDate(row.time * 1000) === date &&
    row.time * 1000 + MINUTE <= signalMinute)
}

function depthBuckets(symbol, date, signalMinute) {
  const filename = path.join(ROOT, "db", "cash-depth", date, symbol, `${symbol}.jsonl`)
  const buckets = new Map()
  for (const record of jsonLines(filename)) {
    const at = Date.parse(record.receivedAt)
    if (!(at >= signalMinute - 15 * MINUTE && at < signalMinute)) continue
    const current = book(record)
    if (!current || !Number.isFinite(current.ask)) continue
    const minute = Math.floor(at / MINUTE) * MINUTE
    const bucket = buckets.get(minute) || { count: 0, full: 0, top2: 0,
      firstAsk: current.ask, lastAsk: current.ask }
    bucket.count++; bucket.full += current.full; bucket.top2 += current.top2; bucket.lastAsk = current.ask
    buckets.set(minute, bucket)
  }
  return [...buckets.entries()].filter(([, bucket]) => bucket.count >= 3)
    .sort(([left], [right]) => left - right).map(([, bucket]) => bucket)
}

function metricsAt(date, symbol, at) {
  const signalMinute = Math.floor(at / MINUTE) * MINUTE
  const rows = candles(symbol, date, signalMinute)
  const depth = depthBuckets(symbol, date, signalMinute)
  const last15 = rows.slice(-15), last = last15.at(-1), last3 = rows.slice(-3)
  const last5 = rows.slice(-5), last10 = rows.slice(-10), last30 = rows.slice(-30), last50 = rows.slice(-50)
  const lastDepth3 = depth.slice(-3), ema5 = emaSeries(rows.map((row) => row.close), 5)
  const aggregate3 = { high: Math.max(...last3.map((row) => row.high)), low: Math.min(...last3.map((row) => row.low)) }
  return {
    return15: pct(last.close, last15[0].open), rsi14: rsi14(last15),
    pullback15: pct(Math.max(...last15.map((row) => row.high)), last.close), vwapGap15: vwapGap(last15),
    dayReturn: pct(last.close, rows[0].open), depthMinutes: depth.length,
    depthImbalance15: mean(depth.map((row) => row.full / row.count)),
    askDrift15: pct(depth.at(-1).lastAsk, depth[0].firstAsk), slope50: slopePct(last50),
    positiveDepthShare15: depth.filter((row) => row.full / row.count > 0).length / depth.length,
    askDrift3: pct(lastDepth3.at(-1).lastAsk, lastDepth3[0].firstAsk),
    greenVolume50: greenVolumeShare(last50), recovery50: pct(last.close, Math.min(...last50.map((row) => row.low))),
    range3: pct(aggregate3.high, aggregate3.low), return30: pct(last.close, last30[0].open),
    atr14: atr14(rows), greenVolume30: greenVolumeShare(last30),
    pullback10: pct(Math.max(...last10.map((row) => row.high)), last.close), return3: pct(last.close, last3[0].open),
    ema5Slope10: ema5.length >= 11 ? pct(ema5.at(-1), ema5.at(-11)) / 10 : NaN,
    greenVolume5: greenVolumeShare(last5),
    depthChange15: depth.at(-1).full / depth.at(-1).count - depth[0].full / depth[0].count,
    top2Imbalance3: mean(lastDepth3.map((row) => row.top2 / row.count)),
  }
}

const rows = []
for (const row of csvRows(path.join(ROOT, "csv", "2026-10-06-to-08-optimized-multiframe-depth-buy-zero-stop-audit.csv"))) {
  rows.push({ class: "WIN", date: row.date, symbol: row.symbol,
    metrics: metricsAt(row.date, row.symbol, indiaTimeMs(row.date, row.time_ist)) })
}
const survivorStops = new Set(["BOSCHLTD", "CYIENTDLM", "JIOFIN", "SONACOMS", "TRENT", "TCS"])
for (const signal of JSON.parse(fs.readFileSync(path.join(ROOT, "db", "strategy-signals", "multi-frame-depth-buy", "2026-10-09.json")))) {
  if (survivorStops.has(signal.symbol)) rows.push({ class: "STOP", date: "2026-10-09", symbol: signal.symbol,
    metrics: metricsAt("2026-10-09", signal.symbol, Date.parse(signal.time)) })
}

const fields = Object.keys(rows[0].metrics)
const round = (value) => Number.isFinite(value) ? Number(value.toFixed(5)) : null
const output = rows.map((row) => ({ class: row.class, date: row.date, symbol: row.symbol,
  ...Object.fromEntries(fields.map((field) => [field, round(row.metrics[field])])) }))
const filename = path.join(ROOT, "csv", "2026-10-06-to-09-recovery-winner-stop-metrics.csv")
fs.writeFileSync(filename, [Object.keys(output[0]).join(","), ...output.map((row) => Object.values(row).join(","))].join("\n") + "\n")
console.log(JSON.stringify({ filename, rows: output }, null, 2))
