import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const date = "2026-10-22"
const ledgerFile = path.join(root, "reports", `${date}-0920-to-1000-live-ema-gap-reversal-radar.json`)
const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"))
const firstBySymbol = new Map()
for (const signal of [...(ledger.reversals || [])].sort((a, b) => String(a.signalTime).localeCompare(String(b.signalTime)))) {
  if (!firstBySymbol.has(signal.symbol)) firstBySymbol.set(signal.symbol, signal)
}

const minuteMs = 60_000
const sessionStart = Date.parse(`${date}T09:15:00+05:30`)
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const signalEpoch = (text) => Date.parse(`${text.replace(" ", "T")}:00+05:30`)
const candleDate = (row) => new Date(Number(row.time) * 1000 + 330 * minuteMs).toISOString().slice(0, 10)

function ema(rows, period) {
  const alpha = 2 / (period + 1)
  let value = null
  return rows.map((row) => {
    value = value == null ? row.close : row.close * alpha + value * (1 - alpha)
    return value
  })
}

function outcome(signal) {
  const filename = path.join(root, "db", "candles", `${signal.symbol}.jsonl`)
  const rows = fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const row = JSON.parse(line)
      return candleDate(row) === date ? [{ ...row, open: +row.open, high: +row.high, low: +row.low, close: +row.close }] : []
    } catch { return [] }
  }).sort((a, b) => a.time - b.time)
  const entryIndex = rows.findIndex((row) => Number(row.time) * 1000 > signalEpoch(signal.signalTime))
  if (entryIndex < 0) return null
  const direction = signal.reverseDirection === "BUY" ? 1 : -1
  const entry = rows[entryIndex].close
  const stop = entry * (1 - direction * 0.005)
  const target = entry * (1 + direction * 0.02)
  const fast = ema(rows, 20), slow = ema(rows, 45)
  let exitIndex = rows.length - 1, exit = rows.at(-1).close, reason = "EOD"
  for (let index = entryIndex + 1; index < rows.length; index++) {
    const row = rows[index]
    const stopHit = direction > 0 ? row.low <= stop : row.high >= stop
    const targetHit = direction > 0 ? row.high >= target : row.low <= target
    if (stopHit) { exitIndex = index; exit = stop; reason = "SL"; break }
    if (targetHit) { exitIndex = index; exit = target; reason = "TARGET"; break }
    const crossed = direction > 0
      ? fast[index - 1] >= slow[index - 1] && fast[index] < slow[index]
      : fast[index - 1] <= slow[index - 1] && fast[index] > slow[index]
    if (crossed) { exitIndex = index; exit = row.close; reason = "EMA20/45"; break }
  }
  const held = rows.slice(entryIndex + 1, exitIndex + 1)
  const maePct = held.length ? Math.max(...held.map((row) => direction > 0
    ? 100 * Math.max(0, entry - row.low) / entry
    : 100 * Math.max(0, row.high - entry) / entry)) : 0
  return { entry: round(entry), exit: round(exit), exitReason: reason,
    returnPct: round(direction * 100 * (exit - entry) / entry), maePct: round(maePct),
    exitTime: new Date(Number(rows[exitIndex].time) * 1000 + 330 * minuteMs).toISOString().slice(11, 16) }
}

