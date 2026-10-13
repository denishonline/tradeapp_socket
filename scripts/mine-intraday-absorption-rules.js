import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const BRANCH = process.argv.includes("--opening") ? "opening" : "intraday"
const SOURCE = path.join(ROOT, "csv", "2026-10-05-to-13-absorption-breakout-broad-enriched.csv")
const [header, ...lines] = fs.readFileSync(SOURCE, "utf8").trim().split(/\r?\n/)
const fields = header.split(",")
const rows = lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
  .filter((row) => row.branch === BRANCH)
const number = (value) => value === "" || value == null ? NaN : Number(value)
const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
for (const row of rows) row.setupMinute = minute(row.setupTime)

const predicates = []
const add = (feature, direction, thresholds) => {
  for (const threshold of thresholds) predicates.push({ feature, direction, threshold,
    label: `${feature} ${direction} ${threshold}`,
    test: (row) => Number.isFinite(number(row[feature])) &&
      (direction === ">=" ? number(row[feature]) >= threshold : number(row[feature]) <= threshold) })
}
add("setupMinute", ">=", [570, 600, 630, 660, 690, 720, 750, 780, 810, 830])
add("setupMinute", "<=", [630, 660, 690, 720, 750, 780, 810, 840, 870])
add("candleReturnPct", ">=", [-0.1, 0, 0.05, 0.1, 0.15, 0.2])
add("candleReturnPct", "<=", [0, 0.05, 0.1, 0.15, 0.2, 0.3])
add("volumeRatio10", ">=", [1, 1.5, 2, 3, 5, 8, 10])
add("volumeRatio10", "<=", [1, 1.5, 2, 3, 5, 8, 10])
for (const feature of ["return3Pct", "return5Pct", "return10Pct", "return30Pct"]) {
  add(feature, ">=", [0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1])
  add(feature, "<=", [0.2, 0.3, 0.5, 0.75, 1, 1.25, 1.5])
}
for (const feature of ["dayReturnPct", "recoveryLowPct"]) {
  add(feature, ">=", [0.5, 0.75, 1, 1.5, 2, 2.5, 3])
  add(feature, "<=", [1, 1.5, 2, 2.5, 3, 4, 5])
}
for (const feature of ["vwapGapPct", "belowHighPct"]) {
  add(feature, ">=", [0.1, 0.2, 0.3, 0.5, 0.75, 1])
  add(feature, "<=", [0.1, 0.2, 0.3, 0.5, 0.75, 1])
}
for (const feature of ["avgBidPct", ...(BRANCH === "intraday" ? ["confirmAvgBidPct"] : [])]) {
  add(feature, ">=", [40, 45, 50, 55, 60, 65, 70])
  add(feature, "<=", [40, 45, 50, 55, 60, 65, 70])
}
for (const feature of ["bidDominantPct", "closeLocationPct",
  ...(BRANCH === "intraday" ? ["confirmBidDominantPct", "confirmCloseLocationPct"] : [])]) {
  add(feature, ">=", [30, 40, 50, 60, 70, 80, 90])
  add(feature, "<=", [40, 50, 60, 70, 80, 90])
}
for (const feature of ["ofi", ...(BRANCH === "intraday" ? ["confirmOfi"] : [])]) {
  add(feature, ">=", [-0.1, -0.05, 0, 0.05, 0.1, 0.2])
  add(feature, "<=", [-0.1, -0.05, 0, 0.05, 0.1, 0.2])
}
for (const feature of ["deltaPct", ...(BRANCH === "intraday" ? ["confirmDeltaPct"] : [])]) {
  add(feature, ">=", [-50, -25, 0, 25, 50, 75])
  add(feature, "<=", [-25, 0, 25, 50, 75])
}
for (const feature of ["depthPricePct", "midReturnPct",
  ...(BRANCH === "intraday" ? ["confirmCandleReturnPct", "confirmMidReturnPct"] : [])]) {
  add(feature, ">=", [-0.1, 0, 0.05, 0.1, 0.2, 0.3, 0.5])
  add(feature, "<=", [0, 0.05, 0.1, 0.2, 0.3, 0.5])
}
if (BRANCH === "intraday") {
  add("confirmVolumeRatio10", ">=", [1, 1.5, 2, 3, 5, 8, 10])
  add("confirmVolumeRatio10", "<=", [1, 1.5, 2, 3, 5, 8, 10])
} else {
  add("gapPct", ">=", [-2, -1, -0.5, 0, 0.5, 1, 2])
  add("gapPct", "<=", [-1, -0.5, 0, 0.5, 1, 2, 3])
  add("prior30ReturnPct", ">=", [-1, -0.5, 0, 0.25, 0.5])
  add("prior30ReturnPct", "<=", [-0.5, 0, 0.25, 0.5, 1])
}
for (const feature of ["breadthPositivePct", "breadthReturn3PositivePct"]) {
  add(feature, ">=", [40, 45, 50, 55, 60, 65, 70, 75])
  add(feature, "<=", [40, 45, 50, 55, 60, 65, 70, 75])
}
add("breadthAbove05Pct", ">=", [10, 20, 30, 40, 50, 60])
add("breadthAbove05Pct", "<=", [10, 20, 30, 40, 50, 60])
for (const feature of ["breadthMedianDayPct", "breadthMedianReturn3Pct"]) {
  add(feature, ">=", [-0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.5])
  add(feature, "<=", [-0.1, 0, 0.1, 0.2, 0.3, 0.5])
}

