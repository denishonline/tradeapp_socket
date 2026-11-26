#!/usr/bin/env node

// Exploratory causal-feature search. Every candidate condition is known at the
// completed signal candle. Labels are only used to evaluate the frozen rule.
// A “winner” requires that a +1.10% target was reachable without the observed
// path ever touching a -1.30% stop; no symbol or date predicates are allowed.

import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), REPORTS = path.join(ROOT, "reports")
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] }
const DATE = arg("--discovery-date") ?? "2026-10-05"
if (!/^2026-(?:09|10)-\d{2}$/.test(DATE)) throw new Error("--discovery-date must use a September or October 2026 NSE date")
const STOP_PCT = Number(arg("--stop") ?? 1.3)
if (!(STOP_PCT > 0)) throw new Error("--stop must be positive")
const minutes = value => +value.slice(0, 2) * 60 + +value.slice(3)
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const IST_MS = 330 * 60_000
const candleCache = new Map()

function latestUniverseReports() {
  const latest = new Map()
  for (const name of fs.readdirSync(REPORTS)) {
    const match = /^(2026-(?:09|10)-\d\d)-top-movers-support-resistance-price-action-mtf-universe-first-signal(?:-\d+)?\.json$/.exec(name)
    if (!match) continue
    const file = path.join(REPORTS, name), stat = fs.statSync(file), prior = latest.get(match[1])
    if (!prior || stat.mtimeMs > prior.mtimeMs) latest.set(match[1], { file, mtimeMs: stat.mtimeMs })
  }
  return [...latest.entries()].filter(([date]) => date >= "2026-09-01" && date <= "2026-10-30").sort(([a], [b]) => a.localeCompare(b))
}

function topMovers() {
  const results = []
  for (const file of fs.readdirSync(path.join(ROOT, "db", "candles"))) {
    if (!file.endsWith(".jsonl") || file === "NIFTY50.jsonl") continue
    const day = fs.readFileSync(path.join(ROOT, "db", "candles", file), "utf8").split(/\r?\n/).flatMap(line => {
      try {
        if (!line) return []
        const row = JSON.parse(line), stamp = new Date(+row.time * 1000 + IST_MS).toISOString(), marketMinute = +stamp.slice(11, 13) * 60 + +stamp.slice(14, 16)
        return stamp.slice(0, 10) === DATE && marketMinute >= 555 && marketMinute < 930 ? [row] : []
      } catch { return [] }
    }).sort((left, right) => left.time - right.time)
    if (day.length < 300 || !(+day[0].open > 0) || !Number.isFinite(+day.at(-1).close)) continue
    results.push({ symbol: file.slice(0, -6), intradayMovePct: round(100 * (+day.at(-1).close / +day[0].open - 1)) })
  }
  results.sort((left, right) => right.intradayMovePct - left.intradayMovePct)
  return { gainers: results.slice(0, 10), losers: results.slice(-10).reverse() }
}

const movers = topMovers()
if (movers.gainers.length < 10 || movers.losers.length < 10) throw new Error(`No complete NSE candle session is available for ${DATE}`)
const discoverySymbols = new Set([...movers.gainers, ...movers.losers].map(row => row.symbol))
const reports = latestUniverseReports()
const rows = reports.flatMap(([date, item]) => {
  const trades = JSON.parse(fs.readFileSync(item.file, "utf8")).trades || []
  return trades.map(row => ({ ...row, date, minute: minutes(row.signalTime), winner: row.mfePct >= 1.1 && row.maePct > -STOP_PCT }))
})
const discoveryPositive = new Set(rows.map((row, index) => row.date === DATE && discoverySymbols.has(row.symbol) && row.winner ? index : -1).filter(index => index >= 0))

const numeric = [
  ["minute", "signal time"], ["mtfAligned", "MTF aligned frames"], ["signalMoveFromOpenPct", "move from open %"],
  ["breakoutDistancePct", "breakout distance %"], ["volumeRatio10", "10-bar volume ratio"], ["efficiency10", "10-bar efficiency"],
]
const categorical = [
  ["side", "BUY"], ["side", "SELL"], ["family", "OPENING_RANGE_BREAK"], ["family", "PRIOR_LEVEL_BREAK"], ["family", "LEVEL_RETEST"], ["tf10", true],
]
const all = rows.map((_, index) => index)
const count = indexes => ({ trades: indexes.length, winners: indexes.filter(index => rows[index].winner).length, discoveryWinners: indexes.filter(index => discoveryPositive.has(index)).length })
const signature = conditions => conditions.map(condition => `${condition.feature}${condition.op}${condition.value}`).join("|")

