import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const input = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-full-context-outcomes.csv")

function csvRows(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
  const parse = (line) => {
    const fields = []
    let value = "", quoted = false
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++ }
      else if (char === '"') quoted = !quoted
      else if (char === "," && !quoted) { fields.push(value); value = "" }
      else value += char
    }
    fields.push(value)
    return fields
  }
  const columns = parse(lines[0])
  return lines.slice(1).map((line) => Object.fromEntries(parse(line).map((value, index) => [columns[index], value])))
}

const numeric = ["confirmationScore", "returnOpen", "return3", "return5", "return10", "return15", "rsi14", "mfi14",
  "vwapGap5", "vwapGap15", "directionVolume5", "directionVolume10", "recoveryLow", "pullbackHigh",
  "directionalDepth", "directionalTop2", "depthMinutes", "depthImbalance3", "depthTickCount15", "bidShareTicks15",
  "bidDominantTicks15", "top2BidShareTicks15", "top2BidDominantTicks15", "bidOrderShareTicks15",
  "bidOrderDominantTicks15", "bidShareLast3", "top2BidShareLast3", "bidShareChange5", "top2BidShareChange5",
  "spreadBps15", "depthPriceReturn15", "executedVolume15", "openingGapPct", "priorDayReturnPct",
  "signalVsPriorClosePct", "signalVsPriorHighPct", "signalVsPriorLowPct", "priorCloseLocationPct",
  "openingVolumeRatio", "volume5VsPrior5", "atr14Pct", "range5Pct", "closeLocation5Pct", "bodyStrength3Pct",
  "greenCloses5"]
const rows = csvRows(input).filter((row) => row.side === "BUY").map((row) => {
  for (const field of numeric) row[field] = Number(row[field])
  return row
})
const protectedRows = rows.filter((row) => row.day === "2026-10-09" && row.outcome === "Target")
if (protectedRows.length !== 7) throw new Error(`Expected 7 protected October 9 BUY targets, found ${protectedRows.length}`)

