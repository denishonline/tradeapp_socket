import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const CANDLES = path.join(ROOT, "db", "candles")
const DEPTH = path.join(ROOT, "db", "cash-depth")
const REPORTS = path.join(ROOT, "reports")
const COHORT = path.join(REPORTS, "2026-10-05-to-2026-10-16-ema10-ema20-over-1p5-trend-legs.csv")
const DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]
const TRAIN_DATES = new Set(DATES.slice(0, 6))
const MINUTE = 60_000
const IST = 330 * MINUTE
const keyOf = (row) => `${row.date}|${row.symbol}|${row.side}|${row.entryTime}`
const dateOf = (at) => new Date(at + IST).toISOString().slice(0, 10)
const timeOf = (at) => new Date(at + IST).toISOString().slice(11, 16)
const pct = (value, base) => base > 0 ? 100 * (value / base - 1) : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function csvRows(filename) {
  const [header, ...lines] = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const keys = header.split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [keys[index], value])))
}

function csvValue(value) {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function outputPath(base, extension) {
  let attempt = 1
  while (true) {
    const suffix = attempt === 1 ? "" : `-${attempt}`
    const filename = path.join(REPORTS, `${base}${suffix}.${extension}`)
    if (!fs.existsSync(filename)) return filename
    attempt++
  }
}

function jsonl(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function loadStockCandles(symbol) {
  const byDate = new Map()
  for (const row of jsonl(path.join(CANDLES, `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000, date = dateOf(at)
    const candle = { at, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }
    if (!DATES.includes(date) || !Object.values(candle).every(Number.isFinite) || candle.open <= 0) continue
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(candle)
  }
  for (const rows of byDate.values()) rows.sort((left, right) => left.at - right.at)
  return byDate
}

function addEma(rows) {
  let fast = null, slow = null, priorSign = 0
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    fast = fast == null ? row.close : row.close * 2 / 11 + fast * 9 / 11
    slow = slow == null ? row.close : row.close * 2 / 21 + slow * 19 / 21
    row.ema10 = fast; row.ema20 = slow; row.sign = fast > slow ? 1 : fast < slow ? -1 : 0
    row.cross = index >= 19 && priorSign && row.sign && row.sign !== priorSign
    if (index >= 19 && row.sign) priorSign = row.sign
  }
}

function continuous(rows, from, to) {
  for (let index = from + 1; index <= to; index++) if (rows[index].at !== rows[index - 1].at + MINUTE) return false
  return true
}

function allLegs(symbol, date, rows) {
  if (rows.length < 21) return []
  addEma(rows)
  const crosses = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.cross)
  const legs = []
  for (let crossIndex = 0; crossIndex + 1 < crosses.length; crossIndex++) {
    const cross = crosses[crossIndex], opposite = crosses[crossIndex + 1]
    const entryIndex = cross.index + 1, exitIndex = opposite.index + 1
    if (exitIndex >= rows.length || !continuous(rows, entryIndex, exitIndex)) continue
    const side = cross.row.sign > 0 ? "BUY" : "SELL"
    const entry = rows[entryIndex], exit = rows[exitIndex]
    const returnPct = side === "BUY" ? pct(exit.open, entry.open) : pct(entry.open, exit.open)
    legs.push({ date, symbol, side, entryTime: timeOf(entry.at), signalAt: cross.row.at + MINUTE,
      entryAt: entry.at, returnPct, crossIndex: cross.index, rows })
  }
  return legs
}

function avg(values) { return mean(values.filter(Number.isFinite)) }
function priorReturn(rows, index, count, direction) {
  const selected = rows.slice(Math.max(0, index - count + 1), index + 1)
  if (!selected.length) return NaN
  const raw = pct(selected.at(-1).close, selected[0].open)
  return direction * raw
}

function candleFeatures(leg) {
  const rows = leg.rows, index = leg.crossIndex, row = rows[index], direction = leg.side === "BUY" ? 1 : -1
  const previous = rows.slice(Math.max(0, index - 10), index)
  const high = row.high, low = row.low, range = high - low
  const directionalCloseLocation = range > 0 ? 100 * (direction > 0 ? row.close - low : high - row.close) / range : 50
  const previousVolume = avg(previous.map((item) => item.volume))
  const previousEmaGap = index ? rows[index - 1].ema10 - rows[index - 1].ema20 : 0
  const opening = rows[0]?.open
  return {
    stockReturn1: direction * pct(row.close, row.open),
    stockReturn3: priorReturn(rows, index, 3, direction), stockReturn5: priorReturn(rows, index, 5, direction),
    stockReturn10: priorReturn(rows, index, 10, direction),
    stockOpeningReturn: direction * pct(row.close, opening),
    stockCloseLocation: directionalCloseLocation,
    stockVolumeRatio10: previousVolume > 0 ? row.volume / previousVolume : NaN,
    emaGapBps: direction * 10_000 * (row.ema10 - row.ema20) / row.close,
    emaGapChangeBps: direction * 10_000 * ((row.ema10 - row.ema20) - previousEmaGap) / row.close,
    timeMinute: Number(timeOf(row.at).slice(0, 2)) * 60 + Number(timeOf(row.at).slice(3)),
  }
}

function loadNifty() {
  const byDate = new Map()
  for (const row of jsonl(path.join(CANDLES, "NIFTY50.jsonl"))) {
    const at = Number(row.time) * 1000, date = dateOf(at)
    const candle = { at, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }
    if (!DATES.includes(date) || !Object.values(candle).every(Number.isFinite)) continue
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(candle)
  }
  for (const rows of byDate.values()) addEma(rows.sort((left, right) => left.at - right.at))
  return byDate
}

function niftyFeatures(leg, niftyByDate) {
  const rows = niftyByDate.get(leg.date) || []
  const index = rows.findIndex((row) => row.at === leg.signalAt - MINUTE)
  if (index < 0) return {}
  const row = rows[index], direction = leg.side === "BUY" ? 1 : -1
  return {
    niftyReturn3: priorReturn(rows, index, 3, direction), niftyReturn5: priorReturn(rows, index, 5, direction),
    niftyReturn10: priorReturn(rows, index, 10, direction),
    niftyEmaGapBps: direction * 10_000 * (row.ema10 - row.ema20) / row.close,
    niftyTrendAligned: direction * row.sign,
    niftyOpeningReturn: direction * pct(row.close, rows[0].open),
  }
}

function book(fields) {
  let bid = 0, ask = 0, topBid = 0, topAsk = 0
  for (let level = 1; level <= 5; level++) {
    const bp = Number(fields[`bid_price${level}`]), ap = Number(fields[`ask_price${level}`])
    const bs = Number(fields[`bid_size${level}`]), as = Number(fields[`ask_size${level}`])
    if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) return null
    bid += bs; ask += as
    if (level <= 2) { topBid += bs; topAsk += as }
  }
  const bid1 = Number(fields.bid_price1), ask1 = Number(fields.ask_price1)
  return { bid, ask, bid1, ask1, full: (bid - ask) / (bid + ask || 1),
    top2: (topBid - topAsk) / (topBid + topAsk || 1), mid: (bid1 + ask1) / 2,
    spreadBps: 10_000 * (ask1 - bid1) / ((ask1 + bid1) / 2) }
}

function loadDepth(symbol, date) {
  const fields = {}, samples = []
  let previous = null
  for (const record of jsonl(path.join(DEPTH, date, symbol, `${symbol}.jsonl`))) {
    const at = Date.parse(record.receivedAt)
    if (!Number.isFinite(at)) continue
    if (record.kind === "checkpoint" || record.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, record.data)
    } else if (record.kind === "update") Object.assign(fields, record.data)
    else continue
    const current = book(fields)
    if (!current) continue
    let ofi = 0
    if (previous) {
      const bidFlow = current.bid1 > previous.bid1 ? Number(fields.bid_size1)
        : current.bid1 === previous.bid1 ? Number(fields.bid_size1) - previous.bidSize : -previous.bidSize
      const askFlow = current.ask1 < previous.ask1 ? Number(fields.ask_size1)
        : current.ask1 === previous.ask1 ? Number(fields.ask_size1) - previous.askSize : -previous.askSize
      ofi = (bidFlow - askFlow) / ((Number(fields.bid_size1) + Number(fields.ask_size1) + previous.bidSize + previous.askSize) / 2 || 1)
    }
    samples.push({ at, ofi, ...current })
    previous = { ...current, bidSize: Number(fields.bid_size1), askSize: Number(fields.ask_size1) }
  }
  return samples
}

function depthFeatures(samples, leg) {
  const start = leg.signalAt - 3 * MINUTE
  const rows = samples.filter((row) => row.at >= start && row.at <= leg.signalAt)
  if (rows.length < 3) return { depthAvailable: 0 }
  const direction = leg.side === "BUY" ? 1 : -1
  const first = rows[0], last = rows.at(-1)
  return {
    depthAvailable: 1, depthSamples3m: rows.length, depthSpanSec: (last.at - first.at) / 1000,
    depthLastAgeSec: (leg.signalAt - last.at) / 1000,
    depthFull3m: direction * avg(rows.map((row) => row.full)), depthTop2_3m: direction * avg(rows.map((row) => row.top2)),
    depthClosingFull: direction * last.full, depthClosingTop2: direction * last.top2,
    depthOfi3m: direction * avg(rows.map((row) => row.ofi)),
    depthMidReturn3m: direction * pct(last.mid, first.mid), depthSpreadBps: avg(rows.map((row) => row.spreadBps)),
  }
}

function hash(text) {
  let value = 2166136261
  for (const char of text) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619) }
  return value >>> 0
}

function evaluate(condition, rows) {
  const passing = rows.filter(condition), positive = passing.filter((row) => row.cohort === "QUALIFIED")
  const controls = passing.length - positive.length
  return { signals: passing.length, positives: positive.length, controls, precisionPct: round(100 * positive.length / (passing.length || 1), 2),
    recallPct: round(100 * positive.length / rows.filter((row) => row.cohort === "QUALIFIED").length, 2),
    dates: [...new Set(positive.map((row) => row.date))].length }
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return NaN
  const index = (sorted.length - 1) * fraction, low = Math.floor(index), high = Math.ceil(index)
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

function discoverRules(rows, features) {
  const train = rows.filter((row) => TRAIN_DATES.has(row.date)), validation = rows.filter((row) => !TRAIN_DATES.has(row.date))
  const conditions = []
  for (const feature of features) {
    const values = train.map((row) => row[feature]).filter(Number.isFinite)
    for (const fraction of [.15, .25, .35, .5, .65, .75, .85]) {
      const threshold = percentile(values, fraction)
      for (const operator of [">=", "<="]) {
        const predicate = (row) => Number.isFinite(row[feature]) && (operator === ">=" ? row[feature] >= threshold : row[feature] <= threshold)
        const training = evaluate(predicate, train)
        if (training.positives < 15 || training.controls < 8 || training.dates < 4) continue
        const validationStats = evaluate(predicate, validation)
        if (validationStats.positives < 8 || validationStats.controls < 4 || validationStats.dates < 3) continue
        conditions.push({ feature, operator, threshold: round(threshold, 4), training, validation: validationStats, predicate })
      }
    }
  }
  // Select candidates from the training dates only. Validation dates must never
  // influence which rule is labelled strongest.
  conditions.sort((left, right) => right.training.precisionPct - left.training.precisionPct || right.training.positives - left.training.positives)
  const pairs = []
  for (let left = 0; left < Math.min(12, conditions.length); left++) for (let right = left + 1; right < Math.min(12, conditions.length); right++) {
    const first = conditions[left], second = conditions[right]
    const predicate = (row) => first.predicate(row) && second.predicate(row)
    const training = evaluate(predicate, train), validationStats = evaluate(predicate, validation)
    if (training.positives < 12 || training.controls < 4 || validationStats.positives < 7 || validationStats.controls < 3 || validationStats.dates < 3) continue
    pairs.push({ rules: [first, second].map(({ feature, operator, threshold }) => ({ feature, operator, threshold })), training, validation: validationStats })
  }
  pairs.sort((left, right) => right.training.precisionPct - left.training.precisionPct || right.training.positives - left.training.positives)
  return { single: conditions.slice(0, 12).map(({ predicate, ...rule }) => rule), pairs: pairs.slice(0, 8) }
}

const cohortKeys = new Set(csvRows(COHORT).map(keyOf))
const symbols = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")).map((value) => String(value).trim().toUpperCase().replace(/-EQ$/, ""))
const candidates = []
for (const symbol of symbols) for (const [date, rows] of loadStockCandles(symbol)) candidates.push(...allLegs(symbol, date, rows))
const positives = candidates.filter((row) => cohortKeys.has(keyOf(row)))
if (positives.length !== cohortKeys.size) throw new Error(`Cohort reconstruction mismatch: expected ${cohortKeys.size}, found ${positives.length}`)

const controls = []
for (const [group, groupPositives] of Map.groupBy(positives, (row) => `${row.date}|${row.side}`)) {
  const [date, side] = group.split("|")
  const eligible = candidates.filter((row) => row.date === date && row.side === side && row.returnPct <= 0)
    .sort((left, right) => hash(`${group}|${left.symbol}|${left.entryTime}`) - hash(`${group}|${right.symbol}|${right.entryTime}`))
  controls.push(...eligible.slice(0, groupPositives.length * 2))
}
const sampled = [...positives.map((row) => ({ ...row, cohort: "QUALIFIED" })), ...controls.map((row) => ({ ...row, cohort: "CONTROL" }))]
const nifty = loadNifty()
const byFile = new Map()
for (const row of sampled) {
  const fileKey = `${row.date}|${row.symbol}`
  if (!byFile.has(fileKey)) byFile.set(fileKey, [])
  byFile.get(fileKey).push(row)
}
for (const [fileKey, rows] of byFile) {
  const [date, symbol] = fileKey.split("|")
  const depth = loadDepth(symbol, date)
  for (const row of rows) Object.assign(row, candleFeatures(row), niftyFeatures(row, nifty), depthFeatures(depth, row))
}

const fields = ["date", "symbol", "side", "cohort", "entryTime", "returnPct", "stockReturn1", "stockReturn3", "stockReturn5", "stockReturn10", "stockOpeningReturn", "stockCloseLocation", "stockVolumeRatio10", "emaGapBps", "emaGapChangeBps", "timeMinute", "niftyReturn3", "niftyReturn5", "niftyReturn10", "niftyEmaGapBps", "niftyTrendAligned", "niftyOpeningReturn", "depthAvailable", "depthSamples3m", "depthSpanSec", "depthLastAgeSec", "depthFull3m", "depthTop2_3m", "depthClosingFull", "depthClosingTop2", "depthOfi3m", "depthMidReturn3m", "depthSpreadBps"]
const featureFields = fields.filter((field) => /^stock|^ema|^nifty|^depth/.test(field) && !["depthAvailable", "depthSamples3m", "depthSpanSec", "depthLastAgeSec"].includes(field))
const report = {
  methodology: "Qualified cohort uses the 159 stored EMA-10/20 legs. Controls are two deterministic, date-and-side-matched completed EMA legs with return <= 0 per qualified leg. Features use only completed candles through crossover close, depth snapshots received no later than that close, and NIFTY's matching completed candle. Rule discovery uses Oct 5-12; validation uses Oct 13-16.",
  coverage: { qualified: positives.length, controls: controls.length, rowsWithDepth: sampled.filter((row) => row.depthAvailable).length,
    qualifiedWithDepth: sampled.filter((row) => row.cohort === "QUALIFIED" && row.depthAvailable).length },
  cohortPerformance: {
    BUY: { count: positives.filter((row) => row.side === "BUY").length, averageReturnPct: round(avg(positives.filter((row) => row.side === "BUY").map((row) => row.returnPct))) },
    SELL: { count: positives.filter((row) => row.side === "SELL").length, averageReturnPct: round(avg(positives.filter((row) => row.side === "SELL").map((row) => row.returnPct))) },
  },
  rules: discoverRules(sampled.filter((row) => row.depthAvailable), featureFields),
}
fs.mkdirSync(REPORTS, { recursive: true })
const base = "2026-10-05-to-2026-10-16-ema10-20-entry-context"
const csvOutput = outputPath(base, "csv"), jsonOutput = outputPath(base, "json")
fs.writeFileSync(csvOutput, `${[fields.join(","), ...sampled.map((row) => fields.map((field) => csvValue(round(row[field], 5) ?? row[field])).join(","))].join("\n")}\n`)
fs.writeFileSync(jsonOutput, `${JSON.stringify({ ...report, csvOutput }, null, 2)}\n`)
console.log(JSON.stringify({ ...report, csvOutput, jsonOutput }, null, 2))