function completeBook(fields, previous) {
  let bid = 0, ask = 0, bid2 = 0, ask2 = 0, bidOrders = 0, askOrders = 0
  let bestBid = null, bestAsk = null, bid1 = null, ask1 = null
  for (let level = 1; level <= 5; level++) {
    const bp = +fields[`bid_price${level}`], ap = +fields[`ask_price${level}`]
    const bs = +fields[`bid_size${level}`], as = +fields[`ask_size${level}`]
    const bo = +fields[`bid_order${level}`], ao = +fields[`ask_order${level}`]
    if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) return null
    if (level === 1) { bestBid = bp; bestAsk = ap; bid1 = bs; ask1 = as }
    bid += bs; ask += as
    if (level <= 2) { bid2 += bs; ask2 += as }
    if (Number.isFinite(bo)) bidOrders += bo
    if (Number.isFinite(ao)) askOrders += ao
  }
  let normalizedOfi = 0
  if (previous) {
    let raw = bestBid > previous.bestBid ? bid1 : bestBid === previous.bestBid ? bid1 - previous.bid1 : -previous.bid1
    raw -= bestAsk < previous.bestAsk ? ask1 : bestAsk === previous.bestAsk ? ask1 - previous.ask1 : -previous.ask1
    normalizedOfi = raw / ((bid1 + ask1 + previous.bid1 + previous.ask1) / 2 || 1)
  }
  return { full: (bid - ask) / (bid + ask || 1), top2: (bid2 - ask2) / (bid2 + ask2 || 1),
    orders: (bidOrders - askOrders) / (bidOrders + askOrders || 1), normalizedOfi,
    midpoint: (bestBid + bestAsk) / 2, spreadBps: 10_000 * (bestAsk - bestBid) / ((bestAsk + bestBid) / 2),
    bestBid, bestAsk, bid1, ask1 }
}

function depthFeatures(signal) {
  const filename = path.join(root, "db", "cash-depth", date, signal.symbol, `${signal.symbol}.jsonl`)
  if (!fs.existsSync(filename)) return null
  // Include the full completed signal minute, but nothing from the entry minute.
  const cutoff = signalEpoch(signal.signalTime) + minuteMs
  const fields = {}, samples = []
  let previous = null, previousAt = null
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at) || at < sessionStart) continue
    if (at >= cutoff) break
    if (previousAt && at - previousAt > 90_000) {
      previous = null
      for (const key of Object.keys(fields)) delete fields[key]
    }
    previousAt = at
    if (event.kind === "checkpoint" || event.book) {
      for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, event.data || {})
    } else if (event.kind === "update") Object.assign(fields, event.data || {})
    else continue
    const book = completeBook(fields, previous)
    if (!book) continue
    samples.push({ at, ...book })
    previous = book
  }
  const buckets = new Map()
  for (const sample of samples) {
    const key = Math.floor(sample.at / minuteMs)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(sample)
  }
  const minutes = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([minute, values]) => ({
    minute, full: mean(values.map((row) => row.full)), top2: mean(values.map((row) => row.top2)),
    orders: mean(values.map((row) => row.orders)), ofi: mean(values.map((row) => row.normalizedOfi)),
    midpoint: values.at(-1).midpoint, spreadBps: mean(values.map((row) => row.spreadBps)), updates: values.length,
  }))
  if (!minutes.length) return null
  const direction = signal.reverseDirection === "BUY" ? 1 : -1
  const directional = (row) => direction * row.full
  const last3 = minutes.slice(-3), last5 = minutes.slice(-5), prior = minutes.slice(0, -3)
  const move = (selected) => selected.length > 1 ? direction * 100 * (selected.at(-1).midpoint / selected[0].midpoint - 1) : 0
  return {
    depthUpdates: samples.length, depthMinutes: minutes.length,
    wholeMeanImbalanceDir: round(direction * mean(minutes.map((row) => row.full))),
    wholeMedianImbalanceDir: round(direction * median(minutes.map((row) => row.full))),
    wholeDirectionalMinutesPct: round(100 * minutes.filter((row) => directional(row) > 0).length / minutes.length, 2),
    last5MeanImbalanceDir: round(direction * mean(last5.map((row) => row.full))),
    last3MeanImbalanceDir: round(direction * mean(last3.map((row) => row.full))),
    last1ImbalanceDir: round(direction * minutes.at(-1).full),
    imbalanceShiftDir: round(direction * (mean(last3.map((row) => row.full)) - (mean(prior.map((row) => row.full)) ?? 0))),
    wholeTop2Dir: round(direction * mean(minutes.map((row) => row.top2))),
    last3Top2Dir: round(direction * mean(last3.map((row) => row.top2))),
    wholeOrdersDir: round(direction * mean(minutes.map((row) => row.orders))),
    wholeOfiDir: round(direction * mean(minutes.map((row) => row.ofi))),
    last3OfiDir: round(direction * mean(last3.map((row) => row.ofi))),
    wholeMidMoveDirPct: round(move(minutes)), last5MidMoveDirPct: round(move(last5)),
    meanSpreadBps: round(mean(minutes.map((row) => row.spreadBps))),
  }
}