const manualRules = [
  { name: "time <= 09:50", test: (r) => r.time <= "09:50" },
  { name: "returnOpen >= -1.15%", test: (r) => r.returnOpen >= -1.15 },
  { name: "returnOpen <= -0.15%", test: (r) => r.returnOpen <= -0.15 },
  { name: "return3 >= -0.50%", test: (r) => r.return3 >= -0.50 },
  { name: "return3 <= +0.25%", test: (r) => r.return3 <= 0.25 },
  { name: "return5 >= -0.20%", test: (r) => r.return5 >= -0.20 },
  { name: "return5 <= +0.35%", test: (r) => r.return5 <= 0.35 },
  { name: "return10 >= -0.50%", test: (r) => r.return10 >= -0.50 },
  { name: "return10 <= +0.55%", test: (r) => r.return10 <= 0.55 },
  { name: "return15 >= -0.60%", test: (r) => r.return15 >= -0.60 },
  { name: "return15 <= +0.15%", test: (r) => r.return15 <= 0.15 },
  { name: "RSI14 >= 39", test: (r) => r.rsi14 >= 39 },
  { name: "RSI14 <= 52", test: (r) => r.rsi14 <= 52 },
  { name: "MFI14 >= 22", test: (r) => r.mfi14 >= 22 },
  { name: "MFI14 <= 51", test: (r) => r.mfi14 <= 51 },
  { name: "VWAP gap 5 >= -0.30%", test: (r) => r.vwapGap5 >= -0.30 },
  { name: "VWAP gap 5 <= +0.20%", test: (r) => r.vwapGap5 <= 0.20 },
  { name: "VWAP gap 15 >= -0.45%", test: (r) => r.vwapGap15 >= -0.45 },
  { name: "VWAP gap 15 <= +0.31%", test: (r) => r.vwapGap15 <= 0.31 },
  { name: "green volume 5 >= 50%", test: (r) => r.directionVolume5 >= 50 },
  { name: "green volume 10 >= 24%", test: (r) => r.directionVolume10 >= 24 },
  { name: "recovery from low >= 0.55%", test: (r) => r.recoveryLow >= 0.55 },
  { name: "recovery from low <= 1.10%", test: (r) => r.recoveryLow <= 1.10 },
  { name: "pullback from high >= 0.70%", test: (r) => r.pullbackHigh >= 0.70 },
  { name: "pullback from high <= 1.85%", test: (r) => r.pullbackHigh <= 1.85 },
  { name: "positive depth minutes >= 60%", test: (r) => r.directionalDepth >= 60 },
  { name: "positive top-two minutes >= 25%", test: (r) => r.directionalTop2 >= 25 },
  { name: "last-3 depth imbalance >= -0.17", test: (r) => r.depthImbalance3 >= -0.17 },
  { name: "last-3 depth imbalance <= +0.31", test: (r) => r.depthImbalance3 <= 0.31 },
  { name: "depth ticks >= 200", test: (r) => r.depthTickCount15 >= 200 },
  { name: "average five-level bid share >= 51.5%", test: (r) => r.bidShareTicks15 >= 51.5 },
  { name: "bid-dominant ticks >= 56%", test: (r) => r.bidDominantTicks15 >= 56 },
  { name: "average top-two bid share >= 47.5%", test: (r) => r.top2BidShareTicks15 >= 47.5 },
  { name: "top-two bid-dominant ticks >= 44%", test: (r) => r.top2BidDominantTicks15 >= 44 },
  { name: "average bid-order share >= 49.8%", test: (r) => r.bidOrderShareTicks15 >= 49.8 },
  { name: "bid-order-dominant ticks >= 46%", test: (r) => r.bidOrderDominantTicks15 >= 46 },
  { name: "last-three-minute bid share >= 41.5%", test: (r) => r.bidShareLast3 >= 41.5 },
  { name: "last-three-minute top-two bid share >= 39.5%", test: (r) => r.top2BidShareLast3 >= 39.5 },
  { name: "five-minute bid-share change >= -17.5pp", test: (r) => r.bidShareChange5 >= -17.5 },
  { name: "five-minute top-two change >= -12.6pp", test: (r) => r.top2BidShareChange5 >= -12.6 },
  { name: "spread <= 6.1 bps", test: (r) => r.spreadBps15 <= 6.1 },
  { name: "depth price return >= -0.60%", test: (r) => r.depthPriceReturn15 >= -0.60 },
  { name: "depth price return <= +0.13%", test: (r) => r.depthPriceReturn15 <= 0.13 },
  { name: "executed volume >= 14,000", test: (r) => r.executedVolume15 >= 14_000 },
  { name: "15-minute return >= -0.75%", test: (r) => r.return15 >= -0.75 },
  { name: "prior-day return <= 0%", test: (r) => r.priorDayReturnPct <= 0 },
  { name: "five-minute volume <= 1.5x prior five", test: (r) => r.volume5VsPrior5 <= 1.5 },
  { name: "ATR14 <= 0.36%", test: (r) => r.atr14Pct <= 0.36 },
  { name: "at least three green closes in five", test: (r) => r.greenCloses5 >= 3 },
]

const envelopeFields = ["confirmationScore", "returnOpen", "return3", "return5", "return10", "return15", "rsi14", "mfi14",
  "vwapGap5", "vwapGap15", "directionVolume5", "directionVolume10", "recoveryLow", "pullbackHigh",
  "directionalDepth", "directionalTop2", "depthImbalance3", "depthTickCount15", "bidShareTicks15",
  "bidDominantTicks15", "top2BidShareTicks15", "top2BidDominantTicks15", "bidOrderShareTicks15",
  "bidOrderDominantTicks15", "bidShareLast3", "top2BidShareLast3", "bidShareChange5", "top2BidShareChange5",
  "spreadBps15", "depthPriceReturn15", "executedVolume15"]
