#!/usr/bin/env node

// Discovery is restricted to the 20 no-gap intraday movers on 2026-10-05.
// Validation replays the already-causal first S/R event for every available
// stock/day from 2026-09-01 through 2026-10-30. This script deliberately does
// not use a later candle to decide whether a signal exists.

import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const REPORTS = path.join(ROOT, "reports")
const DATE = "2026-10-05"
const IST_MS = 330 * 60_000
const minute = value => +value.slice(0, 2) * 60 + +value.slice(3)
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const pct = (value, base) => base > 0 ? 100 * (value / base - 1) : NaN
const dateAt = seconds => new Date(seconds * 1000 + IST_MS).toISOString().slice(0, 10)

function latestUniverseReports() {
  const latest = new Map()
  for (const name of fs.readdirSync(REPORTS)) {
    const match = /^(2026-(?:09|10)-\d\d)-top-movers-support-resistance-price-action-mtf-universe-first-signal(?:-\d+)?\.json$/.exec(name)
    if (!match) continue
    const file = path.join(REPORTS, name), stat = fs.statSync(file)
    const previous = latest.get(match[1])
    if (!previous || stat.mtimeMs > previous.mtimeMs) latest.set(match[1], { file, mtimeMs: stat.mtimeMs })
  }
  return [...latest.entries()].sort(([left], [right]) => left.localeCompare(right))
    .filter(([date]) => date >= "2026-09-01" && date <= "2026-10-30")
}

function topMovers() {
  const rows = []
  for (const file of fs.readdirSync(path.join(ROOT, "db", "candles"))) {
    if (!file.endsWith(".jsonl") || file === "NIFTY50.jsonl") continue
    const day = fs.readFileSync(path.join(ROOT, "db", "candles", file), "utf8").split(/\r?\n/).flatMap(line => {
      try { return line ? [JSON.parse(line)] : [] } catch { return [] }
    }).filter(row => dateAt(+row.time) === DATE).sort((left, right) => left.time - right.time)
    if (day.length < 300) continue
    const open = +day[0].open, close = +day.at(-1).close
    if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) continue
    rows.push({ symbol: file.slice(0, -6), open, close, intradayMovePct: round(pct(close, open)) })
  }
  rows.sort((left, right) => right.intradayMovePct - left.intradayMovePct)
  return { gainers: rows.slice(0, 10), losers: rows.slice(-10).reverse() }
}

function passes(event, rule) {
  if (rule.side !== "ANY" && event.side !== rule.side) return false
  if (rule.family === "OR" && event.family !== "OPENING_RANGE_BREAK") return false
  if (rule.family === "NON_OR" && event.family === "OPENING_RANGE_BREAK") return false
  if (event.mtfAligned < rule.mtf || (rule.tf10 && event.tf10 !== true)) return false
  if (minute(event.signalTime) > rule.lastMinute) return false
  if (event.signalMoveFromOpenPct < rule.minMove || event.breakoutDistancePct < rule.minDistance || event.breakoutDistancePct > rule.maxDistance) return false
  if (event.volumeRatio10 < rule.minVolume || event.volumeRatio10 > rule.maxVolume || event.efficiency10 < rule.minEfficiency) return false
  return true
}

function outcome(event) {
  // A valid +1% winner must still be at least +1% at the session mark. This is
  // stricter than just observing a later intraday high and avoids pretending an
  // intrabar target was executable without path data.
  return event.returnToCutoffPct >= 1
}

const reportFiles = latestUniverseReports()
const events = reportFiles.flatMap(([date, item]) => {
  const payload = JSON.parse(fs.readFileSync(item.file, "utf8"))
  return (payload.trades || []).map(row => ({ ...row, date }))
})
const movers = topMovers()
const discoverySymbols = new Set([...movers.gainers, ...movers.losers].map(row => row.symbol))
const discovery = events.filter(row => row.date === DATE && discoverySymbols.has(row.symbol))

