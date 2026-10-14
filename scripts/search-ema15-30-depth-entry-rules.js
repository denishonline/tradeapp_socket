import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const source = path.join(ROOT, "csv", "2026-10-08-to-14-ema15-30-depth-cross-audit.json")
const rows = JSON.parse(fs.readFileSync(source, "utf8")).rows
  .filter((row) => row.depthQuality)
  .map((row, id) => ({ ...row, id,
    winner: Boolean(row.targetHit && row.targetTime?.slice(0, 10) === row.date) }))

const definitions = {
  candleReturnPct: [0, .03, .05, .08, .10, .15],
  closeLocationPct: [40, 50, 60, 70, 80, 90],
  rangePct: [.05, .08, .10, .15, .20],
  volumeRatio10: [.4, .6, .8, 1, 1.5, 2],
  pre3ReturnPct: [.08, .12, .16, .20, .25, .30, .40, .50],
  emaGapPct: [.002, .004, .006, .008, .01, .015],
  emaGapExpansionPct: [.004, .006, .008, .01, .015, .02],
  depth1_dirFull: [-.2, -.1, 0, .05, .1, .2],
  depth1_dirTop2: [-.2, -.1, 0, .05, .1, .2],
  depth1_dirCloseFull: [-.3, -.2, -.1, 0, .1, .2, .3],
  depth1_dirCloseTop2: [-.4, -.2, 0, .2, .4],
  depth1_dirOfi: [-.02, 0, .03, .05, .08, .1, .15],
  depth1_dirDeltaPct: [-20, 0, 20, 40, 60, 80],
  depth1_dirMidReturnPct: [0, .02, .04, .06, .08, .1],
  depth1_alignedFullPct: [30, 40, 50, 60, 70],
  depth1_alignedTop2Pct: [30, 40, 50, 60, 70],
  depth3_dirFull: [-.2, -.1, 0, .05, .1, .2],
  depth3_dirTop2: [-.2, -.1, 0, .05, .1, .2],
  depth3_dirOfi: [-.02, 0, .03, .05, .08, .1],
  depth3_dirDeltaPct: [-20, 0, 20, 40, 60],
  depth3_dirMidReturnPct: [0, .05, .1, .15, .2, .25],
  depth3_alignedFullPct: [30, 40, 50, 60, 70],
  depth3_alignedTop2Pct: [30, 40, 50, 60, 70],
}

const predicates = []
for (const [feature, thresholds] of Object.entries(definitions)) {
  for (const threshold of thresholds) {
    predicates.push({ feature, label: `${feature} >= ${threshold}`,
      test: (row) => Number.isFinite(row[feature]) && row[feature] >= threshold })
    if (["depth1_dirFull", "depth1_dirTop2", "depth1_dirCloseFull", "depth1_dirCloseTop2",
      "depth3_dirFull", "depth3_dirTop2"].includes(feature)) {
      predicates.push({ feature, label: `${feature} <= ${threshold}`,
        test: (row) => Number.isFinite(row[feature]) && row[feature] <= threshold })
    }
  }
}

function metrics(subset) {
  const wins = subset.filter((row) => row.winner).length
  return { support: subset.length, wins, losses: subset.length - wins,
    precision: subset.length ? wins / subset.length : 0 }
}

function matches(row, chosen) {
  const hasThreeMinuteFeature = chosen.some((item) => item.feature.startsWith("depth3_"))
  return (!hasThreeMinuteFeature || (row.depth3_spanSec >= 150 && row.depth3_maxGapSec <= 15)) &&
    chosen.every((item) => item.test(row))
}