const envelopeRules = envelopeFields.flatMap((field) => {
  const values = protectedRows.map((row) => row[field]).filter(Number.isFinite)
  if (values.length !== protectedRows.length) return []
  const low = Math.min(...values), high = Math.max(...values)
  return [
    { name: `${field} >= ${low}`, test: (r) => Number.isFinite(r[field]) && r[field] >= low },
    { name: `${field} <= ${high}`, test: (r) => Number.isFinite(r[field]) && r[field] <= high },
  ]
})
const candidateRules = [...manualRules, ...envelopeRules]

const rules = candidateRules.filter((rule) => protectedRows.every(rule.test))
function preservingFrontier(rulePool, maximumDepth = 12) {
  const usable = rulePool.filter((rule) => protectedRows.every(rule.test))
  let layer = [{ indexes: rows.map((_, index) => index), chosen: [], next: 0 }]
  const frontier = []
  for (let depth = 1; depth <= maximumDepth; depth++) {
    const expanded = []
    const layerSeen = new Set()
    for (const state of layer) {
      for (let i = state.next; i < usable.length; i++) {
        const indexes = state.indexes.filter((index) => usable[i].test(rows[index]))
        if (!protectedRows.every((protectedRow) => indexes.some((index) => rows[index] === protectedRow))) continue
        const key = indexes.join(",")
        if (layerSeen.has(key)) continue
        layerSeen.add(key)
        const chosen = [...state.chosen, i]
        const bad = indexes.filter((index) => rows[index].outcome !== "Target").length
        const targets = indexes.filter((index) => rows[index].outcome === "Target").length
        expanded.push({ indexes, chosen, next: i + 1, bad, targets })
      }
    }
    const bestAtDepth = expanded.sort((a, b) => a.bad - b.bad || b.targets - a.targets || a.indexes.length - b.indexes.length)[0]
    if (bestAtDepth) frontier.push({ depth, bad: bestAtDepth.bad, targets: bestAtDepth.targets,
      rules: bestAtDepth.chosen.map((index) => usable[index].name) })
    layer = expanded.slice(0, 30000)
  }
  return frontier
}
const sensibleFrontier = preservingFrontier(manualRules)

function bitCount(value) {
  let count = 0
  while (value) { value &= value - 1; count++ }
  return count
}

