import fs from "node:fs"

const source = "csv/2026-10-05-to-14-fast-scalp-candidates.csv"
const [head, ...lines] = fs.readFileSync(source, "utf8").trim().split(/\r?\n/)
const fields = head.split(",")
const rows = lines.map((line, id) => ({ id, ...Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])) }))
const num = (row, field) => row[field] === "" || row[field] == null ? NaN : Number(row[field])
const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
for (const row of rows) row.setupMinute = minute(row.setupTime)
const train = rows.filter((row) => row.date <= "2026-10-09")
const validation = rows.filter((row) => row.date >= "2026-10-12" && row.date <= "2026-10-13")
const holdout = rows.filter((row) => row.date === "2026-10-14")

const predicates = [
  { label: "branch = opening", test: (row) => row.branch === "opening" },
  { label: "branch = intraday", test: (row) => row.branch === "intraday" },
]
const add = (feature, direction, thresholds) => thresholds.forEach((threshold) => predicates.push({
  label: `${feature} ${direction} ${threshold}`,
  test: (row) => Number.isFinite(num(row, feature)) && (direction === ">=" ? num(row, feature) >= threshold : num(row, feature) <= threshold),
}))
const both = (feature, lows, highs) => { add(feature, ">=", lows); add(feature, "<=", highs) }
both("setupMinute", [556, 570, 600, 630, 660, 690, 720, 750, 780, 810], [556, 570, 600, 630, 660, 690, 720, 750, 780, 810, 840])
both("candleReturnPct", [0, .05, .1, .15, .2, .25, .3, .4, .5], [.05, .1, .15, .2, .3, .4, .5, .7])
both("closeLocationPct", [60, 70, 75, 80, 85, 90, 95], [70, 80, 90, 95])
add("upperWickPct", "<=", [5, 10, 15, 20, 25])
both("volumeRatio10", [.7, 1, 1.2, 1.5, 2, 3], [1, 1.5, 2, 3, 5])
for (const feature of ["return3Pct", "return10Pct", "return30Pct", "dayReturnPct", "vwapGapPct", "recoveryLowPct"]) both(feature, [0, .1, .2, .3, .5, .75, 1], [.2, .3, .5, .75, 1, 1.5, 2, 3])
add("belowHighPct", "<=", [.1, .2, .3, .5, .75, 1])
both("updates", [10, 15, 20, 30, 50, 75], [15, 20, 30, 50, 75, 100])
add("maxGapSec", "<=", [2, 4, 6, 8, 10])
both("avgBidPct", [35, 40, 45, 50, 55, 60], [40, 45, 50, 55, 60, 65])
both("bidDominantPct", [20, 30, 40, 50, 60, 70], [30, 40, 50, 60, 70])
both("ofi", [0, .03, .05, .1, .15, .2, .3], [.05, .1, .2, .3])
both("deltaPct", [0, 15, 25, 40, 50, 60], [25, 40, 50, 60, 75])
both("depthPricePct", [.1, .15, .2, .25, .3, .4], [.2, .3, .4, .5, .7])
both("midReturnPct", [.1, .15, .2, .25, .3, .4], [.2, .3, .4, .5, .7])
add("spreadPct", "<=", [.03, .04, .05, .06, .08, .1])
both("gapPct", [-1, -.5, 0, .5], [-.5, 0, .5, 1])
both("prior30ReturnPct", [-.5, 0, .1], [0, .1, .25, .5])
for (const feature of ["confirmCandleReturnPct", "confirmMidReturnPct"]) both(feature, [0, .05, .1, .15, .2, .3], [.1, .2, .3, .4, .5])
both("confirmVolumeRatio10", [.7, 1, 1.2, 1.5, 2], [1, 1.5, 2, 3])
both("confirmAvgBidPct", [35, 40, 45, 50, 55, 60], [40, 45, 50, 55, 60, 65])
both("confirmOfi", [0, .03, .05, .1, .15], [.05, .1, .2, .3])
both("confirmDeltaPct", [0, 15, 25, 40, 50], [25, 40, 50, 60, 75])
both("breadthPositivePct", [30, 40, 50, 60, 70, 75, 80], [40, 50, 60, 70, 80, 90])
both("breadthAbove05Pct", [10, 20, 30, 40, 50], [10, 20, 30, 40, 50, 60])
both("breadthReturn3PositivePct", [40, 50, 60, 70], [40, 50, 60, 70, 80])

const masks = predicates.map((predicate) => ({ ...predicate,
  train: train.map(predicate.test), validation: validation.map(predicate.test), holdout: holdout.map(predicate.test) }))
