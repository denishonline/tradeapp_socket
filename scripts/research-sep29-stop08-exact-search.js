#!/usr/bin/env node

// Searches the causal all-stock S/R event ledger for a new 2026-09-29 mover
// strategy whose +1.10% target occurs before a strict -0.80% stop. No future
// candle is used to form a signal; later candles only determine its outcome.

import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), REPORTS = path.join(ROOT, "reports")
const discoveryArg = process.argv.indexOf("--discovery-date")
const DATE = discoveryArg >= 0 ? process.argv[discoveryArg + 1] : "2026-09-29"
if (!/^2026-(?:09|10)-\d{2}$/.test(DATE)) throw new Error("Usage: --discovery-date YYYY-MM-DD (September or October 2026)")
const IST_MS = 330 * 60_000, TARGET_PCT = 1.1, STOP_PCT = .8
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const minuteOf = value => +value.slice(0, 2) * 60 + +value.slice(3)
const clock = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`

function latestReports() {
  const latest = new Map()
  for (const name of fs.readdirSync(REPORTS)) {
    const match = /^(2026-(?:09|10)-\d\d)-top-movers-support-resistance-price-action-mtf-universe-first-signal(?:-\d+)?\.json$/.exec(name)
    if (!match) continue
    const file = path.join(REPORTS, name), stat = fs.statSync(file), old = latest.get(match[1])
    if (!old || stat.mtimeMs > old.mtimeMs) latest.set(match[1], { file, mtimeMs: stat.mtimeMs })
  }
  return [...latest.entries()].filter(([date]) => date >= "2026-09-01" && date <= "2026-10-30").sort(([a], [b]) => a.localeCompare(b))
}

function topMovers() {
  const output = []
  for (const file of fs.readdirSync(path.join(ROOT, "db", "candles"))) {
    if (!file.endsWith(".jsonl") || file === "NIFTY50.jsonl") continue
    const session = fs.readFileSync(path.join(ROOT, "db", "candles", file), "utf8").split(/\r?\n/).flatMap(line => {
      try {
        if (!line) return []
        const row = JSON.parse(line), stamp = new Date(+row.time * 1000 + IST_MS).toISOString(), minute = +stamp.slice(11, 13) * 60 + +stamp.slice(14, 16)
        return stamp.slice(0, 10) === DATE && minute >= 555 && minute < 930 ? [row] : []
      } catch { return [] }
    }).sort((a, b) => a.time - b.time)
    if (session.length < 300 || !(+session[0].open > 0) || !Number.isFinite(+session.at(-1).close)) continue
    output.push({ symbol: file.slice(0, -6), intradayMovePct: round(100 * (+session.at(-1).close / +session[0].open - 1)) })
  }
  output.sort((a, b) => b.intradayMovePct - a.intradayMovePct)
  return { gainers: output.slice(0, 10), losers: output.slice(-10).reverse() }
}

const movers = topMovers(), moverSymbols = new Set([...movers.gainers, ...movers.losers].map(row => row.symbol))
const reports = latestReports()
const rawEvents = reports.flatMap(([date, item]) => (JSON.parse(fs.readFileSync(item.file, "utf8")).trades || []).map(row => ({ ...row, date, minute: minuteOf(row.signalTime) })))

const candlesBySymbol = new Map()
function sessionCandles(symbol, date) {
  if (!candlesBySymbol.has(symbol)) {
    const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`), dates = new Map()
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      try {
        if (!line) continue
        const row = JSON.parse(line), stamp = new Date(+row.time * 1000 + IST_MS).toISOString(), candleDate = stamp.slice(0, 10), minute = +stamp.slice(11, 13) * 60 + +stamp.slice(14, 16)
        if (!dates.has(candleDate)) dates.set(candleDate, [])
        dates.get(candleDate).push({ minute, high: +row.high, low: +row.low })
      } catch {}
    }
    for (const day of dates.values()) day.sort((a, b) => a.minute - b.minute)
    candlesBySymbol.set(symbol, dates)
  }
  return candlesBySymbol.get(symbol).get(date) || []
}

function outcome(row) {
  const entryMinute = minuteOf(row.entryTime), buy = row.side === "BUY", entry = +row.entryPrice
  const target = entry * (buy ? 1 + TARGET_PCT / 100 : 1 - TARGET_PCT / 100)
  const stop = entry * (buy ? 1 - STOP_PCT / 100 : 1 + STOP_PCT / 100)
  let worstAdversePct = 0
  for (const candle of sessionCandles(row.symbol, row.date)) {
    if (candle.minute < entryMinute || candle.minute > 929) continue
    const adversePct = buy ? 100 * (candle.low / entry - 1) : 100 * (1 - candle.high / entry)
    worstAdversePct = Math.min(worstAdversePct, adversePct)
    const hitStop = buy ? candle.low <= stop : candle.high >= stop
    const hitTarget = buy ? candle.high >= target : candle.low <= target
    if (hitStop) return { winner: false, exitReason: hitTarget ? "STOP_SAME_BAR_AS_TARGET" : "STOP", exitTime: clock(candle.minute), returnPct: -STOP_PCT, maeToExitPct: round(worstAdversePct) }
    if (hitTarget) return { winner: true, exitReason: "TARGET", exitTime: clock(candle.minute), returnPct: TARGET_PCT, maeToExitPct: round(worstAdversePct) }
  }
  return { winner: false, exitReason: "CUTOFF", exitTime: "15:29", returnPct: round(row.returnToCutoffPct), maeToExitPct: round(worstAdversePct) }
}