function zeroBadCover(rulePool, maximumDepth = 7) {
  const protectedIndexByRow = new Map(protectedRows.map((row, index) => [row, index]))
  let layer = [{ indexes: rows.map((_, index) => index), chosen: [], next: 0 }]
  const seen = new Set()
  const bestBranchByMask = new Map()
  for (let depth = 1; depth <= maximumDepth; depth++) {
    const expanded = []
    for (const state of layer) {
      for (let i = state.next; i < rulePool.length; i++) {
        const indexes = state.indexes.filter((index) => rulePool[i].test(rows[index]))
        if (!indexes.length) continue
        const key = indexes.join(",")
        if (seen.has(key)) continue
        seen.add(key)
        const chosen = [...state.chosen, i]
        const targets = indexes.filter((index) => rows[index].outcome === "Target").length
        const bad = indexes.length - targets
        let mask = 0
        for (const index of indexes) {
          const protectedIndex = protectedIndexByRow.get(rows[index])
          if (protectedIndex !== undefined) mask |= 1 << protectedIndex
        }
        const next = { indexes, chosen, next: i + 1, targets, bad, mask, purity: targets / indexes.length }
        if (!bad && mask) {
          const current = bestBranchByMask.get(mask)
          if (!current || chosen.length < current.chosen.length ||
            (chosen.length === current.chosen.length && targets > current.targets)) bestBranchByMask.set(mask, next)
        }
        expanded.push(next)
      }
    }
    layer = expanded.sort((a, b) => b.purity - a.purity || bitCount(b.mask) - bitCount(a.mask) ||
      b.targets - a.targets || a.chosen.length - b.chosen.length).slice(0, 60000)
  }
  const branches = [...bestBranchByMask.values()]
  const fullMask = (1 << protectedRows.length) - 1
  const dp = new Map([[0, { branches: [], ruleCount: 0, targets: 0 }]])
  for (const branch of branches) {
    for (const [mask, state] of [...dp]) {
      const nextMask = mask | branch.mask
      const candidate = { branches: [...state.branches, branch],
        ruleCount: state.ruleCount + branch.chosen.length, targets: state.targets + branch.targets }
      const current = dp.get(nextMask)
      if (!current || candidate.branches.length < current.branches.length ||
        (candidate.branches.length === current.branches.length && candidate.ruleCount < current.ruleCount) ||
        (candidate.branches.length === current.branches.length && candidate.ruleCount === current.ruleCount && candidate.targets > current.targets)) {
        dp.set(nextMask, candidate)
      }
    }
  }
  const cover = dp.get(fullMask)
  return { branchMasks: branches.length, cover: cover && cover.branches.map((branch) => ({
    rules: branch.chosen.map((index) => rulePool[index].name),
    protected: protectedRows.filter((_, index) => branch.mask & (1 << index)).map((row) => row.symbol),
    signals: branch.indexes.map((index) => ({ day: rows[index].day, time: rows[index].time,
      symbol: rows[index].symbol, outcome: rows[index].outcome })),
  })) }
}
const branchCover = { skipped: "single sensible conjunction search completed" }
let states = [{ indexes: rows.map((_, index) => index), chosen: [], next: 0 }]
const solutions = []
const seen = new Set()
for (let depth = 1; depth <= 12; depth++) {
  const nextStates = []
  for (const state of states) {
    for (let i = state.next; i < rules.length; i++) {
      const indexes = state.indexes.filter((index) => rules[i].test(rows[index]))
      if (!protectedRows.every((protectedRow) => indexes.some((index) => rows[index] === protectedRow))) continue
      const key = indexes.join(",")
      if (seen.has(key)) continue
      seen.add(key)
      const chosen = [...state.chosen, i]
      const bad = indexes.filter((index) => rows[index].outcome !== "Target").length
      const otherTargets = indexes.filter((index) => rows[index].outcome === "Target" && rows[index].day !== "2026-10-09").length
      const result = { indexes, chosen, next: i + 1, bad, otherTargets }
      if (bad === 0) solutions.push(result)
      nextStates.push(result)
    }
  }
  if (solutions.length) break
  states = nextStates.sort((a, b) => a.bad - b.bad || b.otherTargets - a.otherTargets || a.indexes.length - b.indexes.length).slice(0, 50000)
}

const best = solutions.sort((a, b) => a.chosen.length - b.chosen.length || b.otherTargets - a.otherTargets || a.indexes.length - b.indexes.length)[0]
const selected = best ? best.indexes.map((index) => rows[index]) : []
const fullEnvelope = rows.filter((row) => envelopeRules.every((rule) => rule.test(row)))
const output = path.join(root, "csv", "2026-10-05-to-09-bid-recovery-oct9-seven-preserving-signals.csv")
const columns = Object.keys(rows[0])
const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`
fs.writeFileSync(output, [columns.join(","), ...selected.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n") + "\n")

console.log(JSON.stringify({
  protected: protectedRows.map((row) => ({ symbol: row.symbol, time: row.time, entry: row.entry, target: row.target,
    stop: row.stop, resolvedTime: row.resolvedTime })),
  usableRules: rules.length,
  minimumRuleCount: best?.chosen.length ?? null,
  rules: best?.chosen.map((index) => rules[index].name) ?? [],
  sensibleFrontier,
  branchCover,
  fullEnvelopeCounts: Object.fromEntries(["Target", "Stop", "Unresolved", "No entry candle"].map((outcome) =>
    [outcome, fullEnvelope.filter((row) => row.outcome === outcome).length])),
  selectedCounts: Object.fromEntries(["Target", "Stop", "Unresolved", "No entry candle"].map((outcome) =>
    [outcome, selected.filter((row) => row.outcome === outcome).length])),
  selected: selected.map((row) => ({ day: row.day, time: row.time, symbol: row.symbol, outcome: row.outcome })),
  output,
}, null, 2))
