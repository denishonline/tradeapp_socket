import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), MINUTE = 60_000
const SIGNAL_ROOT = path.join(ROOT, "db", "strategy-signals")
const DEPTH_ROOT = path.join(ROOT, "db", "cash-depth")
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"]
const indiaTimeMs = (date, time) => Date.parse(`${date}T${time}+05:30`)
const indiaDate = (at) => new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
const sideReturn = (entry, price, side) => (side === "SELL" ? -1 : 1) * (price / entry - 1) * 100
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function jsonLines(filename) {
  if (!fs.existsSync(filename)) return []
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}
function csvRows(filename) {
  const text = fs.readFileSync(filename, "utf8"), records = []
  let row = [], value = "", quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index++ }
      else if (char === '"') quoted = false
      else value += char
    } else if (char === '"') quoted = true
    else if (char === ",") { row.push(value); value = "" }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); records.push(row); row = []; value = "" }
    else value += char
  }
  const columns = records.shift()
  return records.filter((record) => record.some(Boolean)).map((record) =>
    Object.fromEntries(columns.map((column, index) => [column, record[index] ?? ""])))
}
const pathCache = new Map()
function pricePath(date, symbol) {
  const key = `${date}:${symbol}`
  if (pathCache.has(key)) return pathCache.get(key)
  const depth = jsonLines(path.join(DEPTH_ROOT, date, symbol, `${symbol}.jsonl`)).flatMap((record) => {
    const at = Date.parse(record.receivedAt), price = Number(record.marketContext?.price)
    return Number.isFinite(at) && Number.isFinite(price) && price > 0 ? [{ at, price }] : []
  })
  const candles = jsonLines(path.join(CANDLE_ROOT, `${symbol}.jsonl`)).flatMap((record) => {
    const at = (Number(record.time) + 60) * 1000, price = Number(record.close)
    return Number.isFinite(at) && indiaDate(at) === date && Number.isFinite(price) && price > 0
      ? [{ at, price }] : []
  })
  const rows = [...depth, ...candles].sort((a, b) => a.at - b.at)
  pathCache.set(key, rows)
  return rows
}
function closestPrice(date, symbol, at) {
  return pricePath(date, symbol).filter((row) => Math.abs(row.at - at) <= MINUTE)
    .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0]?.price
}
function confirm(raw, rule) {
  for (const sample of pricePath(raw.date, raw.symbol)) {
    if (sample.at <= raw.at || sample.at > raw.at + rule.wait * MINUTE) continue
    const progress = sideReturn(raw.entry, sample.price, raw.side)
    if (progress <= -rule.cancel) return null
    if (progress >= rule.confirm) return sample
  }
  return null
}
function finalReturn(row, entryAt, entryPrice) {
  const last = pricePath(row.date, row.symbol).filter((sample) => sample.at > entryAt).at(-1)
  return last ? sideReturn(entryPrice, last.price, row.side) : 0
}
function classify(status, returnPct) {
  if (status === "Target reached") return "Winner"
  if (status === "Stopped") return "Loser"
  return returnPct >= 0 ? "Open profit" : "Open loss"
}

const rows = [], keys = new Set()
function add(row) {
  const key = `${row.date}|${row.strategy}|${row.symbol}`
  if (keys.has(key)) return
  keys.add(key); rows.push(row)
}