function thresholds(feature) {
  const values = [...new Set(rows.map(row => row[feature]).filter(Number.isFinite))].sort((a, b) => a - b)
  if (!values.length) return []
  const points = new Set()
  for (let q = .05; q < 1; q += .05) points.add(values[Math.floor((values.length - 1) * q)])
  return [...points]
}
const thresholdsByFeature = new Map(numeric.map(([feature]) => [feature, thresholds(feature)]))

function allowed(condition, constraints) {
  const same = constraints.filter(item => item.feature === condition.feature)
  if (!same.length) return true
  if (["side", "family", "tf10"].includes(condition.feature)) return false
  // Allow one lower and one upper range bound, never duplicate a direction.
  return !same.some(item => item.op === condition.op)
}

function nextConditions(state) {
  const output = []
  for (const [feature] of numeric) for (const value of thresholdsByFeature.get(feature)) {
    for (const op of [">=", "<="]) {
      const condition = { feature, op, value }
      if (allowed(condition, state.conditions)) output.push(condition)
    }
  }
  for (const [feature, value] of categorical) {
    const condition = { feature, op: "=", value }
    if (allowed(condition, state.conditions)) output.push(condition)
  }
  return output
}

function apply(indexes, condition) {
  return indexes.filter(index => {
    const value = rows[index][condition.feature]
    return condition.op === ">=" ? value >= condition.value : condition.op === "<=" ? value <= condition.value : value === condition.value
  })
}

function score(stat, depth) {
  const losses = stat.trades - stat.winners
  if (!losses && stat.trades >= 10 && stat.discoveryWinners) return 1_000_000 + stat.trades * 1_000 - depth
  return stat.trades ? 1_000 * stat.winners / stat.trades + Math.min(stat.winners, 25) - losses * 2 - depth : -Infinity
}

let frontier = [{ indexes: all, conditions: [] }], leaves = []
const seen = new Set([""])
for (let depth = 1; depth <= 6; depth++) {
  const next = []
  for (const state of frontier) for (const condition of nextConditions(state)) {
    const conditions = [...state.conditions, condition].sort((a, b) => `${a.feature}${a.op}`.localeCompare(`${b.feature}${b.op}`))
    const key = signature(conditions)
    if (seen.has(key)) continue
    seen.add(key)
    const indexes = apply(state.indexes, condition), stat = count(indexes)
    if (stat.winners < 10 || !stat.discoveryWinners) continue
    const candidate = { indexes, conditions, stat, score: score(stat, depth) }
    if (stat.winners === stat.trades && stat.trades >= 10) leaves.push(candidate)
    next.push(candidate)
  }
  next.sort((a, b) => b.score - a.score || b.stat.winners - a.stat.winners || a.conditions.length - b.conditions.length)
  frontier = next.slice(0, 400)
}

