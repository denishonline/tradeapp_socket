#!/usr/bin/env node

// Research-only loss filter discovery using the exact EMA20/40 live-scanner
// feature set at each completed signal candle. Thresholds are retrospective.
import fs from "node:fs"
import path from "node:path"
import { emaFeatureSet, normalizeStored, prepareEmaEvaluation } from "../ui/live-strategy-scanner.js"

const ROOT = process.cwd()
const reportArg = process.argv.indexOf("--report")
const reportFile = path.resolve(reportArg >= 0 ? process.argv[reportArg + 1] : path.join(ROOT, "reports", "2026-09-01-to-2026-09-30-all-live-strategies-chronological-signals-2.json"))
if (!fs.existsSync(reportFile)) throw new Error(`Report not found: ${reportFile}`)
const round = (value, digits = 7) => Number.isFinite(value) ? +value.toFixed(digits) : null
const keyOf = row => `${row.date}|${row.symbol}|${row.side}|${row.signalTime}`
const minuteOf = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
const read = symbol => {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap(line => {
    try { const row = normalizeStored(JSON.parse(line)); return row ? [row] : [] } catch { return [] }
  }).sort((a, b) => a.time - b.time)
}
const source = JSON.parse(fs.readFileSync(reportFile, "utf8"))
const signals = source.signals.filter(row => row.strategyId === "ema20-40" && Number.isFinite(row.returnPct))
if (!signals.length) throw new Error("No evaluated EMA20/40 signals in the supplied report")
const symbols = [...new Set(signals.map(row => row.symbol))]
const raw = new Map([...symbols, "NIFTY50"].map(symbol => [symbol, read(symbol)]))
const cacheFor = date => {
  const cache = new Map()
  for (const [symbol, rows] of raw) {
    const sessions = [...new Set(rows.filter(row => row.date <= date).map(row => row.date))].sort().slice(-30)
    const included = new Set(sessions)
    cache.set(symbol, rows.filter(row => included.has(row.date)))
  }
  return cache
}
const prepared = new Map()
const rows = []
for (const signal of signals) {
  if (!prepared.has(signal.date)) prepared.set(signal.date, prepareEmaEvaluation(cacheFor(signal.date), symbols, signal.date))
  const frame = prepared.get(signal.date), day = frame.dayBySymbol.get(signal.symbol) ?? []
  const index = day.findIndex(row => row.minute === minuteOf(signal.signalTime))
  if (index < 0) continue
  const direction = signal.side === "BUY" ? 1 : -1
  const all = frame.allBySymbol.get(signal.symbol) ?? []
  const causalAll = all.filter(row => row.date < signal.date || (row.date === signal.date && row.minute <= day[index].minute))
  const causalDay = day.slice(0, index + 1)
  const niftyDay = frame.dayBySymbol.get("NIFTY50") ?? []
  const features = emaFeatureSet(causalAll, causalDay, index, niftyDay, direction, frame.framesBySymbol.get(signal.symbol))
  if (!features) continue
  rows.push({ ...signal, winner: signal.returnPct > 0, features: Object.fromEntries(Object.entries(features).filter(([, value]) => Number.isFinite(value)).map(([name, value]) => [name, round(value)])) })
}
if (rows.length !== signals.length) throw new Error(`Could only rebuild ${rows.length}/${signals.length} live feature snapshots`)

