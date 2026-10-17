import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const INPUT = path.join(ROOT, "reports", "candle-depth-profit-dataset.json")
const OUTPUT = path.join(ROOT, "reports", "candle-depth-profit-model.json")
const TRAIN_END = "2026-10-09"
const TEST_START = "2026-10-12"

function rng(seed = 0x5f3759df) {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let result = value
    result = Math.imul(result ^ result >>> 15, result | 1)
    result ^= result + Math.imul(result ^ result >>> 7, result | 61)
    return ((result ^ result >>> 14) >>> 0) / 4294967296
  }
}

function shuffled(values, random) {
  const result = values.slice()
  for (let index = result.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1))
    ;[result[index], result[selected]] = [result[selected], result[index]]
  }
  return result
}

function gini(rows) {
  if (!rows.length) return 0
  const positive = rows.reduce((sum, row) => sum + row.y, 0) / rows.length
  return 2 * positive * (1 - positive)
}

function leaf(rows, prior) {
  const positive = rows.reduce((sum, row) => sum + row.y, 0)
  return { probability: (positive + prior * 8) / (rows.length + 8), samples: rows.length, positive }
}

function buildTree(rows, featureNames, config, random, prior, depth = 0) {
  const positive = rows.reduce((sum, row) => sum + row.y, 0)
  if (depth >= config.maxDepth || rows.length < config.minLeaf * 2 || positive === 0 || positive === rows.length) {
    return leaf(rows, prior)
  }
  const parentImpurity = gini(rows)
  let best = null
  const candidates = shuffled(featureNames, random).slice(0, config.maxFeatures)
  for (const feature of candidates) {
    const sorted = rows.map((row) => row.x[feature]).filter(Number.isFinite).sort((left, right) => left - right)
    if (sorted.length < config.minLeaf * 2) continue
    const thresholds = [...new Set([.1, .2, .3, .4, .5, .6, .7, .8, .9]
      .map((fraction) => sorted[Math.floor((sorted.length - 1) * fraction)]))]
    for (const threshold of thresholds) {
      const left = [], right = []
      for (const row of rows) (row.x[feature] <= threshold ? left : right).push(row)
      if (left.length < config.minLeaf || right.length < config.minLeaf) continue
      const impurity = (left.length * gini(left) + right.length * gini(right)) / rows.length
      const gain = parentImpurity - impurity
      if (!best || gain > best.gain) best = { feature, threshold, gain, left, right }
    }
  }
  if (!best || best.gain <= 1e-8) return leaf(rows, prior)
  return {
    feature: best.feature, threshold: best.threshold,
    left: buildTree(best.left, featureNames, config, random, prior, depth + 1),
    right: buildTree(best.right, featureNames, config, random, prior, depth + 1),
  }
}

function trainForest(rows, featureNames, config, seed) {
  const random = rng(seed)
  const prior = rows.reduce((sum, row) => sum + row.y, 0) / rows.length
  const trees = []
  for (let treeIndex = 0; treeIndex < config.trees; treeIndex++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)])
    trees.push(buildTree(sample, featureNames, config, random, prior))
  }
  return { prior, featureNames, config, trees }
}

function treeScore(tree, features) {
  let node = tree
  while (!Number.isFinite(node.probability)) {
    node = Number(features[node.feature]) <= node.threshold ? node.left : node.right
  }
  return node.probability
}

function score(model, features) {
  return model.trees.reduce((sum, tree) => sum + treeScore(tree, features), 0) / model.trees.length
}

function averagePrecision(rows) {
  const ranked = rows.slice().sort((left, right) => right.score - left.score)
  const positives = ranked.reduce((sum, row) => sum + row.y, 0)
  if (!positives) return 0
  let found = 0, total = 0
  ranked.forEach((row, index) => {
    if (!row.y) return
    found++
    total += found / (index + 1)
  })
  return total / positives
}

