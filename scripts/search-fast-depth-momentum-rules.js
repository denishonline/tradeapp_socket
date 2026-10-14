import fs from "node:fs"

const source = "csv/2026-10-05-to-14-fast-depth-momentum-candidates-breadth.csv"
const [header, ...lines] = fs.readFileSync(source, "utf8").trim().split(/\r?\n/)
const fields = header.split(",")
const rows = lines.map((line, id) => ({ id, ...Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])) }))
const num = (row, field) => row[field] === "" || row[field] == null ? NaN : Number(row[field])
const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
for (const row of rows) row.signalMinute = minute(row.signalTime)
const train = rows.filter((row) => row.date <= "2026-10-09")
const validation = rows.filter((row) => row.date >= "2026-10-12" && row.date <= "2026-10-13")
const holdout = rows.filter((row) => row.date === "2026-10-14")

const predicates = []
const add = (feature, direction, thresholds) => thresholds.forEach((threshold) => predicates.push({
  label: `${feature} ${direction} ${threshold}`,
  test: (row) => Number.isFinite(num(row, feature)) && (direction === ">=" ? num(row, feature) >= threshold : num(row, feature) <= threshold),
}))
const both = (feature, lower, upper) => { add(feature, ">=", lower); add(feature, "<=", upper) }
add("signalMinute", ">=", [570, 585, 600, 630, 660, 690, 720, 750])
add("signalMinute", "<=", [570, 585, 600, 630, 660, 690, 720, 750, 780, 810])
add("candleReturnPct", ">=", [.05, .08, .1, .12, .15, .2, .25, .3, .4, .5])
add("candleReturnPct", "<=", [.15, .2, .25, .3, .4, .5, .7])
add("closeLocationPct", ">=", [60, 65, 70, 75, 80, 85, 90, 95])
add("upperWickPct", "<=", [5, 10, 15, 20, 25, 30])
add("volumeRatio10", ">=", [.8, 1, 1.2, 1.5, 2, 2.5, 3, 4])
add("rangeRatio10", ">=", [.8, 1, 1.2, 1.5, 2, 2.5, 3])
add("volumeTrend3", ">=", [.8, 1, 1.2, 1.5, 2])
for (const feature of ["return2Pct", "return3Pct", "return5Pct", "return10Pct", "return30Pct", "dayReturnPct", "vwapGapPct"]) {
  add(feature, ">=", [.05, .1, .15, .2, .3, .4, .5, .75, 1, 1.5])
  add(feature, "<=", [.3, .5, .75, 1, 1.5, 2, 3])
}
both("breakout5Pct", [-.1, 0, .05, .1, .15, .2], [.1, .2, .3, .5, .75])
both("breakout10Pct", [-.1, 0, .05, .1, .15, .2], [.1, .2, .3, .5, .75])
add("green3", ">=", [2, 3]); add("green5", ">=", [3, 4, 5])
add("updates", ">=", [12, 15, 20, 30, 50, 75])
add("maxGapSec", "<=", [2, 4, 6, 8, 10, 12])
both("avgBidPct", [35, 40, 45, 50, 55, 60], [40, 45, 50, 55, 60, 65])
add("bidDominantPct", ">=", [20, 30, 40, 50, 60, 70])
both("ofi", [-.1, -.05, 0, .03, .05, .1, .15, .2, .3], [.05, .1, .2, .3])
both("deltaPct", [-25, 0, 15, 25, 40, 50, 60], [25, 40, 50, 60, 75])
add("depthPricePct", ">=", [.03, .05, .08, .1, .15, .2, .25, .3])
add("midReturnPct", ">=", [.03, .05, .08, .1, .15, .2, .25, .3])
add("spreadPct", "<=", [.03, .04, .05, .06, .08, .1])
add("depthPositiveMid3", ">=", [2, 3]); add("depthPositiveOfi3", ">=", [1, 2, 3]); add("depthBidDominant3", ">=", [1, 2, 3])
both("depthAvgBid3", [40, 45, 50, 55, 60], [45, 50, 55, 60, 65])
both("depthAvgOfi3", [-.05, 0, .03, .05, .1, .15], [.05, .1, .2])
both("depthAvgDelta3", [-10, 0, 10, 20, 30, 40], [20, 30, 40, 50, 60])
add("previousMidReturnPct", ">=", [0, .03, .05, .1, .15])
add("previousOfi", ">=", [-.05, 0, .03, .05, .1])
both("breadthPositivePct", [30, 40, 50, 60, 70, 80], [40, 50, 60, 70, 80, 90])
both("breadthReturn3PositivePct", [30, 40, 50, 60, 70], [40, 50, 60, 70, 80])
both("breadthReturn5PositivePct", [30, 40, 50, 60, 70], [40, 50, 60, 70, 80])
both("breadthAverageReturnPct", [-.5, -.25, 0, .1, .25, .5], [0, .1, .25, .5, .75, 1])
both("breadthAverage3Pct", [-.2, -.1, 0, .05, .1, .2], [0, .05, .1, .2, .3])
both("breadthAverage5Pct", [-.3, -.2, -.1, 0, .1, .2], [0, .1, .2, .3, .5])
both("breadthPositiveChange5", [-20, -10, -5, 0, 5, 10], [-10, -5, 0, 5, 10, 20])
both("breadthAverageChange5", [-.2, -.1, -.05, 0, .05, .1], [-.1, -.05, 0, .05, .1, .2])
add("dayReturnRankPct", ">=", [50, 60, 70, 80, 90])
add("return3RankPct", ">=", [50, 60, 70, 80, 90])

