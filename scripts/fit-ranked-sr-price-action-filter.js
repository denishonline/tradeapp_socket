#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
const ROOT = process.cwd(), DATES = ["2026-10-26", "2026-10-27", "2026-10-28"], TEST = "2026-10-29"
const read = date => {
  const file = path.join(ROOT, "reports", `${date}-ranked-support-resistance-price-action-signals.csv`)
  const [head, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/), names = head.split(",")
  return lines.map(line => { const x = Object.fromEntries(line.split(",").map((v, i) => [names[i], v])); for (const k of ["score", "relativeVolume", "mtfAligned", "efficiency", "return20Pct", "mae20Pct"]) x[k] = +x[k]; return { ...x, date, retested: x.retested === "true" } })
}
const calibration = DATES.flatMap(read), test = read(TEST)
const family = { ANY: () => true, PRIOR: x => /^(PD|[357]D)/.test(x.level), OPENING: x => x.level.startsWith("OR") }
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1), round = x => Number.isFinite(x) ? +x.toFixed(3) : null
const candidates = []
for (const side of ["BUY", "BOTH"])
for (const minScore of [0, 7, 7.5, 8, 8.5])
for (const minVolume of [0, 1, 1.5, 2])
for (const minMtf of [3, 4, 5])
for (const minEfficiency of [0, 0.25, 0.5, 0.75])
for (const requireRetest of [false, true])
for (const maxCheckpoint of ["09:30", "09:45", "10:00"])
for (const levelFamily of Object.keys(family)) {
  const rule = { side, minScore, minVolume, minMtf, minEfficiency, requireRetest, maxCheckpoint, levelFamily }
  const match = x => (side === "BOTH" || x.side === side) && x.score >= minScore && x.relativeVolume >= minVolume && x.mtfAligned >= minMtf && x.efficiency >= minEfficiency && (!requireRetest || x.retested) && x.checkpoint <= maxCheckpoint && family[levelFamily](x)
  const rows = calibration.filter(match), byDay = DATES.map(date => rows.filter(x => x.date === date))
  if (rows.length < 20 || byDay.some(day => day.length < 5 || mean(day.map(x => x.return20Pct)) <= 0)) continue
  candidates.push({ rule, match, trades: rows.length, winRatePct: round(100 * rows.filter(x => x.return20Pct > 0).length / rows.length), averageReturnPct: round(mean(rows.map(x => x.return20Pct))), averageAfter10bpsPct: round(mean(rows.map(x => x.return20Pct - 0.1))), worstMaePct: round(Math.min(...rows.map(x => x.mae20Pct))), perDay: Object.fromEntries(DATES.map((date, i) => [date, { trades: byDay[i].length, averageReturnPct: round(mean(byDay[i].map(x => x.return20Pct))) }])) })
}
candidates.sort((a, b) => b.averageAfter10bpsPct - a.averageAfter10bpsPct || b.trades - a.trades)
const selected = candidates[0], testRows = selected ? test.filter(selected.match) : []
const report = { protocol: "Fit only 26-28 ranked checkpoint signals. Require >=20 total, >=5 and positive mean on each calibration day. Rank by average fixed 20-minute return after hypothetical 10 bps cost. Test once on 29.", candidateCount: candidates.length, selected: selected && { ...selected, match: undefined }, test: selected ? { trades: testRows.length, winRatePct: round(100 * testRows.filter(x => x.return20Pct > 0).length / (testRows.length || 1)), averageReturnPct: round(mean(testRows.map(x => x.return20Pct))), averageAfter10bpsPct: round(mean(testRows.map(x => x.return20Pct - 0.1))), totalReturnPct: round(testRows.reduce((sum, x) => sum + x.return20Pct, 0)), worstMaePct: testRows.length ? round(Math.min(...testRows.map(x => x.mae20Pct))) : null, rows: testRows } : null, topCandidates: candidates.slice(0, 20).map(x => ({ ...x, match: undefined })) }
const file = path.join(ROOT, "reports", "2026-10-26-to-2026-10-29-ranked-sr-pa-filter-test.json")
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
console.log(JSON.stringify({ file, candidateCount: report.candidateCount, selected: report.selected, test: report.test }, null, 2))
