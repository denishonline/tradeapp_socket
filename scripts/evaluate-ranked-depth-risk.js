// Walk-forward exit audit on the fixed ranked-depth signal stream.
// Usage: node scripts/evaluate-ranked-depth-risk.js reports/<ranked-depth-report>.json
// Fit choices use Oct 6-16 only; Oct 19/21 are evaluated without refitting.
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const root = process.cwd(), source = process.argv[2]
if (!source || process.argv.length !== 3) throw new Error("Usage: node scripts/evaluate-ranked-depth-risk.js reports/<ranked-depth-report>.json")
const base = JSON.parse(fs.readFileSync(path.resolve(root, source), "utf8"))
if (!Array.isArray(base.signals)) throw new Error("Expected ranked depth signal report")
const round = n => Number.isFinite(n) ? Number(n.toFixed(3)) : null
const pct = (a, b) => 100 * (a / b - 1)
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const cache = new Map()
function candles(symbol, date) {
  const key = `${date}/${symbol}`
  if (cache.has(key)) return cache.get(key)
  const rows = [], seen = new Set()
  for (const line of fs.readFileSync(path.join(root, "db/candles", `${symbol}.jsonl`), "utf8").split(/\r?\n/)) {
    if (!line) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const stamp = local(Number(raw.time))
    if (stamp.slice(0, 10) !== date || raw.partial || seen.has(stamp)) continue
    const [open, high, low, close] = [raw.open, raw.high, raw.low, raw.close].map(Number)
    if (![open, high, low, close].every(Number.isFinite) || open <= 0 ||
      high < Math.max(open, close) || low > Math.min(open, close)) continue
    rows.push({ stamp, open, high, low, close }); seen.add(stamp)
  }
  rows.sort((a, b) => a.stamp.localeCompare(b.stamp))
  cache.set(key, rows)
  return rows
}
function exit(signal, stopPct, targetPct) {
  const rows = candles(signal.symbol, signal.date), index = rows.findIndex(x => x.stamp === signal.entryTime)
  if (index < 0) throw new Error(`Entry candle missing ${signal.symbol} ${signal.entryTime}`)
  const entry = rows[index], dir = signal.side === "BUY" ? 1 : -1
  const stop = entry.close * (1 - dir * stopPct / 100), target = entry.close * (1 + dir * targetPct / 100)
  let mae = 0
  for (const bar of rows.slice(index + 1)) {
    mae = Math.max(mae, dir > 0 ? 100 * (1 - bar.low / entry.close) : pct(bar.high, entry.close))
    // A gap through the stop exits at the worse opening price.
    const gapStop = dir > 0 ? bar.open <= stop : bar.open >= stop
    if (gapStop) return { exitReason: "stopGap", exitTime: bar.stamp,
      returnPct: round(dir * pct(bar.open, entry.close)), adverseMovePct: round(mae) }
    const stopHit = dir > 0 ? bar.low <= stop : bar.high >= stop
    const targetHit = dir > 0 ? bar.high >= target : bar.low <= target
    if (stopHit || targetHit) return { exitReason: stopHit ? "stop" : "target", exitTime: bar.stamp,
      returnPct: stopHit ? -stopPct : targetPct, adverseMovePct: round(mae) }
  }
  return { exitReason: "sessionEnd", exitTime: rows.at(-1).stamp,
    returnPct: round(dir * pct(rows.at(-1).close, entry.close)), adverseMovePct: round(mae) }
}
const groups = Map.groupBy(base.signals, x => `${x.family}/${x.side}`)
const riskGrid = [
  { stopPct: .4, targetPct: .8 }, { stopPct: .5, targetPct: 1 },
  { stopPct: .6, targetPct: 1.2 }, { stopPct: .75, targetPct: 1.5 },
  { stopPct: .9, targetPct: 1.2 }, { stopPct: 1, targetPct: 1.5 }
]
const mean = a => a.reduce((s, x) => s + x, 0) / a.length
function summary(rows) {
  const dayTotals = [...Map.groupBy(rows, x => x.date)].map(([date, day]) =>
    ({ date, totalReturnPct: round(day.reduce((s, r) => s + r.returnPct, 0)) }))
  return { tradeCount: rows.length, stops: rows.filter(x => x.exitReason.startsWith("stop")).length,
    nonPositive: rows.filter(x => x.returnPct <= 0).length,
    winRatePct: rows.length ? round(100 * rows.filter(x => x.returnPct > 0).length / rows.length) : null,
    averageReturnPct: rows.length ? round(mean(rows.map(x => x.returnPct))) : null,
    totalReturnPct: round(rows.reduce((s, x) => s + x.returnPct, 0)),
    maximumAdverseExcursionPct: rows.length ? round(Math.max(...rows.map(x => x.adverseMovePct))) : null,
    worstDay: dayTotals.sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] ?? null }
}
const models = [], emitted = []
for (const [group, signals] of groups) {
  const early = signals.filter(x => x.date <= "2026-10-16")
  if (early.length < 4) { models.push({ group, status: "insufficient early trades", earlyCount: early.length }); continue }
  const choices = riskGrid.map(risk => {
    const results = early.map(x => ({ ...x, ...exit(x, risk.stopPct, risk.targetPct) }))
    const stats = summary(results)
    // Penalize both non-positive exits and stops; no later-date labels enter.
    const score = stats.averageReturnPct - .12 * stats.nonPositive / results.length -
      .08 * stats.stops / results.length
    return { ...risk, score: round(score), early: stats }
  }).sort((a, b) => b.score - a.score || a.stopPct - b.stopPct)
  const chosen = choices[0]
  const accepted = chosen.early.averageReturnPct > .1 && chosen.early.winRatePct >= 50 &&
    chosen.early.stops / chosen.early.tradeCount <= .5
  const trades = accepted ? signals.map(x => ({ ...x, ...exit(x, chosen.stopPct, chosen.targetPct),
    trainedStopPct: chosen.stopPct, trainedTargetPct: chosen.targetPct })) : []
  emitted.push(...trades)
  models.push({ group, status: accepted ? "accepted on early-only rule" : "rejected on early-only rule",
    selectedRisk: { stopPct: chosen.stopPct, targetPct: chosen.targetPct },
    early: chosen.early, later: summary(trades.filter(x => x.date >= "2026-10-19")),
    all: summary(trades), choices })
}
emitted.sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const report = { title: "Early-session-only risk selection for ranked depth families", source,
  warning: "Exploratory. This date range and strategy families were previously viewed. Oct 19/21 are not untouched validation. Risk candidates and group acceptance use Oct 6-16 only. Hypothetical before fees/spread/slippage; no live order-fill guarantee.",
  acceptance: "At least four early signals; selected risk with >0.1% early mean return, >=50% early win rate and <=50% early stop fraction. Score penalizes non-positive and stopped early trades. No later results affect choice.",
  riskGrid, baseSummary: base.summary, models, overall: summary(emitted),
  early: summary(emitted.filter(x => x.date <= "2026-10-16")),
  later: summary(emitted.filter(x => x.date >= "2026-10-19")), signals: emitted }
const id = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`
const file = path.join(root, "reports", `ranked-depth-risk-walkforward-${id}.json`)
fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
console.log(JSON.stringify({ file, baseSummary: report.baseSummary,
  accepted: models.filter(x => x.status.startsWith("accepted")).map(x => ({ group: x.group,
    selectedRisk: x.selectedRisk, early: x.early, later: x.later })),
  overall: report.overall, early: report.early, later: report.later }, null, 2))
