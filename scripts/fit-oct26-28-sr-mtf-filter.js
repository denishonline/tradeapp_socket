#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), REPORTS = path.join(ROOT, "reports")
const CALIBRATION = ["2026-10-26", "2026-10-27", "2026-10-28"]
const TEST = "2026-10-29"
const round = (x, n = 3) => Number.isFinite(x) ? Number(x.toFixed(n)) : null
const minute = text => { const [h, m] = text.split(":").map(Number); return h * 60 + m }
const unique = stem => { let n = 1, file; do { file = path.join(REPORTS, `${stem}${n === 1 ? "" : `-${n}`}.json`); n++ } while (fs.existsSync(file)); return file }

function latest(date) {
  const prefix = `${date}-top-movers-support-resistance-price-action-mtf-universe-first-signal`
  return fs.readdirSync(REPORTS).filter(name => name.startsWith(prefix) && name.endsWith(".csv"))
    .map(name => path.join(REPORTS, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
}
function read(date) {
  const file = latest(date), [head, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/), names = head.split(",")
  return lines.map(line => {
    const raw = Object.fromEntries(line.split(",").map((value, i) => [names[i], value]))
    for (const key of ["mtfAligned", "signalMoveFromOpenPct", "breakoutDistancePct", "volumeRatio10", "efficiency10", "return20Pct", "mfe20Pct", "mae20Pct", "returnToCutoffPct"]) raw[key] = Number(raw[key])
    return { ...raw, date, signalMinute: minute(raw.signalTime), correctTargetDirection: raw.correctTargetDirection === "true" }
  }).filter(row => Number.isFinite(row.return20Pct))
}
const calibration = CALIBRATION.flatMap(read), test = read(TEST)
const familySets = {
  ANY: () => true,
  BREAK: row => row.family !== "LEVEL_RETEST",
  RETEST: row => row.family === "LEVEL_RETEST",
  PRIOR: row => row.level === "PDH" || row.level === "PDL" || /^[357]D[HL]$/.test(row.level),
  OPENING: row => row.level.startsWith("OR"),
}
function matches(row, rule) {
  return (rule.side === "BOTH" || row.side === rule.side) && row.mtfAligned >= rule.minMtf && row.signalMoveFromOpenPct >= rule.minMove &&
    row.breakoutDistancePct >= rule.minBreakout && row.volumeRatio10 >= rule.minVolume && row.efficiency10 >= rule.minEfficiency &&
    row.signalMinute <= rule.maxMinute && familySets[rule.family](row)
}
function metrics(rows) {
  const returns = rows.map(x => x.return20Pct), perDay = Object.fromEntries([...new Set(rows.map(x => x.date))].map(date => {
    const day = rows.filter(x => x.date === date), values = day.map(x => x.return20Pct)
    return [date, { trades: day.length, averageReturnPct: round(values.reduce((a, b) => a + b, 0) / (values.length || 1)), winRatePct: round(100 * values.filter(x => x > 0).length / (values.length || 1), 2) }]
  }))
  return {
    trades: rows.length, winRatePct: round(100 * returns.filter(x => x > 0).length / (returns.length || 1), 2),
    averageReturnPct: round(returns.reduce((a, b) => a + b, 0) / (returns.length || 1)), totalReturnPct: round(returns.reduce((a, b) => a + b, 0)),
    averageAfter10bpsPct: round(returns.reduce((a, b) => a + b - 0.1, 0) / (returns.length || 1)),
    maximumAdverseExcursionPct: rows.length ? round(Math.min(...rows.map(x => x.mae20Pct))) : null,
    perDay,
  }
}

const candidates = []
for (const side of ["BUY", "BOTH"])
for (const minMtf of [3, 4, 5])
for (const minMove of [0, 0.5, 1, 1.5, 2])
for (const minBreakout of [0, 0.1, 0.25, 0.5])
for (const minVolume of [0, 0.75, 1, 1.5, 2])
for (const minEfficiency of [0, 0.25, 0.5, 0.75])
for (const maxMinute of [570, 585, 600, 630])
for (const family of Object.keys(familySets)) {
  const rule = { side, minMtf, minMove, minBreakout, minVolume, minEfficiency, maxMinute, family }
  const rows = calibration.filter(row => matches(row, rule)), result = metrics(rows)
  const dayValues = CALIBRATION.map(date => result.perDay[date] || { trades: 0, averageReturnPct: -Infinity })
  if (result.trades < 30 || dayValues.some(x => x.trades < 8 || x.averageReturnPct <= 0)) continue
  candidates.push({ rule, calibration: result })
}
candidates.sort((a, b) => b.calibration.averageAfter10bpsPct - a.calibration.averageAfter10bpsPct || b.calibration.trades - a.calibration.trades)
const selected = candidates[0] || null
const testRows = selected ? test.filter(row => matches(row, selected.rule)) : []
const report = {
  protocol: "Threshold grid fitted only on 26-28 October universe first-signals. Minimum 30 trades, at least 8 trades and positive mean 20-minute return on every calibration day. Rank by mean 20-minute return after a hypothetical 10 bps cost. 29 October is untouched test. One first directional signal per stock; entry next 1-minute open.",
  calibrationFiles: Object.fromEntries(CALIBRATION.map(date => [date, latest(date)])), testFile: latest(TEST),
  candidateCount: candidates.length,
  selected,
  test: selected ? { metrics: metrics(testRows), namedMoverCorrectDirection: testRows.filter(x => x.correctTargetDirection).length, rows: testRows } : null,
  topCandidates: candidates.slice(0, 20),
}
const output = unique("2026-10-26-to-2026-10-29-sr-mtf-prior-fit-test")
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
console.log(JSON.stringify({ output, candidateCount: candidates.length, selected: selected?.rule, calibration: selected?.calibration, test: report.test && { metrics: report.test.metrics, namedMoverCorrectDirection: report.test.namedMoverCorrectDirection, symbols: testRows.map(x => `${x.symbol}:${x.side}`) } }, null, 2))