const rows = rawEvents.map(row => ({ ...row, ...outcome(row) }))
const discoveryPositive = new Set(rows.map((row, index) => row.date === DATE && moverSymbols.has(row.symbol) && row.winner ? index : -1).filter(index => index >= 0))

const numeric = ["minute", "mtfAligned", "signalMoveFromOpenPct", "breakoutDistancePct", "volumeRatio10", "efficiency10"]
const categorical = [["side", "BUY"], ["side", "SELL"], ["family", "OPENING_RANGE_BREAK"], ["family", "PRIOR_LEVEL_BREAK"], ["family", "LEVEL_RETEST"], ["tf10", true]]
const thresholds = new Map(numeric.map(feature => {
  const values = [...new Set(rows.map(row => row[feature]).filter(Number.isFinite))].sort((a, b) => a - b), points = new Set()
  for (let q = .05; q < 1; q += .05) points.add(values[Math.floor((values.length - 1) * q)])
  return [feature, [...points]]
}))
const signature = conditions => conditions.map(x => `${x.feature}${x.op}${x.value}`).join("|")
const stats = indexes => ({ trades: indexes.length, winners: indexes.filter(index => rows[index].winner).length, discoveryWinners: indexes.filter(index => discoveryPositive.has(index)).length })
function candidatesFor(conditions) {
  const output = []
  for (const feature of numeric) for (const value of thresholds.get(feature)) for (const op of [">=", "<="]) {
    const current = conditions.filter(item => item.feature === feature)
    if (current.some(item => item.op === op)) continue
    output.push({ feature, op, value })
  }
  for (const [feature, value] of categorical) if (!conditions.some(item => item.feature === feature)) output.push({ feature, op: "=", value })
  return output
}
function apply(indexes, condition) {
  return indexes.filter(index => {
    const value = rows[index][condition.feature]
    return condition.op === ">=" ? value >= condition.value : condition.op === "<=" ? value <= condition.value : value === condition.value
  })
}
const score = (stat, depth) => stat.trades ? 10_000 * stat.winners / stat.trades + stat.winners * 5 - (stat.trades - stat.winners) * 5 - depth : -Infinity
let frontier = [{ indexes: rows.map((_, index) => index), conditions: [] }], leaves = [], seen = new Set([""])
for (let depth = 1; depth <= 7; depth++) {
  const next = []
  for (const state of frontier) for (const condition of candidatesFor(state.conditions)) {
    const conditions = [...state.conditions, condition].sort((a, b) => `${a.feature}${a.op}`.localeCompare(`${b.feature}${b.op}`)), key = signature(conditions)
    if (seen.has(key)) continue
    seen.add(key)
    const indexes = apply(state.indexes, condition), stat = stats(indexes)
    if (stat.winners < 10 || !stat.discoveryWinners) continue
    const candidate = { indexes, conditions, stat, score: score(stat, depth) }
    if (stat.winners === stat.trades && stat.trades >= 10) leaves.push(candidate)
    next.push(candidate)
  }
  next.sort((a, b) => b.score - a.score || b.stat.winners - a.stat.winners || a.conditions.length - b.conditions.length)
  frontier = next.slice(0, 700)
}
leaves.sort((a, b) => b.stat.trades - a.stat.trades || a.conditions.length - b.conditions.length)
const best = leaves[0] ?? null
const labels = { minute: "signal time", mtfAligned: "MTF aligned frames", signalMoveFromOpenPct: "move from open %", breakoutDistancePct: "breakout distance %", volumeRatio10: "10-bar volume ratio", efficiency10: "10-bar efficiency" }
const format = condition => `${labels[condition.feature] || condition.feature} ${condition.op} ${condition.feature === "minute" ? clock(condition.value) : condition.value}`
const output = {
  generatedAt: new Date().toISOString(), timezone: "Asia/Kolkata", discoveryDate: DATE, movers,
  method: "Causal event features only. Exact one-minute target/stop path uses stop-first handling when both occur within one OHLC candle. This is exploratory in-sample rule discovery.",
  execution: { targetPct: TARGET_PCT, stopPct: STOP_PCT, entry: "next one-minute open" },
  summary: { sessions: reports.length, events: rows.length, discoveryWinnerEvents: discoveryPositive.size, pureLeavesAtLeastTen: leaves.length },
  best: best && { rule: best.conditions.map(format), tradeCount: best.stat.trades, winners: best.stat.winners, losers: best.stat.trades - best.stat.winners, discoveryWinners: best.stat.discoveryWinners, signals: best.indexes.map(index => rows[index]) },
  alternatives: leaves.slice(0, 20).map(item => ({ rule: item.conditions.map(format), trades: item.stat.trades, winners: item.stat.winners, discoveryWinners: item.stat.discoveryWinners })),
}
let suffix = 1, file
do { file = path.join(REPORTS, `${DATE}-mover-exact-stop0p8-research${suffix === 1 ? "" : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`)
console.table([best ? { Trades: best.stat.trades, Winners: best.stat.winners, Losses: best.stat.trades - best.stat.winners, "Discovery winners": best.stat.discoveryWinners, Rule: best.conditions.map(format).join(" AND ") } : { Result: "No causal 10+ winner-only rule found with a -0.80% stop" }])
console.log(`Saved: ${file}`)
