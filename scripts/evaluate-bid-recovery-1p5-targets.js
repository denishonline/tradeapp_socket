import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const input = process.argv[2] ? path.resolve(process.argv[2]) :
  path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-broadened-audit.csv")
const inputStem = path.basename(input, ".csv")
const output = path.join(root, "csv", `${inputStem}-1p5-target-outcomes.csv`)
const selectedOutput = path.join(root, "csv", `${inputStem}-1p5-zero-loss-signals.csv`)
const targetPct = 1.5
const stopPct = 0.4
const istOffset = 330 * 60_000
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const indiaDate = (at) => new Date(at + istOffset).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + istOffset).toISOString().slice(11, 16)

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
  return lines.slice(1).map((line) => Object.fromEntries(parse(line).map((value, index) =>
    [columns[index], value])))
}

const candleCache = new Map()
function candles(symbol, day) {
  const key = `${day}|${symbol}`
  if (candleCache.has(key)) return candleCache.get(key)
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      const at = Number(row.time) * 1000
      return indiaDate(at) === day ? [{ at, open: Number(row.open), high: Number(row.high),
        low: Number(row.low), close: Number(row.close) }] : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
  candleCache.set(key, rows)
  return rows
}

function outcome(signal) {
  const rows = candles(signal.symbol, signal.day)
  const entryIndex = rows.findIndex((row) => indiaTime(row.at) === signal.time)
  if (entryIndex < 0) return { outcome: "No entry candle" }
  const entry = rows[entryIndex].open
  const direction = signal.side === "BUY" ? 1 : -1
  const target = entry * (1 + direction * targetPct / 100)
  const stop = entry * (1 - direction * stopPct / 100)
  let maxFavourable = 0, maxAdverse = 0
  for (const row of rows.slice(entryIndex)) {
    const favourable = direction > 0 ? pct(row.high, entry) : pct(entry, row.low)
    const adverse = direction > 0 ? pct(entry, row.low) : pct(row.high, entry)
    maxFavourable = Math.max(maxFavourable, favourable)
    maxAdverse = Math.max(maxAdverse, adverse)
    const hitTarget = direction > 0 ? row.high >= target : row.low <= target
    const hitStop = direction > 0 ? row.low <= stop : row.high >= stop
    if (hitStop) return { outcome: "Stop", resolvedTime: indiaTime(row.at + 60_000), entry,
      target, stop, maxFavourable, maxAdverse }
    if (hitTarget) return { outcome: "Target", resolvedTime: indiaTime(row.at + 60_000), entry,
      target, stop, maxFavourable, maxAdverse }
  }
  return { outcome: "Unresolved", resolvedTime: "", entry, target, stop, maxFavourable, maxAdverse }
}

const numeric = new Set(["confirmationScore", "returnOpen", "return3", "return5", "return10",
  "return15", "rsi14", "mfi14", "vwapGap5", "vwapGap15", "directionVolume5",
  "directionVolume10", "recoveryLow", "pullbackHigh", "directionalDepth", "directionalTop2",
  "depthMinutes", "depthImbalance3"])
const signals = csvRows(input).map((row) => {
  const parsed = Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, numeric.has(key) ? Number(value) : value]))
  const resolved = outcome(parsed)
  return { ...parsed, entry: round(resolved.entry), target: round(resolved.target), stop: round(resolved.stop),
    outcome: resolved.outcome, resolvedTime: resolved.resolvedTime,
    maxFavourable: round(resolved.maxFavourable), maxAdverse: round(resolved.maxAdverse) }
})

function counts(rows) {
  return Object.fromEntries(["Target", "Stop", "Unresolved", "No entry candle"]
    .map((name) => [name, rows.filter((row) => row.outcome === name).length]))
}

function directional(row, field) {
  const sign = row.side === "BUY" ? 1 : -1
  return sign * row[field]
}

const ruleDefs = [
  ...[5, 6, 7].map((x) => ({ name: `score>=${x}`, test: (r) => r.confirmationScore >= x })),
  ...["10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"].map((x) =>
    ({ name: `time<=${x}`, test: (r) => r.time <= x })),
  ...[60, 65, 70, 75, 80, 85].map((x) => ({ name: `depth>=${x}`, test: (r) => r.directionalDepth >= x })),
  ...[50, 55, 60, 65, 70, 75, 80].map((x) => ({ name: `top2>=${x}`, test: (r) => r.directionalTop2 >= x })),
  ...[55, 60, 65, 70, 75].map((x) => ({ name: `volume5>=${x}`, test: (r) => r.directionVolume5 >= x })),
  ...[50, 55, 60, 65, 70].map((x) => ({ name: `volume10>=${x}`, test: (r) => r.directionVolume10 >= x })),
  ...[-0.05, 0, 0.03, 0.05, 0.10].map((x) => ({ name: `dirReturn3>=${x}`, test: (r) => directional(r, "return3") >= x })),
  ...[-0.10, -0.05, 0, 0.05, 0.10].map((x) => ({ name: `dirReturn5>=${x}`, test: (r) => directional(r, "return5") >= x })),
  ...[-0.10, -0.05, 0, 0.05].map((x) => ({ name: `dirVwap5>=${x}`, test: (r) => directional(r, "vwapGap5") >= x })),
  ...[0, 0.03, 0.05, 0.10, 0.15].map((x) => ({ name: `dirDepth3>=${x}`, test: (r) => directional(r, "depthImbalance3") >= x })),
  ...[-0.20, -0.30, -0.40, -0.50, -0.60].map((x) => ({ name: `dirReturn15<=${x}`,
    test: (r) => directional(r, "return15") <= x })),
  ...[0.40, 0.50, 0.60, 0.70].map((x) => ({ name: `turnFromExtreme>=${x}`,
    test: (r) => (r.side === "BUY" ? r.recoveryLow : r.pullbackHigh) >= x })),
  ...[0.80, 1.00, 1.20, 1.40].map((x) => ({ name: `oppositeExtremeDistance>=${x}`,
    test: (r) => (r.side === "BUY" ? r.pullbackHigh : r.recoveryLow) >= x })),
  ...[0.20, 0.30, 0.40, 0.50].map((x) => ({ name: `absReturn15<=${x}`, test: (r) => Math.abs(r.return15) <= x })),
  ...[0.50, 0.75, 1.00, 1.25].map((x) => ({ name: `maxAdmissibleOpenMove<=${x}`, test: (r) => Math.abs(r.returnOpen) <= x })),
]