const rows = []
for (const signal of firstBySymbol.values()) {
  const result = outcome(signal), depth = depthFeatures(signal)
  if (result && depth) rows.push({ symbol: signal.symbol, signalTime: signal.signalTime, direction: signal.reverseDirection,
    score: signal.score, ...result, ...depth })
}

function stats(selected) {
  const returns = selected.map((row) => row.returnPct)
  return { trades: selected.length, wins: selected.filter((row) => row.returnPct > 0).length,
    winRatePct: round(100 * selected.filter((row) => row.returnPct > 0).length / (selected.length || 1), 2),
    averageReturnPct: round(mean(returns) ?? 0), totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)),
    maximumAdverseExcursionPct: round(Math.max(0, ...selected.map((row) => row.maePct))),
    stopLosses: selected.filter((row) => row.exitReason === "SL").length,
    worstDay: selected.length ? { date, returnPct: round(returns.reduce((sum, value) => sum + value, 0)) } : null }
}

const features = ["wholeMeanImbalanceDir", "wholeMedianImbalanceDir", "wholeDirectionalMinutesPct", "last5MeanImbalanceDir",
  "last3MeanImbalanceDir", "last1ImbalanceDir", "imbalanceShiftDir", "wholeTop2Dir", "last3Top2Dir", "wholeOrdersDir",
  "wholeOfiDir", "last3OfiDir", "wholeMidMoveDirPct", "last5MidMoveDirPct", "meanSpreadBps"]
const filters = []
for (const feature of features) {
  const values = [...new Set(rows.map((row) => row[feature]).filter(Number.isFinite))].sort((a, b) => a - b)
  for (let index = 0; index < values.length - 1; index++) {
    const threshold = (values[index] + values[index + 1]) / 2
    for (const operator of [">=", "<="]) {
      const selected = rows.filter((row) => operator === ">=" ? row[feature] >= threshold : row[feature] <= threshold)
      if (selected.length < 3 || selected.length === rows.length) continue
      filters.push({ feature, operator, threshold: round(threshold), ...stats(selected),
        symbols: selected.map((row) => row.symbol) })
    }
  }
}
filters.sort((a, b) => b.totalReturnPct - a.totalReturnPct || b.winRatePct - a.winRatePct || b.trades - a.trades)

const output = {
  date,
  method: "First EMA-gap reversal per stock; depth minute-means from 09:15 through completed signal minute only; next completed 1m candle entry; SL 0.5%; target 2%; completed opposite EMA20/45 cross; gross returns",
  caution: "Single-session exploratory screen. Ranked thresholds are in-sample and must be validated on other sessions before use.",
  baseline: stats(rows), scoreAbove5: stats(rows.filter((row) => row.score > 5)),
  topSingleFeatureFilters: filters.slice(0, 20), rows,
}
const jsonFile = path.join(root, "reports", `${date}-ema-gap-depth-prefilter-analysis.json`)
fs.writeFileSync(jsonFile, JSON.stringify(output, null, 2) + "\n", { flag: "wx" })
const csvFile = path.join(root, "csv", `${date}-ema-gap-depth-prefilter-analysis.csv`)
const columns = Object.keys(rows[0] || {})
const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`
fs.writeFileSync(csvFile, [columns.join(","), ...rows.map((row) => columns.map((key) => escapeCsv(row[key])).join(","))].join("\n") + "\n", { flag: "wx" })
console.log(JSON.stringify({ jsonFile, csvFile, baseline: output.baseline, scoreAbove5: output.scoreAbove5,
  topFilters: output.topSingleFeatureFilters.slice(0, 10) }, null, 2))
