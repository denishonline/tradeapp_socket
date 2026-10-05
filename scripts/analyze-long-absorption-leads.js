import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scanner = path.join(root, "scripts", "scan-long-depth-absorption.js")
const rows = JSON.parse(execFileSync(process.execPath, [scanner, "1.51", "--json"], {
  cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
}))
const winners = rows.filter((row) => row.outcome === "TARGET first")
const featureNames = [
  "breakoutPct", "closeLocation", "volumeX10", "volumeX5", "depthFull", "depthTop2",
  "return5", "return10", "return20", "return30", "return50", "sma20Gap", "sma50Gap",
  "trendEfficiency20", "greenBars10", "greenBars20", "prior3VolumeX10",
  "depth5Full", "depth5Top2", "depth10Full", "depth10Top2",
]
const valueOf = (row, feature) => feature in row ? row[feature] : row.indicators?.[feature]
const usableFeatures = featureNames.filter((feature) => winners.length && winners.every((row) => Number.isFinite(valueOf(row, feature))))
const rules = usableFeatures.flatMap((feature) => ["<=", ">="].map((direction) => ({ feature, direction })))
const threshold = (rowsToFit, rule) => {
  const values = rowsToFit.map((row) => valueOf(row, rule.feature))
  return rule.direction === "<=" ? Math.max(...values) : Math.min(...values)
}
const passes = (row, rule, cutoff) => {
  const value = valueOf(row, rule.feature)
  return Number.isFinite(value) && (rule.direction === "<=" ? value <= cutoff : value >= cutoff)
}
const combinations = []

function review(combo) {
  const cuts = combo.map((rule) => threshold(winners, rule))
  const kept = rows.filter((row) => combo.every((rule, index) => passes(row, rule, cuts[index])))
  const loo = winners.filter((heldOut) => {
    const training = winners.filter((row) => row !== heldOut)
    return combo.every((rule) => passes(heldOut, rule, threshold(training, rule)))
  }).length
  combinations.push({ combo, cuts, kept: kept.length, wins: kept.filter((row) => row.outcome === "TARGET first").length, loo })
}

function enumerate(start, combo, maxSize) {
  if (combo.length) review(combo)
  if (combo.length === maxSize) return
  for (let index = start; index < rules.length; index++) {
    if (combo.some((rule) => rule.feature === rules[index].feature)) continue
    enumerate(index + 1, [...combo, rules[index]], maxSize)
  }
}

enumerate(0, [], 3)
combinations.sort((a, b) => b.loo - a.loo || a.kept - b.kept)
console.log(`Pre-signal lead comparison | target-first ${winners.length} of ${rows.length} setups`)
console.table(winners.map((row) => ({ symbol: row.symbol, signalAt: row.signalAt, entry: row.entry, ...Object.fromEntries(usableFeatures.map((feature) => [feature, valueOf(row, feature)])) })))
console.log("Smallest entry-time cuts fitted to both winners; LOO counts whether each winner meets boundaries fit only to the other winner.")
console.table(combinations.slice(0, 12).map(({ combo, cuts, kept, wins, loo }) => ({
  rule: combo.map((item, index) => `${item.feature} ${item.direction} ${cuts[index].toFixed(4)}`).join(" AND "),
  setupsKept: kept, targetsKept: `${wins}/${winners.length}`, winnerLooPass: `${loo}/${winners.length}`,
})))

const candidateRule = [
  { feature: "breakoutPct", test: (value) => value >= 0.05 && value <= 0.06, label: "breakout 0.05-0.06%" },
  { feature: "closeLocation", test: (value) => value >= 0.8, label: "close in top 20%" },
  { feature: "volumeX5", test: (value) => value >= 2, label: "volume >=2x prior 5" },
  { feature: "depthTop2", test: (value) => value <= -0.3, label: "top-2 depth <=-0.30" },
  { feature: "return10", test: (value) => value >= 0.05, label: "prior 10-bar return >=+0.05%" },
  { feature: "prior3VolumeX10", test: (value) => value <= 0.5, label: "prior 3-bar volume <=0.5x prior 10" },
  { feature: "return30", test: (value) => value <= 0.15, label: "prior 30-bar return <=+0.15%" },
]
let remaining = rows
const progression = []
for (const condition of candidateRule) {
  remaining = remaining.filter((row) => {
    const value = valueOf(row, condition.feature)
    return Number.isFinite(value) && condition.test(value)
  })
  progression.push({
    addedFilter: condition.label, setupsLeft: remaining.length,
    targetFirst: remaining.filter((row) => row.outcome === "TARGET first").length,
    stocks: remaining.map((row) => `${row.symbol}@${row.signalAt}`).join(", "),
  })
}
console.log("Illustrative shared precursor cut (exploratory; thresholds not live-enabled):")
console.table(progression)
console.log("Signals remaining after all illustrative filters:")
console.table(remaining.map((row) => ({
  symbol: row.symbol, signalAt: row.signalAt, outcome: row.outcome,
  return10: row.indicators.return10, return20: row.indicators.return20,
  return30: row.indicators.return30, return50: row.indicators.return50,
  sma20Gap: row.indicators.sma20Gap, trendEfficiency20: row.indicators.trendEfficiency20,
  depth5Top2: row.indicators.depth5Top2, depth10Top2: row.indicators.depth10Top2,
})))