const directoryConfig = {
  "bid-support-breakout": "Bid Support Breakout",
  "early-depth-breakout": "Early Depth-Control Breakout",
  "multi-frame-depth-buy": "Multi-Frame Depth Recovery",
  "multi-frame-depth-sell": "Multi-Frame Depth Continuation",
  "failed-bid-absorption": "Failed Bid Absorption",
  "persistent-bid-breakout": "Persistent Bid Absorption Breakout",
}
const confirmationRules = {
  "Multi-Frame Depth Recovery": { confirm: 0.08, cancel: 0.20, wait: 20 },
  "Multi-Frame Depth Continuation": { confirm: 0.20, cancel: 0.40, wait: 10 },
  "Persistent Bid Absorption Breakout": { confirm: 0.05, cancel: 0.15, wait: 5 },
}
for (const [directory, strategy] of Object.entries(directoryConfig)) {
  for (const date of DATES) {
    const filename = path.join(SIGNAL_ROOT, directory, `${date}.json`)
    if (!fs.existsSync(filename)) continue
    for (const signal of JSON.parse(fs.readFileSync(filename, "utf8"))) {
      const metrics = signal.metrics || {}, rawAt = Date.parse(signal.time), rawEntry = Number(signal.price)
      let keep = true, entryAt = rawAt, entryPrice = rawEntry
      if (strategy === "Bid Support Breakout") {
        keep = Number(metrics.trendPct) <= 1 &&
          ((Number(metrics.liveFlow) >= 0.30 && Number(metrics.liveVolumePace) >= 4) ||
          (Number(metrics.liveFlow) >= 0.05 && Number(metrics.liveVolumePace) >= 5) ||
          Number(metrics.return3Pct) >= 0.15 || Number(metrics.volume5Ratio) >= 0.50)
      } else if (strategy === "Failed Bid Absorption") {
        keep = Number(metrics.postSweepBidSharePct) <= 20
      } else if (confirmationRules[strategy]) {
        if (strategy === "Multi-Frame Depth Recovery") {
          if (metrics.filterBranch === "gap_recovery") keep = Number(metrics.return3) > 0
          if (metrics.filterBranch === "controlled_recovery") {
            keep = Number(metrics.askDrift3) <= 0.12 && Number(metrics.pullback10) <= 0.15
          }
        }
        if (strategy === "Multi-Frame Depth Continuation") {
          const ist = new Date(rawAt + 330 * MINUTE)
          keep = ist.getUTCHours() * 60 + ist.getUTCMinutes() <= 14 * 60 + 30 &&
            Number(metrics.recovery15) <= 0.65 &&
            (Number(metrics.vwapGap10) <= 0.20 || Number(metrics.greenVolume15) >= 0.45)
        }
        const confirmation = keep ? confirm({ date, symbol: signal.symbol,
          side: signal.direction, at: rawAt, entry: rawEntry }, confirmationRules[strategy]) : null
        keep = Boolean(confirmation)
        if (confirmation) { entryAt = confirmation.at; entryPrice = confirmation.price }
      }
      if (!keep) continue
      const targetReturn = sideReturn(entryPrice, Number(signal.target), signal.direction)
      const stopReturn = sideReturn(entryPrice, Number(signal.stop), signal.direction)
      const returnPct = signal.status === "Target reached" ? targetReturn
        : signal.status === "Stopped" ? stopReturn : finalReturn({ date, symbol: signal.symbol,
          side: signal.direction }, entryAt, entryPrice)
      add({ date, strategy, symbol: signal.symbol, status: signal.status,
        outcome: classify(signal.status, returnPct), returnPct: round(returnPct), source: "persisted-live" })
    }
  }
}

// Historical Multi-Frame winners that defined the live rules.
for (const [filename, strategy, side] of [
  ["2026-10-06-to-08-optimized-multiframe-depth-buy-zero-stop-audit.csv", "Multi-Frame Depth Recovery", "BUY"],
  ["2026-10-06-to-08-multiframe-depth-2pct-zero-stop-audit.csv", "Multi-Frame Depth Continuation", "SELL"],
]) {
  for (const record of csvRows(path.join(ROOT, "csv", filename))) {
    const raw = { date: record.date, symbol: record.symbol, side,
      at: indiaTimeMs(record.date, record.time_ist), entry: Number(record.entry) }
    const confirmation = confirm(raw, confirmationRules[strategy])
    if (!confirmation) continue
    const rawTarget = raw.entry * (side === "SELL" ? 0.98 : 1.02)
    add({ date: raw.date, strategy, symbol: raw.symbol, status: "Target reached",
      outcome: "Winner", returnPct: round(sideReturn(confirmation.price, rawTarget, side)), source: "historical-audit" })
  }
}

// Historical Failed Bid Absorption signals; the <=20% post-sweep gate keeps these rows.
for (const record of csvRows(path.join(ROOT, "csv", "2026-10-06-to-09-enhanced-failed-bid-absorption.csv"))) {
  if (Number(record.postSweepBidSharePct) > 20) continue
  const target = record.result === "TARGET"
  const returnPct = target ? 1 : Number(record.closeReturnPct)
  add({ date: record.date, strategy: "Failed Bid Absorption", symbol: record.symbol,
    status: target ? "Target reached" : "Active", outcome: target ? "Winner" : classify("Active", returnPct),
    returnPct: round(returnPct), source: "historical-audit" })
}

