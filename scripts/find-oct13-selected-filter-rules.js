import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const parse = (name) => {
  const [header, ...lines] = fs.readFileSync(path.join(ROOT, "csv", name), "utf8").trim().split(/\r?\n/)
  const fields = header.split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
}
const number = (value) => value === "" || value == null ? NaN : Number(value)
const timeNumber = (value) => {
  const [hour, minute] = value.split(":").map(Number)
  return hour * 60 + minute
}

function findRules(rows, featureNames, maxRules = 4, isNegative = (row) => row.outcome === "Stop") {
  const selected = rows.filter((row) => row.selected === "true")
  const stops = rows.filter(isNegative)
  const predicates = []
  for (const name of featureNames) {
    const getter = name === "setupMinute" ? (row) => timeNumber(row.setupTime) : (row) => number(row[name])
    const values = selected.map(getter)
    if (values.some((value) => !Number.isFinite(value))) continue
    const minimum = Math.min(...values), maximum = Math.max(...values)
    const candidates = [
      { label: `${name} >= ${minimum}`, test: (row) => getter(row) >= minimum },
      { label: `${name} <= ${maximum}`, test: (row) => getter(row) <= maximum }
    ]
    for (const predicate of candidates) {
      const eliminated = stops.filter((row) => !predicate.test(row)).length
      if (eliminated) predicates.push({ ...predicate, eliminated })
    }
  }
  predicates.sort((a, b) => b.eliminated - a.eliminated)
  const answers = []
  const search = (start, chosen, survivors) => {
    const remainingStops = survivors.filter(isNegative)
    if (!remainingStops.length) {
      const targets = survivors.filter((row) => row.outcome === "Target").length
      const unresolved = survivors.filter((row) => row.outcome === "Unresolved").length
      answers.push({ rules: chosen.map((item) => item.label), signals: survivors.length, targets, unresolved })
      return
    }
    if (chosen.length >= maxRules) return
    for (let index = start; index < predicates.length; index++) {
      const predicate = predicates[index]
      if (!remainingStops.some((row) => !predicate.test(row))) continue
      search(index + 1, [...chosen, predicate], survivors.filter(predicate.test))
    }
  }
  search(0, [], rows)
  answers.sort((a, b) => a.rules.length - b.rules.length || b.targets - a.targets || a.unresolved - b.unresolved || b.signals - a.signals)
  const minimumRules = answers[0]?.rules.length
  return answers.filter((answer) => answer.rules.length === minimumRules).slice(0, 30)
}

const opening = parse("2026-10-13-opening-breakout-context.csv")
const intraday = parse("2026-10-13-absorption-breakout-broad-candidates.csv").filter((row) => row.branch === "intraday")
const setupFeatures = ["candleReturnPct", "closeLocationPct", "upperWickPct", "volumeRatio10", "return3Pct",
  "return5Pct", "return10Pct", "return30Pct", "dayReturnPct", "vwapGapPct", "belowHighPct", "recoveryLowPct",
  "updates", "maxGapSec", "avgBidPct", "bidDominantPct", "ofi", "deltaPct", "depthPricePct", "midReturnPct", "spreadPct"]
const openingFeatures = [...setupFeatures, "gapPct", "priorDayReturnPct", "prior5ReturnPct", "prior15ReturnPct",
  "prior30ReturnPct", "historicalOpeningVolumeRatio"]
const confirmationFeatures = ["confirmCandleReturnPct", "confirmCloseLocationPct", "confirmVolumeRatio10",
  "confirmAvgBidPct", "confirmBidDominantPct", "confirmOfi", "confirmDeltaPct", "confirmMidReturnPct"]

if (process.argv.includes("--opening-target-only")) {
  console.log(JSON.stringify(findRules(opening, openingFeatures, 6, (row) => row.outcome !== "Target"), null, 2))
} else {
  console.log(JSON.stringify({ opening: findRules(opening, openingFeatures),
    intraday: findRules(intraday, ["setupMinute", ...setupFeatures, ...confirmationFeatures]),
    intradayTargetOnlyLate: findRules(intraday.filter((row) => timeNumber(row.setupTime) >= 830),
      ["setupMinute", ...setupFeatures, ...confirmationFeatures], 6, (row) => row.outcome !== "Target") }, null, 2))
}