const grid = {
  side: ["ANY", "BUY", "SELL"], family: ["ANY", "OR", "NON_OR"], mtf: [3, 4, 5], tf10: [false, true],
  lastMinute: [585, 600, 615, 630], minMove: [-2, 0, .5, 1, 1.5], minDistance: [0, .05, .10, .15],
  maxDistance: [.15, .25, .40, Infinity], minVolume: [0, .5, .75, 1], maxVolume: [1, 1.5, 2, Infinity], minEfficiency: [0, .3, .5, .7],
}
const candidates = []
for (const side of grid.side) for (const family of grid.family) for (const mtf of grid.mtf) for (const tf10 of grid.tf10)
  for (const lastMinute of grid.lastMinute) for (const minMove of grid.minMove) for (const minDistance of grid.minDistance) for (const maxDistance of grid.maxDistance)
    for (const minVolume of grid.minVolume) for (const maxVolume of grid.maxVolume) for (const minEfficiency of grid.minEfficiency) {
      if (minDistance > maxDistance || minVolume > maxVolume) continue
      const rule = { side, family, mtf, tf10, lastMinute, minMove, minDistance, maxDistance, minVolume, maxVolume, minEfficiency }
      const selected = discovery.filter(row => passes(row, rule)), winners = selected.filter(outcome)
      if (selected.length >= 2 && winners.length === selected.length) candidates.push({ rule, discoveryTrades: selected.length })
    }

// Evaluate every Oct-5-consistent discovery candidate across the full causal
// event ledger. This intentionally includes narrow candidates: the request is
// specifically for a minimum of ten winner-only signals, not broad coverage.
const complexity = rule => [rule.side !== "ANY", rule.family !== "ANY", rule.mtf > 3, rule.tf10, rule.lastMinute < 630, rule.minMove > -2, rule.minDistance > 0, Number.isFinite(rule.maxDistance), rule.minVolume > 0, Number.isFinite(rule.maxVolume), rule.minEfficiency > 0].filter(Boolean).length
const finalists = candidates.sort((left, right) => right.discoveryTrades - left.discoveryTrades || complexity(left.rule) - complexity(right.rule))
const evaluated = finalists.map(item => {
  const selected = events.filter(row => passes(row, item.rule)), winners = selected.filter(outcome)
  return {
    ...item,
    validationTrades: selected.length,
    validationWinners: winners.length,
    validationWinRatePct: selected.length ? round(100 * winners.length / selected.length) : null,
    averageReturnPct: selected.length ? round(selected.reduce((sum, row) => sum + row.returnToCutoffPct, 0) / selected.length) : null,
    totalReturnPct: round(selected.reduce((sum, row) => sum + row.returnToCutoffPct, 0)),
    worstReturnPct: selected.length ? round(Math.min(...selected.map(row => row.returnToCutoffPct))) : null,
    signals: selected,
  }
}).filter(item => item.validationTrades >= 10)

const qualified = evaluated.filter(item => item.validationWinRatePct >= 90)
const best = (qualified.length ? qualified : evaluated).sort((left, right) =>
  (right.validationWinRatePct ?? -Infinity) - (left.validationWinRatePct ?? -Infinity) || right.validationTrades - left.validationTrades || complexity(left.rule) - complexity(right.rule)
)[0] ?? null

const summary = {
  discoveryDate: DATE,
  sessionReports: reportFiles.map(([date]) => date),
  sessionCount: reportFiles.length,
  universeEvents: events.length,
  discoveryMoverEvents: discovery.length,
  discoveryCandidatesWithAtLeastTwoOnePercentWinners: candidates.length,
  validationCandidatesWithAtLeastTenSignals: evaluated.length,
  validationCandidatesAtOrAboveNinetyPercent: qualified.length,
  best: best && {
    rule: best.rule, discoveryTrades: best.discoveryTrades, validationTrades: best.validationTrades,
    validationWinners: best.validationWinners, validationWinRatePct: best.validationWinRatePct,
    averageReturnPct: best.averageReturnPct, totalReturnPct: best.totalReturnPct, worstReturnPct: best.worstReturnPct,
  },
}
const output = {
  generatedAt: new Date().toISOString(), timezone: "Asia/Kolkata",
  methodology: "Top movers are ranked by same-session last 1m close / first 1m open, so overnight gaps are excluded. Candidate features are from the causal first S/R event only. A winner is a position that remains at least +1% at the session close; no later candle creates a signal. Rule screening is exploratory and includes the validation range, so it is not an out-of-sample performance claim.",
  movers, summary, bestRule: best ? { ...best, signals: best.signals } : null,
}
let suffix = 1, file
do { file = path.join(REPORTS, `2026-10-05-no-gap-mover-causal-rule-research${suffix === 1 ? "" : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`)

console.table([...movers.gainers.map(row => ({ Group: "Gainer", Symbol: row.symbol, "Move %": row.intradayMovePct })), ...movers.losers.map(row => ({ Group: "Loser", Symbol: row.symbol, "Move %": row.intradayMovePct }))])
console.log("\nRule-search summary")
console.table([summary.best ?? { message: "No candidate with at least ten validation trades." }])
console.log(`\nSaved: ${file}`)