// Earlier radar strategies and signals not stored in the strategy-specific folders.
for (const record of csvRows(path.join(ROOT, "csv", "2026-10-05-to-07-all-strategy-radar-results.csv"))) {
  const key = `${record.date}|${record.strategy}|${record.symbol}`
  if (keys.has(key)) continue
  const side = "BUY", at = indiaTimeMs(record.date, record.signal_ist)
  let entry = closestPrice(record.date, record.symbol, at), entryAt = at
  if (!Number.isFinite(entry)) entry = 0
  let status = record.outcome === "Target reached" ? "Target reached"
    : record.outcome === "Stopped" ? "Stopped" : "Active"
  let returnPct = status === "Target reached" ? Number(record.target_pct)
    : status === "Stopped" ? -Number(record.stop_pct) : finalReturn({ date: record.date,
      symbol: record.symbol, side }, entryAt, entry)
  if (record.strategy === "Persistent Bid Absorption Breakout") {
    const confirmation = confirm({ date: record.date, symbol: record.symbol, side, at, entry },
      confirmationRules[record.strategy])
    if (!confirmation) continue
    entryAt = confirmation.at
    const targetPrice = entry * (1 + Number(record.target_pct) / 100)
    returnPct = status === "Target reached" ? sideReturn(confirmation.price, targetPrice, side)
      : finalReturn({ date: record.date, symbol: record.symbol, side }, entryAt, confirmation.price)
  }
  add({ date: record.date, strategy: record.strategy, symbol: record.symbol, status,
    outcome: classify(status, returnPct), returnPct: round(returnPct), source: "radar-audit" })
}

rows.sort((a, b) => a.date.localeCompare(b.date) || a.strategy.localeCompare(b.strategy) || a.symbol.localeCompare(b.symbol))
const strategies = [...new Set(rows.map((row) => row.strategy))]
const summary = strategies.map((strategy) => {
  const group = rows.filter((row) => row.strategy === strategy)
  return { strategy, signals: group.length,
    winners: group.filter((row) => row.outcome === "Winner").length,
    losers: group.filter((row) => row.outcome === "Loser").length,
    openProfit: group.filter((row) => row.outcome === "Open profit").length,
    openLoss: group.filter((row) => row.outcome === "Open loss").length,
    returnPct: round(group.reduce((sum, row) => sum + row.returnPct, 0)) }
}).sort((a, b) => b.returnPct - a.returnPct)
const byDay = DATES.map((date) => {
  const group = rows.filter((row) => row.date === date)
  return { date, signals: group.length, winners: group.filter((row) => row.outcome === "Winner").length,
    losers: group.filter((row) => row.outcome === "Loser").length,
    openProfit: group.filter((row) => row.outcome === "Open profit").length,
    openLoss: group.filter((row) => row.outcome === "Open loss").length,
    returnPct: round(group.reduce((sum, row) => sum + row.returnPct, 0)) }
})
function writeCsv(filename, data) {
  const columns = Object.keys(data[0])
  const cell = (value) => /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value)
  fs.writeFileSync(filename, `${columns.join(",")}\n${data.map((row) =>
    columns.map((column) => cell(row[column])).join(",")).join("\n")}\n`)
}
const detailOutput = path.join(ROOT, "csv", "2026-10-05-to-13-filtered-strategy-radar-results.csv")
const summaryOutput = path.join(ROOT, "csv", "2026-10-05-to-13-filtered-strategy-radar-summary.csv")
writeCsv(detailOutput, rows); writeCsv(summaryOutput, summary)
console.log(JSON.stringify({ detailOutput, summaryOutput, summary, byDay,
  total: { signals: rows.length, winners: rows.filter((row) => row.outcome === "Winner").length,
    losers: rows.filter((row) => row.outcome === "Loser").length,
    openProfit: rows.filter((row) => row.outcome === "Open profit").length,
    openLoss: rows.filter((row) => row.outcome === "Open loss").length,
    returnPct: round(rows.reduce((sum, row) => sum + row.returnPct, 0)) } }, null, 2))
