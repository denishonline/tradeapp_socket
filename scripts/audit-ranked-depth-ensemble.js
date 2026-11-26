// Deterministic union of the three prior-session variants' early-fitted models.
// Usage: node scripts/audit-ranked-depth-ensemble.js <prior2-risk.json> <prior3-risk.json> <prior5-risk.json>
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const root = process.cwd(), files = process.argv.slice(2)
if (files.length !== 3) throw new Error("Pass three risk reports in prior2, prior3, prior5 order")
const reports = files.map(file => JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8")))
const dailyWalkforward = reports.every(report => Array.isArray(report.locks))
const round = x => Number.isFinite(x) ? Number(x.toFixed(3)) : null
const completedAt = candleLabel => new Date(Date.parse(`${candleLabel.replace(" ", "T")}:00+05:30`) +
  60_000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const all = reports.flatMap((report, index) => report.signals.map(signal => ({ ...signal, priorWindow: [2, 3, 5][index] })))
all.sort((a, b) => a.signalTime.localeCompare(b.signalTime) ||
  [3, 2, 5].indexOf(a.priorWindow) - [3, 2, 5].indexOf(b.priorWindow) || a.symbol.localeCompare(b.symbol))
const seen = new Set(), signals = []
for (const row of all) {
  const key = `${row.date}/${row.symbol}`
  if (seen.has(key)) continue
  seen.add(key); signals.push(row)
}
for (const [index, row] of signals.entries()) {
  if (row.priorSessions < row.priorWindow || row.depth?.directionalSharePct < 52 ||
    row.depth?.directionalMidpointPct < 0 ||
    Date.parse(`${row.entryTime.replace(" ", "T")}:00+05:30`) -
      Date.parse(`${row.signalTime.replace(" ", "T")}:00+05:30`) !== 60_000 ||
    (index > 0 && signals[index - 1].signalTime > row.signalTime)) {
    throw new Error(`Causality/order invariant failed for ${row.date} ${row.symbol}`)
  }
}
function summary(rows) {
  const days = [...Map.groupBy(rows, x => x.date)].map(([date, day]) => ({ date,
    totalReturnPct: round(day.reduce((s, x) => s + x.returnPct, 0)) }))
  return { tradeCount: rows.length, stops: rows.filter(x => x.exitReason.startsWith("stop")).length,
    nonPositive: rows.filter(x => x.returnPct <= 0).length,
    winRatePct: rows.length ? round(100 * rows.filter(x => x.returnPct > 0).length / rows.length) : null,
    averageReturnPct: rows.length ? round(rows.reduce((s, x) => s + x.returnPct, 0) / rows.length) : null,
    totalReturnPct: round(rows.reduce((s, x) => s + x.returnPct, 0)),
    maximumAdverseExcursionPct: rows.length ? round(Math.max(...rows.map(x => x.adverseMovePct))) : null,
    worstDay: days.sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] ?? null }
}
const output = { title: dailyWalkforward ? "Union of daily walk-forward prior2/3/5 ranked depth models" :
    "Union of prior2/3/5 ranked depth models fitted only through Oct16",
  rule: "Merge emitted signals chronologically; only first signal per stock per session. Same-minute duplicate priority prior3, prior2, prior5. No future outcome determines signal inclusion. The component scans themselves cap each family at two per day. Candle timestamps label minute starts: signal is known one minute later and next-candle close entry one further minute later.",
  warning: dailyWalkforward ? "Each component chooses its risk settings from prior sessions only. This union was proposed after variant results were viewed, so it is still exploratory and not independent validation or production-ready. Costs and slippage omitted." :
    "This union was proposed after prior variant results were viewed. It is exploratory, not a frozen independent validation or production-ready trading system. Costs and live slippage omitted.",
  components: files, overlapRemoved: all.length - signals.length,
  checkedInvariants: ["signal order", "one stock per session", "exactly next one-minute entry candle",
    "complete prior-session reference", "five-minute directional depth threshold and midpoint"],
  overall: summary(signals), early: summary(signals.filter(x => x.date <= "2026-10-16")),
  later: summary(signals.filter(x => x.date >= "2026-10-19")),
  byFamily: Object.fromEntries([...new Set(signals.map(x => x.family))].map(f => [f, summary(signals.filter(x => x.family === f))])),
  signals }
const id = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`
const file = path.join(root, "reports", `ranked-depth-ensemble-audit-${id}.json`)
fs.writeFileSync(file, JSON.stringify(output, null, 2) + "\n", { flag: "wx" })
const csvFile = path.join(root, "csv", `ranked-depth-ensemble-audit-${id}-signals.csv`)
const columns = ["date", "signalTime", "signalKnownAt", "entryTime", "entryKnownAt", "symbol", "side", "family", "priorWindow",
  "trainedStopPct", "trainedTargetPct", "rank", "rvol5", "priorSessions", "dayMovePct",
  "move5Pct", "move15Pct", "signalVolumeMultiple", "directionalSharePct",
  "directionalMidpointPct", "exitTime", "exitReason", "returnPct", "adverseMovePct"]
const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`
fs.writeFileSync(csvFile, [columns.map(quote).join(","), ...signals.map(row => {
  const flat = { ...row, ...row.depth, signalKnownAt: completedAt(row.signalTime),
    entryKnownAt: completedAt(row.entryTime) }
  return columns.map(column => quote(flat[column])).join(",")
})].join("\n") + "\n", { flag: "wx" })
console.log(JSON.stringify({ file, csvFile, overlapRemoved: output.overlapRemoved, overall: output.overall,
  early: output.early, later: output.later, byFamily: output.byFamily }, null, 2))