function thresholdOptions(rows) {
  const ranked = rows.slice().sort((left, right) => right.score - left.score)
  const options = []
  for (let keep = 10; keep <= Math.min(ranked.length, 150); keep++) {
    const threshold = ranked[keep - 1].score
    const selected = rows.filter((row) => row.score >= threshold)
    const wins = selected.reduce((sum, row) => sum + row.y, 0)
    const allWins = rows.reduce((sum, row) => sum + row.y, 0)
    const precision = wins / selected.length
    const recall = wins / allWins
    const beta = 0.5
    const f05 = precision + recall > 0
      ? (1 + beta ** 2) * precision * recall / (beta ** 2 * precision + recall) : 0
    const dates = new Set(selected.map((row) => row.date)).size
    if (dates >= 4) options.push({ threshold, selected: selected.length, wins, precision, recall, f05, dates })
  }
  return options.sort((left, right) => right.f05 - left.f05 || right.precision - left.precision)[0]
}

function evaluate(rows, threshold) {
  const selected = rows.filter((row) => row.score >= threshold)
  const wins = selected.reduce((sum, row) => sum + row.y, 0)
  const allWins = rows.reduce((sum, row) => sum + row.y, 0)
  return {
    candidates: rows.length, availableWinners: allWins, selected: selected.length, winners: wins,
    falsePositives: selected.length - wins,
    precisionPct: selected.length ? 100 * wins / selected.length : 0,
    winnerRecallPct: allWins ? 100 * wins / allWins : 0,
  }
}

const source = JSON.parse(fs.readFileSync(INPUT, "utf8"))
const featureNames = Object.keys(source.rows[0]?.features || {})
const rows = source.rows.map((row) => ({ ...row, x: row.features, y: row.winner ? 1 : 0 }))
const train = rows.filter((row) => row.date <= TRAIN_END)
const test = rows.filter((row) => row.date >= TEST_START)
const trainDates = [...new Set(train.map((row) => row.date))]

const configs = []
for (const maxDepth of [3, 4, 5]) for (const minLeaf of [5, 10, 15]) for (const maxFeatures of [7, 12]) {
  configs.push({ trees: 120, maxDepth, minLeaf, maxFeatures })
}

let best = null
for (let configIndex = 0; configIndex < configs.length; configIndex++) {
  const config = configs[configIndex]
  const outOfFold = []
  for (let dateIndex = 0; dateIndex < trainDates.length; dateIndex++) {
    const date = trainDates[dateIndex]
    const trainingRows = train.filter((row) => row.date !== date)
    const validationRows = train.filter((row) => row.date === date)
    const model = trainForest(trainingRows, featureNames, config, 10_000 + configIndex * 101 + dateIndex)
    outOfFold.push(...validationRows.map((row) => ({ ...row, score: score(model, row.x) })))
  }
  const threshold = thresholdOptions(outOfFold)
  const candidate = { config, threshold, averagePrecision: averagePrecision(outOfFold), outOfFold }
  if (!best || candidate.threshold.f05 > best.threshold.f05 ||
      (candidate.threshold.f05 === best.threshold.f05 && candidate.averagePrecision > best.averagePrecision)) best = candidate
}

const finalModel = trainForest(train, featureNames, { ...best.config, trees: 400 }, 8675309)
const trainScored = train.map((row) => ({ ...row, score: score(finalModel, row.x) }))
const testScored = test.map((row) => ({ ...row, score: score(finalModel, row.x) }))
const selectedTest = testScored.filter((row) => row.score >= best.threshold.threshold)
  .sort((left, right) => left.confirmedAt - right.confirmedAt)
const report = {
  generatedAt: new Date().toISOString(), trainingDates: trainDates,
  testDates: [...new Set(test.map((row) => row.date))], featureNames,
  model: finalModel, threshold: best.threshold.threshold,
  crossValidation: { averagePrecision: best.averagePrecision, ...evaluate(best.outOfFold, best.threshold.threshold) },
  fittedTraining: evaluate(trainScored, best.threshold.threshold),
  untouchedTest: evaluate(testScored, best.threshold.threshold),
  selectedTest: selectedTest.map((row) => ({
    date: row.date, time: row.time, symbol: row.symbol, score: row.score,
    winner: Boolean(row.y), returnPct: row.returnPct, outcome: row.outcome,
  })),
}
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2))
console.log(JSON.stringify({
  output: OUTPUT, config: best.config, threshold: best.threshold,
  crossValidation: report.crossValidation, fittedTraining: report.fittedTraining,
  untouchedTest: report.untouchedTest, selectedTest: report.selectedTest,
}, null, 2))