function stats(dataset, mask) {
  const selected = dataset.filter((_, index) => mask[index])
  const targets = selected.filter((row) => row.quick06Outcome === "Target").length
  const stops = selected.filter((row) => row.quick06Outcome === "Stop").length
  const timed = selected.filter((row) => row.quick06Outcome === "Timed").length
  const pending = selected.filter((row) => row.quick06Outcome === "Pending").length
  return { signals: selected.length, targets, stops, timed, pending,
    rate: selected.length ? targets / selected.length : 0,
    targetDays: new Set(selected.filter((row) => row.quick06Outcome === "Target").map((row) => row.date)).size,
    rows: selected }
}
function keyOf(indices) { return indices.join("-") }
function compatible(indices, candidate) {
  const labels = [...indices, candidate].map((index) => predicates[index].label)
  if (labels.includes("branch = opening") && labels.includes("branch = intraday")) return false
  return true
}
function evaluate(indices) {
  const trainMask = train.map((_, rowIndex) => indices.every((index) => masks[index].train[rowIndex]))
  const validationMask = validation.map((_, rowIndex) => indices.every((index) => masks[index].validation[rowIndex]))
  const ts = stats(train, trainMask), vs = stats(validation, validationMask)
  const combinedSignals = ts.signals + vs.signals, targets = ts.targets + vs.targets
  const failures = ts.stops + ts.timed + vs.stops + vs.timed
  const score = targets * 20 + (ts.targetDays + vs.targetDays) * 8 - failures * 22 - indices.length * 2
  return { indices, trainMask, validationMask, train: ts, validation: vs, score, combinedSignals, targets, failures }
}
let beam = []
for (let index = 0; index < predicates.length; index++) beam.push(evaluate([index]))
beam = beam.filter((rule) => rule.targets >= 2).sort((a, b) => b.score - a.score).slice(0, 500)
const all = [...beam]
for (let depth = 2; depth <= 5; depth++) {
  const next = new Map()
  for (const parent of beam) {
    const start = parent.indices.at(-1) + 1
    for (let candidate = start; candidate < predicates.length; candidate++) {
      if (!compatible(parent.indices, candidate)) continue
      const rule = evaluate([...parent.indices, candidate])
      if (rule.targets < 3 || rule.train.signals > 250 || rule.validation.signals > 180) continue
      const key = keyOf(rule.indices)
      const existing = next.get(key)
      if (!existing || rule.score > existing.score) next.set(key, rule)
    }
  }
  beam = [...next.values()].sort((a, b) => b.score - a.score).slice(0, 500)
  all.push(...beam)
  process.stderr.write(`depth ${depth}: ${beam.length} rules\n`)
}
const finalists = all.filter((rule) => rule.train.targets >= 2 && rule.train.targetDays >= 2 &&
  rule.validation.targets >= 1 && rule.validation.targetDays >= 1 && rule.failures <= 25 &&
  (rule.train.signals + rule.validation.signals) >= 4)
  .sort((a, b) => (b.targets / b.combinedSignals) - (a.targets / a.combinedSignals) ||
    a.failures - b.failures || b.targets - a.targets || b.score - a.score)
  .slice(0, 100)
const output = finalists.map((rule) => {
  const holdMask = holdout.map((_, rowIndex) => rule.indices.every((index) => masks[index].holdout[rowIndex]))
  const hs = stats(holdout, holdMask)
  return { rules: rule.indices.map((index) => predicates[index].label),
    train: { signals: rule.train.signals, targets: rule.train.targets, stops: rule.train.stops, timed: rule.train.timed, targetDays: rule.train.targetDays },
    validation: { signals: rule.validation.signals, targets: rule.validation.targets, stops: rule.validation.stops, timed: rule.validation.timed, targetDays: rule.validation.targetDays },
    holdout: { signals: hs.signals, targets: hs.targets, stops: hs.stops, timed: hs.timed, pending: hs.pending,
      rows: hs.rows.map((row) => ({ symbol: row.symbol, signalTime: row.quickSignalTime, outcome: row.quick06Outcome, resolvedAt: row.quick06ResolvedAt, returnPct: row.quick06ReturnPct })) } }
})
fs.writeFileSync("csv/2026-10-05-to-14-fast-scalp-rule-search.json", JSON.stringify({ source, predicates: predicates.length, finalists: output }, null, 2) + "\n")
console.log(JSON.stringify({ predicates: predicates.length, finalists: output.length, top: output.slice(0, 20) }, null, 2))