function matches(row, rule) {
  const value = row.features[rule.feature]
  return Number.isFinite(value) && (rule.op === "lt" ? value < rule.threshold : value > rule.threshold)
}
function rulesFor(group) {
  const names = [...new Set(group.flatMap(row => Object.keys(row.features)))].filter(name => group.every(row => Number.isFinite(row.features[name])))
  const atoms = []
  for (const feature of names) {
    const values = [...new Set(group.map(row => row.features[feature]))].sort((a, b) => a - b)
    for (let index = 0; index < values.length - 1; index++) {
      const threshold = round((values[index] + values[index + 1]) / 2)
      for (const op of ["lt", "gt"]) {
        const rejected = group.filter(row => matches(row, { feature, op, threshold }))
        if (rejected.length && !rejected.some(row => row.winner)) atoms.push({ rules: [{ feature, op, threshold }], rejected })
      }
    }
  }
  const candidates = [...atoms]
  for (let left = 0; left < atoms.length; left++) for (let right = left + 1; right < atoms.length; right++) {
    const rejected = group.filter(row => matches(row, atoms[left].rules[0]) && matches(row, atoms[right].rules[0]))
    if (rejected.length && !rejected.some(row => row.winner)) candidates.push({ rules: [...atoms[left].rules, ...atoms[right].rules], rejected })
  }
  const uncovered = new Set(group.filter(row => !row.winner).map(keyOf)), selected = []
  while (uncovered.size) {
    const ranked = candidates.map(candidate => ({ candidate, covered: candidate.rejected.filter(row => uncovered.has(keyOf(row))) })).filter(item => item.covered.length)
      .sort((left, right) => right.covered.length - left.covered.length || left.candidate.rules.length - right.candidate.rules.length)
    if (!ranked.length) break
    selected.push(ranked[0].candidate)
    ranked[0].covered.forEach(row => uncovered.delete(keyOf(row)))
  }
  return { names, selected, uncovered: [...uncovered] }
}

const studies = ["BUY", "SELL"].map(side => {
  const group = rows.filter(row => row.side === side), result = rulesFor(group)
  const rejected = group.filter(row => result.selected.some(candidate => candidate.rules.every(rule => matches(row, rule))))
  const retained = group.filter(row => !rejected.includes(row))
  return { side, clauses: result.selected.map(candidate => ({ rules: candidate.rules, rejectedLosses: candidate.rejected.filter(row => !row.winner).length })), uncoveredLosses: result.uncovered.length, original: { trades: group.length, winners: group.filter(row => row.winner).length, losers: group.filter(row => !row.winner).length }, removed: { trades: rejected.length, winners: rejected.filter(row => row.winner).length, losers: rejected.filter(row => !row.winner).length }, retained: { trades: retained.length, winners: retained.filter(row => row.winner).length, losers: retained.filter(row => !row.winner).length, totalReturnPct: round(retained.reduce((sum, row) => sum + row.returnPct, 0)), averageReturnPct: retained.length ? round(retained.reduce((sum, row) => sum + row.returnPct, 0) / retained.length) : null } }
})
const removed = rows.filter(row => studies.find(study => study.side === row.side).clauses.some(clause => clause.rules.every(rule => matches(row, rule))))
const survivors = rows.filter(row => !removed.includes(row))
const output = { generatedAt: new Date().toISOString(), sourceReport: reportFile, scope: "In-sample causal EMA20/40 live-scanner loss-filter discovery; thresholds are not forward validation.", summary: { inputTrades: rows.length, inputWinners: rows.filter(row => row.winner).length, inputLosers: rows.filter(row => !row.winner).length, retainedTrades: survivors.length, retainedWinners: survivors.filter(row => row.winner).length, retainedLosers: survivors.filter(row => !row.winner).length, retainedWinRatePct: survivors.length ? round(100 * survivors.filter(row => row.winner).length / survivors.length) : null, retainedTotalReturnPct: round(survivors.reduce((sum, row) => sum + row.returnPct, 0)) }, studies, filteredOut: removed.map(row => ({ date: row.date, symbol: row.symbol, side: row.side, signalTime: row.signalTime, returnPct: row.returnPct })), rows }
let suffix = 1, file
do {
  file = path.join(ROOT, "reports", `2026-09-01-to-2026-09-30-ema20-40-live-causal-loss-filter-study${suffix === 1 ? "" : `-${suffix}`}.json`)
  suffix++
} while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
console.log(JSON.stringify({ file, summary: output.summary, studies }, null, 2))