leaves = leaves.sort((a, b) => b.stat.trades - a.stat.trades || a.conditions.length - b.conditions.length)
const best = leaves[0] ?? null
const formatCondition = condition => {
  const label = Object.fromEntries(numeric)[condition.feature] || condition.feature
  const value = condition.feature === "minute" ? `${String(Math.floor(condition.value / 60)).padStart(2, "0")}:${String(condition.value % 60).padStart(2, "0")}` : condition.value
  return `${label} ${condition.op} ${value}`
}
const formatClock = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`

// Wider, pre-declared windows are searched without a minute predicate. This
// checks whether causal price/volume filters can preserve the result once the
// original 09:44–09:51 restriction is deliberately relaxed.
function pureLeavesForWindow(startMinute, endMinute) {
  let windowFrontier = [{ indexes: all.filter(index => rows[index].minute >= startMinute && rows[index].minute <= endMinute), conditions: [] }]
  const windowLeaves = [], windowSeen = new Set([""])
  for (let depth = 1; depth <= 6; depth++) {
    const next = []
    for (const state of windowFrontier) for (const condition of nextConditions(state).filter(item => item.feature !== "minute")) {
      const conditions = [...state.conditions, condition].sort((a, b) => `${a.feature}${a.op}`.localeCompare(`${b.feature}${b.op}`))
      const key = signature(conditions)
      if (windowSeen.has(key)) continue
      windowSeen.add(key)
      const indexes = apply(state.indexes, condition), stat = count(indexes)
      if (stat.winners < 10 || !stat.discoveryWinners) continue
      const candidate = { indexes, conditions, stat, score: score(stat, depth) }
      if (stat.winners === stat.trades && stat.trades >= 10) windowLeaves.push(candidate)
      next.push(candidate)
    }
    next.sort((a, b) => b.score - a.score || b.stat.winners - a.stat.winners || a.conditions.length - b.conditions.length)
    windowFrontier = next.slice(0, 400)
  }
  return windowLeaves.sort((a, b) => b.stat.trades - a.stat.trades || a.conditions.length - b.conditions.length)[0] ?? null
}

const widerWindows = [
  [570, 600], // 09:30–10:00
  [575, 605], // 09:35–10:05
  [580, 610], // 09:40–10:10
  [585, 615], // 09:45–10:15
].map(([startMinute, endMinute]) => {
  const candidate = pureLeavesForWindow(startMinute, endMinute)
  return {
    window: `${formatClock(startMinute)}–${formatClock(endMinute)}`,
    best: candidate && {
      rule: candidate.conditions.map(formatCondition), trades: candidate.stat.trades, winners: candidate.stat.winners,
      losses: candidate.stat.trades - candidate.stat.winners, discoveryWinners: candidate.stat.discoveryWinners,
    },
  }
})

function sessionCandles(symbol, date) {
  const key = `${symbol}|${date}`
  if (candleCache.has(key)) return candleCache.get(key)
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  const candles = fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap(line => {
    try {
      if (!line) return []
      const row = JSON.parse(line), timestamp = +row.time * 1000
      const stamp = new Date(timestamp + IST_MS).toISOString()
      if (stamp.slice(0, 10) !== date) return []
      return [{ minute: +stamp.slice(11, 13) * 60 + +stamp.slice(14, 16), high: +row.high, low: +row.low }]
    } catch { return [] }
  }).sort((left, right) => left.minute - right.minute)
  candleCache.set(key, candles)
  return candles
}

function targetExit(row) {
  const entryMinute = minutes(row.entryTime), buy = row.side === "BUY"
  const targetPrice = row.entryPrice * (buy ? 1.011 : .989), stopPrice = row.entryPrice * (buy ? 1 - STOP_PCT / 100 : 1 + STOP_PCT / 100)
  for (const candle of sessionCandles(row.symbol, row.date).filter(candle => candle.minute >= entryMinute)) {
    const stop = buy ? candle.low <= stopPrice : candle.high >= stopPrice
    const target = buy ? candle.high >= targetPrice : candle.low <= targetPrice
    if (stop) return { targetPrice: round(targetPrice), stopPrice: round(stopPrice), exitTime: `${String(Math.floor(candle.minute / 60)).padStart(2, "0")}:${String(candle.minute % 60).padStart(2, "0")}`, exitReason: target ? "STOP_SAME_BAR_AS_TARGET" : "STOP", returnPct: -1.3 }
    if (target) return { targetPrice: round(targetPrice), stopPrice: round(stopPrice), exitTime: `${String(Math.floor(candle.minute / 60)).padStart(2, "0")}:${String(candle.minute % 60).padStart(2, "0")}`, exitReason: "TARGET", returnPct: 1.1 }
  }
  return { targetPrice: round(targetPrice), stopPrice: round(stopPrice), exitTime: null, exitReason: "CUTOFF", returnPct: round(row.returnToCutoffPct) }
}

const bestSignals = best?.indexes.map(index => ({ ...rows[index], ...targetExit(rows[index]) })) ?? []
const output = {
  generatedAt: new Date().toISOString(), timezone: "Asia/Kolkata",
  methodology: `Greedy pure-leaf search over causal S/R event features only. Outcomes are evaluated using full intraday OHLC after the signal: MFE >= 1.10% and MAE > -${STOP_PCT.toFixed(2)}%. The search uses the complete historical period, so any selected rule is exploratory in-sample research and requires forward testing before live use.`,
  discoveryDate: DATE,
  targetPct: 1.1,
  stopPct: STOP_PCT,
  movers,
  summary: { sessions: reports.length, events: rows.length, discoveryTopMoverWinnerEvents: discoveryPositive.size, pureLeavesAtLeastTen: leaves.length },
  best: best && {
    rule: best.conditions.map(formatCondition), tradeCount: best.stat.trades, winners: best.stat.winners, losers: best.stat.trades - best.stat.winners,
    discoveryWinners: best.stat.discoveryWinners,
    signals: bestSignals,
  },
  alternatives: leaves.slice(0, 20).map(item => ({ rule: item.conditions.map(formatCondition), trades: item.stat.trades, winners: item.stat.winners, discoveryWinners: item.stat.discoveryWinners })),
  widerWindows,
}
let suffix = 1, file
do { file = path.join(REPORTS, `${DATE}-mover-causal-pure-leaf-research-stop${String(STOP_PCT).replace(".", "p")}${suffix === 1 ? "" : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`)
console.table([...movers.gainers.map(row => ({ Group: "Gainer", Symbol: row.symbol, "Move %": row.intradayMovePct })), ...movers.losers.map(row => ({ Group: "Loser", Symbol: row.symbol, "Move %": row.intradayMovePct }))])
console.table([best ? { Trades: best.stat.trades, Winners: best.stat.winners, Losers: best.stat.trades - best.stat.winners, "Discovery winners": best.stat.discoveryWinners, Rule: best.conditions.map(formatCondition).join(" AND ") } : { Result: "No pure 10+ signal leaf found" }])
console.log(`Saved: ${file}`)
