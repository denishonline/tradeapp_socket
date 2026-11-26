// Truly date-causal risk fitting on a precomputed causal signal stream.
// Usage: node scripts/walkforward-ranked-depth-risk.js reports/<ranked-depth-report>.json
// Before each date, train only on completed prior dates; never refit on that date.
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const root = process.cwd(), source = process.argv[2]
if (!source || process.argv.length !== 3) throw new Error("Usage: node scripts/walkforward-ranked-depth-risk.js reports/<ranked-depth-report>.json")
const base = JSON.parse(fs.readFileSync(path.resolve(root, source), "utf8"))
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const pct = (a, b) => 100 * (a / b - 1), round = n => Number.isFinite(n) ? Number(n.toFixed(3)) : null
const riskGrid = [{ stopPct: .4, targetPct: .8 }, { stopPct: .5, targetPct: 1 },
  { stopPct: .6, targetPct: 1.2 }, { stopPct: .75, targetPct: 1.5 },
  { stopPct: .9, targetPct: 1.2 }, { stopPct: 1, targetPct: 1.5 }]
const cache = new Map()
function barsFor(symbol, date) {
  const key = `${symbol}/${date}`
  if (cache.has(key)) return cache.get(key)
  const rows = [], seen = new Set()
  for (const line of fs.readFileSync(path.join(root, "db/candles", `${symbol}.jsonl`), "utf8").split(/\r?\n/)) {
    if (!line) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    const stamp = local(Number(r.time))
    if (stamp.slice(0, 10) !== date || seen.has(stamp) || r.partial) continue
    const [open, high, low, close] = [r.open, r.high, r.low, r.close].map(Number)
    if (![open, high, low, close].every(Number.isFinite) || open <= 0 ||
      high < Math.max(open, close) || low > Math.min(open, close)) continue
    rows.push({ stamp, open, high, low, close }); seen.add(stamp)
  }
  rows.sort((a, b) => a.stamp.localeCompare(b.stamp))
  cache.set(key, rows)
  return rows
}
function exit(signal, risk) {
  const rows = barsFor(signal.symbol, signal.date)
  const index = rows.findIndex(r => r.stamp === signal.entryTime)
  if (index < 0) throw new Error(`Missing entry: ${signal.symbol} ${signal.entryTime}`)
  const entry = rows[index], dir = signal.side === "BUY" ? 1 : -1
  const stop = entry.close * (1 - dir * risk.stopPct / 100)
  const target = entry.close * (1 + dir * risk.targetPct / 100)
  let mae = 0
  for (const r of rows.slice(index + 1)) {
    mae = Math.max(mae, dir > 0 ? 100 * (1 - r.low / entry.close) : pct(r.high, entry.close))
    if (dir > 0 ? r.open <= stop : r.open >= stop) return { exitReason: "stopGap", exitTime: r.stamp,
      returnPct: round(dir * pct(r.open, entry.close)), adverseMovePct: round(mae) }
    const stopped = dir > 0 ? r.low <= stop : r.high >= stop
    const targeted = dir > 0 ? r.high >= target : r.low <= target
    if (stopped || targeted) return { exitReason: stopped ? "stop" : "target", exitTime: r.stamp,
      returnPct: stopped ? -risk.stopPct : risk.targetPct, adverseMovePct: round(mae) }
  }
  return { exitReason: "sessionEnd", exitTime: rows.at(-1).stamp,
    returnPct: round(dir * pct(rows.at(-1).close, entry.close)), adverseMovePct: round(mae) }
}
function summary(rows) {
  const byDay = [...Map.groupBy(rows, x => x.date)].map(([date, trades]) =>
    ({ date, totalReturnPct: round(trades.reduce((s, x) => s + x.returnPct, 0)) }))
  return { tradeCount: rows.length, stops: rows.filter(x => x.exitReason.startsWith("stop")).length,
    nonPositive: rows.filter(x => x.returnPct <= 0).length,
    winRatePct: rows.length ? round(100 * rows.filter(x => x.returnPct > 0).length / rows.length) : null,
    averageReturnPct: rows.length ? round(rows.reduce((s, x) => s + x.returnPct, 0) / rows.length) : null,
    totalReturnPct: round(rows.reduce((s, x) => s + x.returnPct, 0)),
    maximumAdverseExcursionPct: rows.length ? round(Math.max(...rows.map(x => x.adverseMovePct))) : null,
    worstDay: byDay.sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] ?? null }
}
const signals = [], locks = [], groups = [...new Set(base.signals.map(x => `${x.family}/${x.side}`))].sort()
for (const date of base.dates) for (const group of groups) {
  const [family, side] = group.split("/")
  const historical = base.signals.filter(x => x.date < date && x.family === family && x.side === side)
  if (historical.length < 4) { locks.push({ date, group, status: "warmup", priorCount: historical.length }); continue }
  const scored = riskGrid.map(risk => {
    const rows = historical.map(x => ({ ...x, ...exit(x, risk) }))
    const stats = summary(rows), score = stats.averageReturnPct - .12 * stats.nonPositive / rows.length -
      .08 * stats.stops / rows.length
    return { risk, stats, score: round(score) }
  }).sort((a, b) => b.score - a.score || a.risk.stopPct - b.risk.stopPct)
  const best = scored[0], accepted = best.stats.averageReturnPct > .1 && best.stats.winRatePct >= 50 &&
    best.stats.stops / historical.length <= .5
  locks.push({ date, group, status: accepted ? "active" : "inactive", priorCount: historical.length,
    selectedRisk: best.risk, priorMetrics: best.stats })
  if (!accepted) continue
  const current = base.signals.filter(x => x.date === date && x.family === family && x.side === side)
  signals.push(...current.map(x => ({ ...x, ...exit(x, best.risk), trainedStopPct: best.risk.stopPct,
    trainedTargetPct: best.risk.targetPct })))
}
signals.sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const report = { title: "Daily walk-forward risk selection on ranked-depth signals", source,
  rule: "At each session start, require >=4 earlier signals per family/side; select one risk pair by earlier outcomes only. Activate if earlier mean >0.1%, win >=50%, stop fraction <=50%. No current or future day's outcome selects a model. Candidate signal rules themselves are fixed.",
  caveat: "Exploratory. Risk grid and thresholds were designed after examining this research period; no untouched validation. Prior-session comparison and depth rules are causal but historical assumed fills are not guaranteed live. Gross before costs.",
  riskGrid, locks, summary: summary(signals),
  later: summary(signals.filter(x => x.date >= "2026-10-19")),
  byFamily: Object.fromEntries([...new Set(signals.map(x => x.family))].map(f => [f, summary(signals.filter(x => x.family === f))])),
  signals }
const id = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`
const file = path.join(root, "reports", `ranked-depth-daily-walkforward-prior${base.priorSessionsRequired}-${id}.json`)
fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
console.log(JSON.stringify({ file, summary: report.summary, later: report.later, byFamily: report.byFamily }, null, 2))
