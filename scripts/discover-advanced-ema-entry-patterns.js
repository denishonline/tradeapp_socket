import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), REPORTS = path.join(ROOT, "reports")
const INPUT = path.join(REPORTS, "2026-10-05-to-2026-10-16-advanced-ema-entry-context.csv")
const OUTPUT = path.join(REPORTS, "2026-10-05-to-2026-10-16-advanced-three-ema-entry-patterns.json")
const TRAIN = new Set(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"])

function parse() {
  const [header, ...lines] = fs.readFileSync(INPUT, "utf8").trim().split(/\r?\n/), fields = header.split(",")
  const features = fields.filter((field) => /^(stock|nifty|depth|ema)/.test(field) && !["depthAvailable", "depthSamples3m", "depthLastAgeSec"].includes(field))
  const rows = lines.map((line) => {
    const row = Object.fromEntries(line.split(",").map((value, index) => [fields[index], value]))
    for (const feature of features) row[feature] = row[feature] === "" ? NaN : Number(row[feature])
    row.depthAvailable = Number(row.depthAvailable)
    return row
  })
  return { rows, features }
}
function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return NaN
  const index = (sorted.length - 1) * fraction, low = Math.floor(index), high = Math.ceil(index)
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}
function evaluate(rows, predicate) {
  const passing = rows.filter(predicate), positives = passing.filter((row) => row.cohort === "QUALIFIED")
  return { signals: passing.length, positives: positives.length, controls: passing.length - positives.length,
    precisionPct: Number((100 * positives.length / (passing.length || 1)).toFixed(2)),
    recallPct: Number((100 * positives.length / (rows.filter((row) => row.cohort === "QUALIFIED").length || 1)).toFixed(2)),
    positiveDates: [...new Set(positives.map((row) => row.date))].length }
}
function label(condition) { return `${condition.feature} ${condition.operator} ${condition.threshold.toFixed(4)}` }

function findRule(rows, features, minimumPositives, minPrecision) {
  const train = rows.filter((row) => TRAIN.has(row.date)), validation = rows.filter((row) => !TRAIN.has(row.date)), singles = []
  for (const feature of features) {
    const values = train.map((row) => row[feature]).filter(Number.isFinite)
    for (const fraction of [.1, .2, .3, .4, .5, .6, .7, .8, .9]) for (const operator of [">=", "<="]) {
      const threshold = percentile(values, fraction)
      const predicate = (row) => Number.isFinite(row[feature]) && (operator === ">=" ? row[feature] >= threshold : row[feature] <= threshold)
      const training = evaluate(train, predicate), holdout = evaluate(validation, predicate)
      if (training.positives < minimumPositives || training.controls < 4 || training.precisionPct < minPrecision || training.positiveDates < 4 ||
          holdout.positives < Math.max(5, Math.floor(minimumPositives / 2)) || holdout.controls < 3 || holdout.precisionPct < minPrecision || holdout.positiveDates < 3) continue
      singles.push({ conditions: [{ feature, operator, threshold }], predicate, training, validation: holdout })
    }
  }
  // Choose from discovery only: coverage first, then precision. Holdout is solely an eligibility check.
  singles.sort((a, b) => b.training.positives - a.training.positives || b.training.precisionPct - a.training.precisionPct)
  const pairs = []
  for (let left = 0; left < Math.min(24, singles.length); left++) for (let right = left + 1; right < Math.min(24, singles.length); right++) {
    const first = singles[left], second = singles[right]
    if (first.conditions[0].feature === second.conditions[0].feature) continue
    const predicate = (row) => first.predicate(row) && second.predicate(row)
    const training = evaluate(train, predicate), holdout = evaluate(validation, predicate)
    if (training.positives < minimumPositives || training.controls < 3 || training.precisionPct < minPrecision + 8 || training.positiveDates < 4 ||
        holdout.positives < Math.max(5, Math.floor(minimumPositives / 2)) || holdout.controls < 3 || holdout.precisionPct < minPrecision || holdout.positiveDates < 3) continue
    pairs.push({ conditions: [...first.conditions, ...second.conditions], predicate, training, validation: holdout })
  }
  pairs.sort((a, b) => b.training.positives - a.training.positives || b.training.precisionPct - a.training.precisionPct)
  const wideSingle = singles[0], improvedPair = pairs.find((pair) => !wideSingle || pair.training.precisionPct >= wideSingle.training.precisionPct + 6)
  return improvedPair || wideSingle || null
}

const { rows, features } = parse()
const pattern1 = {
  name: "Pattern 1: impulse plus depth confirmation",
  conditions: [{ feature: "stockReturn5", operator: ">=", threshold: .292 }, { feature: "depthMidReturn3m", operator: ">=", threshold: .25 }],
}
pattern1.predicate = (row) => row.depthAvailable === 1 && row.stockReturn5 >= .292 && row.depthMidReturn3m >= .25
const residual1 = rows.filter((row) => !pattern1.predicate(row))
const pattern2 = findRule(residual1, features, 12, 45)
const residual2 = pattern2 ? residual1.filter((row) => !pattern2.predicate(row)) : residual1
const pattern3 = findRule(residual2, features, 8, 40)
const residual3 = pattern3 ? residual2.filter((row) => !pattern3.predicate(row)) : residual2
const pattern4 = findRule(residual3, features, 6, 37)
const residual4 = pattern4 ? residual3.filter((row) => !pattern4.predicate(row)) : residual3
const pattern5 = findRule(residual4, features, 4, 35)
const patterns = [
  pattern1,
  pattern2 && { name: "Pattern 2", ...pattern2 },
  pattern3 && { name: "Pattern 3", ...pattern3 },
  pattern4 && { name: "Pattern 4", ...pattern4 },
  pattern5 && { name: "Pattern 5", ...pattern5 },
].filter(Boolean)
let remaining = rows
const results = patterns.map((pattern) => {
  const result = { name: pattern.name, rule: pattern.conditions.map(label),
    training: evaluate(remaining.filter((row) => TRAIN.has(row.date)), pattern.predicate),
    validation: evaluate(remaining.filter((row) => !TRAIN.has(row.date)), pattern.predicate) }
  remaining = remaining.filter((row) => !pattern.predicate(row))
  return result
})
const report = {
  methodology: "Causal advanced-indicator search. Indicators use candle data completed by crossover close; multi-timeframe bars are used only after their entire interval has closed. Cash-depth flow uses snapshots received no later than crossover close. Patterns are selected sequentially from Oct 5-12 and must meet the stated Oct 13-16 holdout minimum.",
  featuresTested: features, patterns: results,
  totalQualified: rows.filter((row) => row.cohort === "QUALIFIED").length,
  qualifiedNotCovered: remaining.filter((row) => row.cohort === "QUALIFIED").length,
  residualPrecisionPct: evaluate(remaining, () => true).precisionPct,
}
fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ output: OUTPUT, patterns: results, totalQualified: report.totalQualified, qualifiedNotCovered: report.qualifiedNotCovered }, null, 2))
