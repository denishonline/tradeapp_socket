import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const scanner = path.join(root, "scripts", "scan-short-depth-patterns.js")
const rows = JSON.parse(execFileSync(process.execPath, [scanner, "--json"], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }))
const winners = rows.filter((row) => row.outcome === "TARGET first")
const featureNames = [
  "breakoutPct", "volumeX", "closeLocation", "depthFull", "depthTop2",
  "return5", "return10", "return20", "return30", "return50",
  "sma20Gap", "sma50Gap", "rsi14", "redBars10",
  "depth5Full", "depth5Top2", "depth10Full", "depth10Top2",
]
const valueOf = (row, key) => key in row ? row[key] : row.indicators?.[key]
const rules = featureNames.flatMap((feature) => ["<=", ">="].map((direction) => ({ feature, direction })))
const thresholdFor = (trainWinners, rule) => {
  const values = trainWinners.map((row) => valueOf(row, rule.feature))
  return rule.direction === "<=" ? Math.max(...values) : Math.min(...values)
}
const passes = (row, rule, threshold) => {
  const value = valueOf(row, rule.feature)
  return Number.isFinite(value) && (rule.direction === "<=" ? value <= threshold : value >= threshold)
}
const results = []

function reviewCombo(combo) {
  const thresholds = combo.map((rule) => thresholdFor(winners, rule))
  const kept = rows.filter((row) => combo.every((rule, index) => passes(row, rule, thresholds[index])))
  const looWinners = winners.filter((heldOut) => {
    const training = winners.filter((row) => row !== heldOut)
    return combo.every((rule) => passes(heldOut, rule, thresholdFor(training, rule)))
  }).length
  results.push({ combo, thresholds, count: kept.length, targetFirstKept: kept.filter((row) => row.outcome === "TARGET first").length, looWinners })
}

function enumerate(start, combo, size) {
  if (combo.length) reviewCombo(combo)
  if (combo.length === size) return
  for (let index = start; index < rules.length; index++) {
    const rule = rules[index]
    if (combo.some((chosen) => chosen.feature === rule.feature)) continue
    enumerate(index + 1, [...combo, rule], size)
  }
}

enumerate(0, [], 3)
results.sort((a, b) => b.looWinners - a.looWinners || a.count - b.count)
console.log(`Entry-time feature review | candidates ${rows.length} | target-first ${winners.length} | other outcomes ${rows.length - winners.length}`)
console.log("Cuts are fitted to include all six historical winners. LOO checks whether each winner passes boundaries fitted using only the other five; this remains an exploratory one-day check.")
console.table(results.slice(0, 15).map(({ combo, thresholds, count, targetFirstKept, looWinners }) => ({
  rule: combo.map((item, index) => `${item.feature} ${item.direction} ${thresholds[index].toFixed(4)}`).join(" AND "),
  candidatesKept: count, targetsKept: `${targetFirstKept}/${winners.length}`, winnerLooPass: `${looWinners}/${winners.length}`,
})))