function candidatesFor(side) {
  const eligible = rows.filter((row) => row.side === side)
  const train = eligible.filter((row) => row.date <= "2026-10-12")
  const validation = eligible.filter((row) => row.date >= "2026-10-13")
  const candidates = []
  for (let first = 0; first < predicates.length; first++) {
    for (let second = first + 1; second < predicates.length; second++) {
      const chosen = [predicates[first], predicates[second]]
      if (chosen[0].feature === chosen[1].feature) continue
      const trainRows = train.filter((row) => matches(row, chosen))
      const trainMetrics = metrics(trainRows)
      if (trainMetrics.support < 3 || trainMetrics.precision < .6) continue
      const validationRows = validation.filter((row) => matches(row, chosen))
      candidates.push({ side, rule: chosen.map((item) => item.label), complexity: 2,
        train: trainMetrics, validation: metrics(validationRows),
        selected: [...trainRows, ...validationRows] })
    }
  }

  const strongestPairs = candidates.slice().sort((left, right) =>
    right.train.precision - left.train.precision || right.train.wins - left.train.wins ||
    right.train.support - left.train.support).slice(0, 300)
  for (const pair of strongestPairs) {
    const usedFeatures = new Set(pair.rule.map((label) => label.split(" ")[0]))
    const start = predicates.findIndex((item) => item.label === pair.rule.at(-1)) + 1
    for (let third = start; third < predicates.length; third++) {
      const item = predicates[third]
      if (usedFeatures.has(item.feature)) continue
      const chosenLabels = [...pair.rule, item.label]
      const chosen = chosenLabels.map((label) => predicates.find((value) => value.label === label))
      const trainRows = train.filter((row) => matches(row, chosen))
      const trainMetrics = metrics(trainRows)
      if (trainMetrics.support < 3 || trainMetrics.wins < 3 || trainMetrics.precision < .75) continue
      const validationRows = validation.filter((row) => matches(row, chosen))
      candidates.push({ side, rule: chosenLabels, complexity: 3,
        train: trainMetrics, validation: metrics(validationRows),
        selected: [...trainRows, ...validationRows] })
    }
  }
  return candidates
}

const all = ["BUY", "SELL"].flatMap(candidatesFor)
const noFailure = all.filter((item) => item.train.losses === 0 && item.validation.losses === 0 &&
  item.validation.support > 0)
  .sort((left, right) => (right.train.wins + right.validation.wins) -
    (left.train.wins + left.validation.wins) || left.complexity - right.complexity ||
    right.validation.wins - left.validation.wins)

const signature = (item) => item.selected.map((row) => row.id).sort((a, b) => a - b).join(",")
const seen = new Set(), unique = []
for (const item of noFailure) {
  const key = `${item.side}:${signature(item)}`
  if (seen.has(key)) continue
  seen.add(key)
  unique.push({ ...item,
    selected: item.selected.sort((left, right) => left.date.localeCompare(right.date) ||
      left.signalTime.localeCompare(right.signalTime) || left.symbol.localeCompare(right.symbol))
      .map((row) => ({ date: row.date, time: row.signalTime, symbol: row.symbol, side: row.side,
        targetTime: row.targetTime, entryPrice: row.entryPrice, mfePct: row.mfePct,
        maePct: row.maePct, preTargetMaePct: row.preTargetMaePct,
        targetMinutes: row.targetMinutes, exitReturnPct: row.exitReturnPct })) })
  if (unique.length >= 20) break
}

const validated = all.filter((item) => item.train.support >= 4 && item.validation.support >= 3)
  .sort((left, right) => right.validation.precision - left.validation.precision ||
    right.validation.wins - left.validation.wins || right.train.precision - left.train.precision ||
    right.train.wins - left.train.wins || left.complexity - right.complexity)
const validatedSeen = new Set(), bestValidated = []
for (const item of validated) {
  const key = `${item.side}:${signature(item)}`
  if (validatedSeen.has(key)) continue
  validatedSeen.add(key)
  bestValidated.push({ side: item.side, rule: item.rule, complexity: item.complexity,
    train: item.train, validation: item.validation,
    selected: item.selected.sort((left, right) => left.date.localeCompare(right.date) ||
      left.signalTime.localeCompare(right.signalTime) || left.symbol.localeCompare(right.symbol))
      .map((row) => ({ date: row.date, time: row.signalTime, symbol: row.symbol,
        winner: row.winner, mfePct: row.mfePct, exitReturnPct: row.exitReturnPct })) })
  if (bestValidated.length >= 10) break
}

console.log(JSON.stringify({ population: {
  total: rows.length, winners: rows.filter((row) => row.winner).length,
  train: metrics(rows.filter((row) => row.date <= "2026-10-12")),
  validation: metrics(rows.filter((row) => row.date >= "2026-10-13")),
}, noFailureRules: unique, bestValidated }, null, 2))
