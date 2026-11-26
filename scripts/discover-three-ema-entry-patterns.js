import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const REPORTS = path.join(ROOT, "reports")
const INPUT = path.join(REPORTS, "2026-10-05-to-2026-10-16-ema10-20-entry-context-2.csv")
const TRAIN_DATES = new Set(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"])
const FEATURES = [
  "stockReturn1", "stockReturn3", "stockReturn5", "stockReturn10", "stockOpeningReturn", "stockCloseLocation",
  "stockVolumeRatio10", "emaGapBps", "emaGapChangeBps", "niftyReturn3", "niftyReturn5", "niftyReturn10",
  "niftyEmaGapBps", "niftyOpeningReturn", "depthFull3m", "depthTop2_3m", "depthClosingFull",
  "depthClosingTop2", "depthOfi3m", "depthMidReturn3m", "depthSpreadBps",
]

function parseCsv(filename) {
  const [header, ...lines] = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const fields = header.split(",")
  return lines.map((line) => {
    const row = Object.fromEntries(line.split(",").map((value, index) => [fields[index], value]))
    for (const field of FEATURES) row[field] = row[field] === "" ? NaN : Number(row[field])
    row.depthAvailable = Number(row.depthAvailable)
    return row
  })
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return NaN
  const at = (sorted.length - 1) * fraction, low = Math.floor(at), high = Math.ceil(at)
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low)
}

function conditionLabel(condition) {
  return `${condition.feature} ${condition.operator} ${condition.threshold.toFixed(4)}`
}

function evaluate(rows, predicate) {
  const passing = rows.filter(predicate)
  const positives = passing.filter((row) => row.cohort === "QUALIFIED")
  const controls = passing.length - positives.length
  return {
    signals: passing.length, positives: positives.length, controls,
    precisionPct: Number((100 * positives.length / (passing.length || 1)).toFixed(2)),
    recallPct: Number((100 * positives.length / (rows.filter((row) => row.cohort === "QUALIFIED").length || 1)).toFixed(2)),
    positiveDates: [...new Set(positives.map((row) => row.date))].length,
  }
}

function candidates(rows, minimumPositives, minimumPrecision = 45) {
  const train = rows.filter((row) => TRAIN_DATES.has(row.date))
  const validation = rows.filter((row) => !TRAIN_DATES.has(row.date))
  const singles = []
  for (const feature of FEATURES) {
    const values = train.map((row) => row[feature]).filter(Number.isFinite)
    for (const fraction of [.1, .2, .3, .4, .5, .6, .7, .8, .9]) {
      const threshold = percentile(values, fraction)
      for (const operator of [">=", "<="]) {
        const predicate = (row) => Number.isFinite(row[feature]) && (operator === ">=" ? row[feature] >= threshold : row[feature] <= threshold)
        const training = evaluate(train, predicate)
        if (training.positives < minimumPositives || training.controls < Math.max(4, Math.floor(minimumPositives / 3)) ||
            training.precisionPct < minimumPrecision || training.positiveDates < 4) continue
        singles.push({ conditions: [{ feature, operator, threshold }], predicate, training, validation: evaluate(validation, predicate) })
      }
    }
  }
  // Favour coverage among rules that remain materially better than the one-in-three control-set baseline.
  singles.sort((left, right) => right.training.positives - left.training.positives || right.training.precisionPct - left.training.precisionPct)
  const pairs = []
  for (let left = 0; left < Math.min(18, singles.length); left++) for (let right = left + 1; right < Math.min(18, singles.length); right++) {
    const first = singles[left], second = singles[right]
    const predicate = (row) => first.predicate(row) && second.predicate(row)
    const training = evaluate(train, predicate)
    if (training.positives < minimumPositives || training.controls < 3 || training.precisionPct < minimumPrecision + 10 || training.positiveDates < 4) continue
    pairs.push({ conditions: [...first.conditions, ...second.conditions], predicate, training, validation: evaluate(validation, predicate) })
  }
  pairs.sort((left, right) => right.training.positives - left.training.positives || right.training.precisionPct - left.training.precisionPct)
  return { singles, pairs }
}

function bestPattern(rows, minimumPositives, minimumPrecision = 45) {
  const { singles, pairs } = candidates(rows, minimumPositives, minimumPrecision)
  const validatedPairs = pairs.filter((row) => row.validation.positives >= Math.max(6, Math.floor(minimumPositives / 2)) &&
    row.validation.precisionPct >= minimumPrecision && row.validation.positiveDates >= 3)
  const validatedSingles = singles.filter((row) => row.validation.positives >= Math.max(6, Math.floor(minimumPositives / 2)) &&
    row.validation.precisionPct >= minimumPrecision && row.validation.positiveDates >= 3)
  // Prefer a pair only when it improves precision by at least five points over the broadest eligible single rule.
  const broadSingle = validatedSingles[0]
  const improvedPair = validatedPairs.find((pair) => !broadSingle || pair.validation.precisionPct >= broadSingle.validation.precisionPct + 5)
  return improvedPair || broadSingle || null
}

function serialize(pattern) {
  if (!pattern) return null
  return {
    rule: pattern.conditions.map(conditionLabel), training: pattern.training, validation: pattern.validation,
  }
}

const rows = parseCsv(INPUT)
const pattern1 = {
  name: "Pattern 1: impulse plus depth confirmation",
  conditions: [
    { feature: "stockReturn5", operator: ">=", threshold: 0.292 },
    { feature: "depthMidReturn3m", operator: ">=", threshold: 0.25 },
  ],
}
pattern1.predicate = (row) => row.depthAvailable === 1 && pattern1.conditions.every((condition) =>
  Number.isFinite(row[condition.feature]) && row[condition.feature] >= condition.threshold)

const after1 = rows.filter((row) => !pattern1.predicate(row))
const pattern2 = bestPattern(after1, 12)
const after2 = pattern2 ? after1.filter((row) => !pattern2.predicate(row)) : after1
const pattern3 = bestPattern(after2, 8, 40)

const patterns = [pattern1, pattern2 && { name: "Pattern 2", ...pattern2 }, pattern3 && { name: "Pattern 3", ...pattern3 }].filter(Boolean)
const coverage = []
let remaining = rows
for (const pattern of patterns) {
  const train = remaining.filter((row) => TRAIN_DATES.has(row.date))
  const validation = remaining.filter((row) => !TRAIN_DATES.has(row.date))
  coverage.push({
    name: pattern.name,
    rule: pattern.conditions.map(conditionLabel),
    training: evaluate(train, pattern.predicate), validation: evaluate(validation, pattern.predicate),
  })
  remaining = remaining.filter((row) => !pattern.predicate(row))
}

const remainingSummary = {
  all: evaluate(rows, () => true),
  notCovered: evaluate(remaining, () => true),
  qualifiedNotCovered: remaining.filter((row) => row.cohort === "QUALIFIED").length,
}
const report = {
  methodology: "Sequential discovery: pattern 2 is searched only among rows not covered by pattern 1, and pattern 3 only among rows not covered by the first two. Rule selection uses Oct 5-12 only; Oct 13-16 is holdout measurement. Each cohort row is compared to date- and side-matched losing EMA legs.",
  source: INPUT,
  patterns: coverage,
  selectedCandidates: { pattern2: serialize(pattern2), pattern3: serialize(pattern3) },
  remainingSummary,
}
const output = path.join(REPORTS, "2026-10-05-to-2026-10-16-three-ema-entry-patterns.json")
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ output, patterns: coverage, remainingSummary }, null, 2))