function resultStats(dataset, ids) {
  const selected = ids.map((id) => dataset[id])
  const resolved = selected.filter((row) => row.outcome05 !== "Pending")
  const targets = resolved.filter((row) => row.outcome05 === "Target").length
  const stops = resolved.filter((row) => row.outcome05 === "Stop").length
  const timed = resolved.filter((row) => row.outcome05 === "Timed").length
  const net = resolved.reduce((sum, row) => sum + num(row, "return05"), 0)
  return { signals: resolved.length, targets, stops, timed, net, average: resolved.length ? net / resolved.length : 0,
    targetRate: resolved.length ? targets / resolved.length : 0,
    days: new Set(resolved.map((row) => row.date)).size,
    targetDays: new Set(resolved.filter((row) => row.outcome05 === "Target").map((row) => row.date)).size,
    rows: resolved }
}

const masks = predicates.map((predicate) => ({
  train: train.map(predicate.test), validation: validation.map(predicate.test), holdout: holdout.map(predicate.test),
}))
function evaluate(indices, trainIds = null, validationIds = null) {
  const last = indices.at(-1)
  const ti = trainIds ? trainIds.filter((id) => masks[last].train[id]) : train.map((_, id) => id).filter((id) => masks[last].train[id])
  const vi = validationIds ? validationIds.filter((id) => masks[last].validation[id]) : validation.map((_, id) => id).filter((id) => masks[last].validation[id])
  const ts = resultStats(train, ti), vs = resultStats(validation, vi)
  const trainQuality = (ts.targets + 3) / (ts.signals + 15)
  const validationQuality = (vs.targets + 2) / (vs.signals + 10)
  const score = 100 * trainQuality + 180 * validationQuality + 20 * ts.average +
    40 * vs.average - 2 * Math.max(0, ts.stops - ts.targets) / Math.max(1, ts.signals) -
    4 * Math.max(0, vs.stops - vs.targets) / Math.max(1, vs.signals) - .03 * indices.length
  return { indices, trainIds: ti, validationIds: vi, train: ts, validation: vs, score }
}

let beam = predicates.map((_, index) => evaluate([index]))
  .filter((rule) => rule.train.signals >= 20 && rule.validation.signals >= 8)
  .sort((a, b) => b.score - a.score).slice(0, 180)
const all = [...beam]
for (let depth = 2; depth <= 5; depth++) {
  const next = []
  for (const parent of beam) {
    for (let candidate = parent.indices.at(-1) + 1; candidate < predicates.length; candidate++) {
      const rule = evaluate([...parent.indices, candidate], parent.trainIds, parent.validationIds)
      if (rule.train.signals < 10 || rule.validation.signals < 4 || rule.train.targetDays < 2 || rule.validation.targetDays < 1) continue
      next.push(rule)
      if (next.length >= 2500) {
        next.sort((a, b) => b.score - a.score)
        next.splice(700)
      }
    }
  }
  next.sort((a, b) => b.score - a.score)
  const signatures = new Set()
  beam = next.filter((rule) => {
    const signature = `${rule.trainIds.join(".")}|${rule.validationIds.join(".")}`
    if (signatures.has(signature)) return false
    signatures.add(signature); return true
  }).slice(0, 180)
  all.push(...beam)
  process.stderr.write(`depth ${depth}: ${beam.length}\n`)
}

const ranked = all.filter((rule) => rule.train.signals >= 15 && rule.validation.signals >= 6 &&
  rule.train.net > 0 && rule.validation.net > 0 && rule.train.targetDays >= 3 && rule.validation.targetDays >= 2 &&
  rule.train.targetRate >= .25 && rule.validation.targetRate >= .25)
  .sort((a, b) => b.score - a.score || b.validation.average - a.validation.average)
  .slice(0, 50)
const output = ranked.map((rule) => {
  const ids = holdout.map((_, id) => id).filter((id) => rule.indices.every((index) => masks[index].holdout[id]))
  const hs = resultStats(holdout, ids)
  return { rules: rule.indices.map((index) => predicates[index].label),
    train: { ...rule.train, rows: undefined }, validation: { ...rule.validation, rows: undefined },
    holdout: { ...hs, rows: hs.rows.map((row) => ({ symbol: row.symbol, signalTime: row.signalTime, outcome: row.outcome05,
      returnPct: row.return05, mfePct: row.mfe06, maePct: row.mae06 })) } }
})
const filename = "csv/2026-10-05-to-14-fast-depth-momentum-rule-search.json"
fs.writeFileSync(filename, JSON.stringify({ source, predicates: predicates.length, finalists: output }, null, 2) + "\n")
console.log(JSON.stringify({ filename, predicates: predicates.length, finalists: output.length,
  top: output.slice(0, 15).map((row) => ({ rules: row.rules,
    train: { signals: row.train.signals, targets: row.train.targets, stops: row.train.stops, net: row.train.net, average: row.train.average },
    validation: { signals: row.validation.signals, targets: row.validation.targets, stops: row.validation.stops, net: row.validation.net, average: row.validation.average },
    holdout: { signals: row.holdout.signals, targets: row.holdout.targets, stops: row.holdout.stops, net: row.holdout.net, average: row.holdout.average,
      rows: row.holdout.rows } })) }, null, 2))