function selectRules(rows, preference = "total") {
  let beam = [{ indexes: rows.map((_, i) => i), rules: [], nextRule: 0 }]
  const zeroBad = []
  const seen = new Set()
  for (let depth = 1; depth <= 5; depth++) {
    const expanded = []
    for (const state of beam) {
      for (let i = state.nextRule; i < ruleDefs.length; i++) {
        const indexes = state.indexes.filter((index) => ruleDefs[i].test(rows[index]))
        if (!indexes.length) continue
        const key = indexes.join(",")
        if (seen.has(key)) continue
        seen.add(key)
        const targets = indexes.filter((index) => rows[index].outcome === "Target").length
        const bad = indexes.length - targets
        const next = { indexes, rules: [...state.rules, ruleDefs[i].name], nextRule: i + 1,
          targets, bad, purity: targets / indexes.length }
        if (!bad) {
          next.oct9Targets = indexes.filter((index) => rows[index].outcome === "Target" &&
            rows[index].day === "2026-10-09").length
          next.buyTargets = indexes.filter((index) => rows[index].outcome === "Target" && rows[index].side === "BUY").length
          next.sellTargets = indexes.filter((index) => rows[index].outcome === "Target" && rows[index].side === "SELL").length
          zeroBad.push(next)
        }
        expanded.push(next)
      }
    }
    beam = expanded.sort((a, b) => (b.purity - a.purity) || (b.targets - a.targets) ||
      (a.rules.length - b.rules.length)).slice(0, 500)
  }
  if (preference === "balanced") return zeroBad.filter((row) => row.buyTargets && row.sellTargets)
    .sort((a, b) => (Math.min(b.buyTargets, b.sellTargets) - Math.min(a.buyTargets, a.sellTargets)) ||
      (b.targets - a.targets) || (b.oct9Targets - a.oct9Targets) || (a.rules.length - b.rules.length))[0] || null
  return zeroBad.sort((a, b) => preference === "oct9" ?
    (b.oct9Targets - a.oct9Targets) || (b.targets - a.targets) || (a.rules.length - b.rules.length) :
    (b.targets - a.targets) || (b.oct9Targets - a.oct9Targets) || (a.rules.length - b.rules.length))[0] || null
}

const recommended = Object.fromEntries(["BUY", "SELL"].map((side) => {
  const sideRows = signals.filter((row) => row.side === side)
  const selected = selectRules(sideRows)
  const oct9Selected = selectRules(sideRows, "oct9")
  const simplify = (value) => value && { rules: value.rules, targets: value.targets,
    oct9Targets: value.oct9Targets, signals: value.indexes.map((index) => sideRows[index]) }
  return [side, { maximumTargets: simplify(selected), retainOctober9: simplify(oct9Selected) }]
}))
const exactMirrorSelection = selectRules(signals, "balanced")

const columns = Object.keys(signals[0])
const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`
fs.writeFileSync(output, [columns.join(","), ...signals.map((row) =>
  columns.map((key) => escape(row[key])).join(","))].join("\n") + "\n")
const exactRows = exactMirrorSelection ? exactMirrorSelection.indexes.map((index) => signals[index]) : []
fs.writeFileSync(selectedOutput, [columns.join(","), ...exactRows.map((row) =>
  columns.map((key) => escape(row[key])).join(","))].join("\n") + "\n")

export const result = { input, output, selectedOutput, assumptions: { targetPct, stopPct,
  entry: "next one-minute candle open", sameCandleTie: "Stop" },
  counts: Object.fromEntries(["BUY", "SELL"].map((side) => [side, counts(signals.filter((row) => row.side === side))])),
  recommended: Object.fromEntries(Object.entries(recommended).map(([side, groups]) => [side,
    Object.fromEntries(Object.entries(groups).map(([group, value]) => [group,
      value && { rules: value.rules, targets: value.targets, oct9Targets: value.oct9Targets,
        signals: value.signals.map((row) => ({ day: row.day, time: row.time, symbol: row.symbol,
          entry: row.entry, target: row.target, stop: row.stop, resolvedTime: row.resolvedTime })) }]))])),
  exactMirror: exactMirrorSelection && { rules: exactMirrorSelection.rules,
    targets: exactMirrorSelection.targets, buyTargets: exactMirrorSelection.buyTargets,
    sellTargets: exactMirrorSelection.sellTargets, oct9Targets: exactMirrorSelection.oct9Targets,
    signals: exactMirrorSelection.indexes.map((index) => { const row = signals[index]; return {
      day: row.day, time: row.time, symbol: row.symbol, side: row.side, entry: row.entry,
      target: row.target, stop: row.stop, resolvedTime: row.resolvedTime } }) } }

console.log(JSON.stringify(result, null, 2))
