#!/usr/bin/env node
// Research-only: fits causal, signal-time rejection clauses. Do not copy these
// clauses into the live scanner unless the untouched period is acceptable.
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), REPORTS = path.join(ROOT, "reports")
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] }
const source = arg("--report")
const fitThrough = arg("--fit-through") ?? "2026-10-22"
if (!source) throw new Error("Usage: node scripts/research-sr-mtf-fitted-loss-policy.js --report reports/<sr-mtf-report>.json [--fit-through YYYY-MM-DD]")

const reportPath = path.resolve(source)
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null
const minute = value => { const [hour, mins] = String(value).split(":").map(Number); return hour * 60 + mins }
const keyOf = row => `${row.date}|${row.symbol}|${row.side}|${row.signalTime}`
const isWinner = row => row.returnPct > 0
const features = ["signalMoveFromOpenPct", "breakoutDistancePct", "volumeRatio10", "efficiency10", "minute"]

const rows = (report.signals ?? [])
  .filter(row => row.strategyId === "sr-mtf" && Number.isFinite(row.returnPct))
  .map(row => ({ ...row, minute: minute(row.signalTime), winner: isWinner(row) }))
if (!rows.length) throw new Error("The report contains no evaluated S/R MTF signals.")
if (rows.some(row => features.some(feature => !Number.isFinite(row[feature])))) {
  throw new Error("The report needs S/R diagnostic fields. Re-run scan-all-live-strategies after the diagnostic update.")
}

const fit = rows.filter(row => row.date <= fitThrough), test = rows.filter(row => row.date > fitThrough)
if (!fit.some(row => !row.winner) || !fit.some(row => row.winner)) throw new Error("Calibration period must contain both winners and losers.")

const atom = (label, feature, test) => ({ label, features: new Set([feature]), test })
const atoms = []
for (const feature of features) {
  for (const value of [...new Set(fit.map(row => row[feature]))].sort((left, right) => left - right)) {
    atoms.push(atom(`${feature} <= ${value}`, feature, row => row[feature] <= value))
    atoms.push(atom(`${feature} >= ${value}`, feature, row => row[feature] >= value))
  }
}
for (const feature of ["side", "setup", "mtfAligned"]) {
  for (const value of [...new Set(fit.map(row => row[feature]))]) {
    atoms.push(atom(`${feature} = ${value}`, feature, row => row[feature] === value))
  }
}

function candidate(rules) {
  const rejected = fit.filter(row => rules.every(rule => rule.test(row)))
  if (!rejected.length || rejected.some(row => row.winner)) return null
  return { rules, rejected, lossKeys: new Set(rejected.filter(row => !row.winner).map(keyOf)) }
}

const candidates = []
for (let left = 0; left < atoms.length; left++) {
  const one = candidate([atoms[left]])
  if (one) candidates.push(one)
  for (let right = left + 1; right < atoms.length; right++) {
    if (atoms[left].features.has([...atoms[right].features][0])) continue
    const two = candidate([atoms[left], atoms[right]])
    if (two) candidates.push(two)
  }
}
const unique = new Map()
for (const item of candidates) {
  const identity = [...item.lossKeys].sort().join("|")
  if (!unique.has(identity) || unique.get(identity).rules.length > item.rules.length) unique.set(identity, item)
}

const uncovered = new Set(fit.filter(row => !row.winner).map(keyOf)), clauses = []
while (uncovered.size) {
  const ranked = [...unique.values()].map(item => ({ item, covered: [...item.lossKeys].filter(key => uncovered.has(key)) }))
    .filter(item => item.covered.length)
    .sort((left, right) => right.covered.length - left.covered.length || left.item.rules.length - right.item.rules.length)
  if (!ranked.length) break
  const selected = ranked[0]
  clauses.push(selected.item)
  for (const key of selected.covered) uncovered.delete(key)
}

const rejects = row => clauses.some(clause => clause.rules.every(rule => rule.test(row)))
function summary(input) {
  const rejected = input.filter(rejects), retained = input.filter(row => !rejects(row))
  const metrics = values => ({
    trades: values.length,
    winners: values.filter(row => row.winner).length,
    losers: values.filter(row => !row.winner).length,
    totalReturnPct: round(values.reduce((sum, row) => sum + row.returnPct, 0)),
  })
  return { original: metrics(input), rejected: metrics(rejected), retained: metrics(retained), rejectedRows: rejected.map(row => ({ date: row.date, symbol: row.symbol, side: row.side, signalTime: row.signalTime, returnPct: row.returnPct })) }
}

const output = {
  warning: "Outcome-fitted research only. Every clause uses data available at the signal candle, but the clauses were selected after observing returns.",
  sourceReport: reportPath,
  calibration: { through: fitThrough, ...summary(fit) },
  untouchedLaterDates: { after: fitThrough, ...summary(test) },
  uncoveredCalibrationLosses: [...uncovered],
  clauses: clauses.map((clause, index) => ({
    id: index + 1,
    whenAll: clause.rules.map(rule => rule.label),
    calibrationLossesRemoved: clause.rejected.filter(row => !row.winner).map(row => ({ date: row.date, symbol: row.symbol, returnPct: row.returnPct })),
  })),
}
let suffix = 1, file
do { file = path.join(REPORTS, `sr-mtf-fitted-loss-policy-through-${fitThrough}${suffix === 1 ? "" : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
console.log(JSON.stringify({ file, calibration: output.calibration, untouchedLaterDates: output.untouchedLaterDates, clauses: output.clauses, uncoveredCalibrationLosses: output.uncoveredCalibrationLosses }, null, 2))