const trainingIndices = rows.flatMap((row, index) => row.date <= "2026-10-09" ? [index] : [])
const stats = (indices) => {
  let targets = 0, stops = 0, unresolved = 0
  const dates = new Set()
  for (const index of indices) {
    const row = rows[index]
    if (row.outcome === "Target") { targets++; dates.add(row.date) }
    else if (row.outcome === "Stop") stops++
    else unresolved++
  }
  return { targets, stops, unresolved, signals: indices.length, targetDays: dates.size }
}
const stateScore = (value, depth) => value.targets * 18 - value.stops * 8 - value.unresolved * 4 + value.targetDays * 10 - depth * 2
let beam = [{ rules: [], last: -1, indices: trainingIndices, key: "" }]
const discoveries = []
const BEAM_SIZE = 1200
for (let depth = 1; depth <= 5; depth++) {
  const next = new Map()
  for (const state of beam) {
    for (let predicateIndex = state.last + 1; predicateIndex < predicates.length; predicateIndex++) {
      const predicate = predicates[predicateIndex]
      if (state.rules.some((item) => item.feature === predicate.feature && item.direction === predicate.direction)) continue
      const indices = state.indices.filter((index) => predicate.test(rows[index]))
      const value = stats(indices)
      if (value.targets < 3 || value.targetDays < 2) continue
      const key = indices.join(";")
      const candidate = { rules: [...state.rules, predicate], last: predicateIndex, indices, value,
        score: stateScore(value, depth) }
      if (!next.has(key) || candidate.score > next.get(key).score) next.set(key, candidate)
      if (value.stops <= 1 && value.unresolved <= 1) discoveries.push(candidate)
    }
  }
  beam = [...next.values()].sort((a, b) => b.score - a.score).slice(0, BEAM_SIZE)
  process.stderr.write(`depth ${depth}: beam=${beam.length} discoveries=${discoveries.length}\n`)
}

const evaluateAll = (rules) => {
  const matching = rows.filter((row) => rules.every((rule) => rule.test(row)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime))
  const dedup = [...Map.groupBy(matching, (row) => `${row.date}|${row.symbol}`).values()].map((group) => group[0])
  return { ...stats(dedup.map((row) => rows.indexOf(row))), rows: dedup }
}
const ranked = discoveries.map((candidate) => ({
  rules: candidate.rules.map((rule) => rule.label), training: candidate.value, full: evaluateAll(candidate.rules)
})).sort((a, b) => a.full.stops - b.full.stops || a.full.unresolved - b.full.unresolved ||
  b.full.targets - a.full.targets || a.rules.length - b.rules.length)
const unique = [], keys = new Set()
for (const item of ranked) {
  const key = item.full.rows.map((row) => `${row.date}|${row.symbol}|${row.signalTime}`).join(";")
  if (keys.has(key)) continue
  keys.add(key); unique.push(item)
  if (unique.length >= 30) break
}
console.log(JSON.stringify({ source: SOURCE, branch: BRANCH, rows: rows.length, predicates: predicates.length,
  rules: unique.map((item) => ({ rules: item.rules, training: item.training,
    full: { ...item.full, rows: item.full.rows.map((row) => ({ date: row.date, symbol: row.symbol,
      signalTime: row.signalTime, outcome: row.outcome, mfePct: row.mfePct, maePct: row.maePct })) } })) }, null, 2))
