import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)
const ROOT = process.cwd()
const dates = process.argv.slice(2).length ? process.argv.slice(2) : ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")))]
const worker = path.join(ROOT, "scripts", "score-minute-depth-candle-strength.js")
const MINUTE = 60_000
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value))
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const time = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  const columns = lines[0].split(",")
  return lines.slice(1).map((line) => {
    const values = []
    let value = ""
    let quoted = false
    for (let index = 0; index < line.length; index++) {
      const character = line[index]
      if (character === '"') {
        if (quoted && line[index + 1] === '"') { value += '"'; index++ }
        else quoted = !quoted
      } else if (character === "," && !quoted) { values.push(value); value = "" }
      else value += character
    }
    values.push(value)
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]))
  })
}

async function ensureStrengthFiles() {
  const jobs = []
  for (const date of dates) for (const symbol of symbols) {
    const file = path.join(ROOT, "csv", `${date}-${symbol}-0917-to-1000-bearish-depth-candle-strength.csv`)
    if (!fs.existsSync(file)) jobs.push({ date, symbol })
  }
  let cursor = 0
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (cursor < jobs.length) {
      const { date, symbol } = jobs[cursor++]
      try {
        await exec(process.execPath, [worker, symbol, date, "09:17", "10:00", "--compact", "--bearish"],
          { cwd: ROOT, maxBuffer: 2 * 1024 * 1024 })
      } catch { /* Missing or incomplete stocks are omitted below. */ }
    }
  }))
}

function candlesFor(symbol, date) {
  const start = Date.parse(`${date}T09:15:00+05:30`)
  const end = Date.parse(`${date}T10:01:00+05:30`)
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const row = JSON.parse(line)
      const at = Number(row.time) * 1000
      const values = [row.open, row.high, row.low, row.close, row.volume].map(Number)
      if (row.partial || at < start || at >= end || !values.every(Number.isFinite)) return []
      return [{ at, open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4] }]
    } catch { return [] }
  }).sort((left, right) => left.at - right.at)
}

await ensureStrengthFiles()
const candidates = []

for (const date of dates) for (const symbol of symbols) {
  const candles = candlesFor(symbol, date)
  const strengthFile = path.join(ROOT, "csv", `${date}-${symbol}-0917-to-1000-bearish-depth-candle-strength.csv`)
  if (candles.length < 15 || !fs.existsSync(strengthFile)) continue
  const depthRows = parseCsv(fs.readFileSync(strengthFile, "utf8"))
  const depthByTime = new Map(depthRows.map((row) => [row.time, row]))
  const stockCandidates = []

  for (let index = 8; index < candles.length; index++) {
    const signal = candles[index]
    const signalTime = time(signal.at)
    const depth = depthByTime.get(signalTime)
    if (!depth) continue
    const before = candles.slice(0, index)
    let lowIndex = 0
    for (let i = 1; i < before.length; i++) if (before[i].low < before[lowIndex].low) lowIndex = i
    let peakIndex = lowIndex
    for (let i = lowIndex + 1; i < before.length; i++) if (before[i].high >= before[peakIndex].high) peakIndex = i
    if (peakIndex <= lowIndex || index - peakIndex < 1 || index - peakIndex > 5 || peakIndex - lowIndex < 2) continue

    const low = before[lowIndex]
    const peak = before[peakIndex]
    const sessionHighBefore = Math.max(...before.map((row) => row.high))
    const recoveryPct = pct(peak.high, low.low)
    const peakVsSessionHighPct = pct(peak.high, sessionHighBefore)
    const pullbackPct = pct(signal.close, peak.high)
    const last3 = candles.slice(Math.max(0, index - 2), index + 1)
    const return3Pct = pct(last3.at(-1).close, last3[0].open)
    const currentReturnPct = pct(signal.close, signal.open)
    if (recoveryPct < 0.30 || peakVsSessionHighPct < -0.12 || pullbackPct > -0.04 || pullbackPct < -0.70 ||
        currentReturnPct >= -0.02 || return3Pct >= 0) continue

    const recentDepth = candles.slice(Math.max(0, index - 2), index + 1)
      .map((row) => depthByTime.get(time(row.at))).filter(Boolean)
    const diagnosticScore = Number(depth.diagnosticScore)
    const sellDeltaPct = Number(depth.directionalDeltaPct)
    const askSharePct = Number(depth.averageSideSharePct)
    const sellOfi = Number(depth.directionalOfi)
    const askDominantPct = Number(depth.sideDominantTicksPct)
    const recentBearishAverage = mean(recentDepth.map((row) => Number(row.diagnosticScore)).filter(Number.isFinite))
    const bearishChecks = [diagnosticScore >= 55, sellDeltaPct > 0, askSharePct >= 50, sellOfi > 0, askDominantPct >= 50]
    const bearishChecksPassed = bearishChecks.filter(Boolean).length
    if (bearishChecksPassed < 5 || diagnosticScore < 50) continue

    const pricePatternScore = 100 * (0.30 * clamp(recoveryPct / 0.80) +
      0.20 * clamp((peakVsSessionHighPct + 0.12) / 0.12) +
      0.20 * clamp((-pullbackPct - 0.04) / 0.25) +
      0.15 * clamp(-currentReturnPct / 0.20) +
      0.15 * clamp(-return3Pct / 0.30))
    const depthConfirmationScore = 0.45 * diagnosticScore + 0.20 * recentBearishAverage +
      0.15 * clamp(sellDeltaPct / 60) * 100 + 0.10 * clamp((askSharePct - 50) / 20) * 100 +
      0.10 * clamp(sellOfi / 0.20) * 100
    const setupScore = 0.55 * depthConfirmationScore + 0.45 * pricePatternScore
    stockCandidates.push({
      date, symbol, signalTime, lowTime: time(low.at), peakTime: time(peak.at),
      recoveryPct, pullbackPct, currentReturnPct, return3Pct,
      diagnosticScore, recentBearishAverage, sellDeltaPct, askSharePct, sellOfi,
      askDominantPct, bearishChecksPassed, pricePatternScore, depthConfirmationScore, setupScore,
    })
  }
  if (stockCandidates.length) {
    stockCandidates.sort((left, right) => right.setupScore - left.setupScore)
    candidates.push(stockCandidates[0])
  }
}

candidates.sort((left, right) => right.setupScore - left.setupScore)
candidates.forEach((row, index) => { row.rank = index + 1 })
const columns = ["rank", "date", "symbol", "signalTime", "lowTime", "peakTime", "setupScore",
  "recoveryPct", "pullbackPct", "currentReturnPct", "return3Pct", "diagnosticScore",
  "recentBearishAverage", "sellDeltaPct", "askSharePct", "sellOfi", "askDominantPct",
  "bearishChecksPassed", "pricePatternScore", "depthConfirmationScore"]
const outputFile = path.join(ROOT, "csv", "2026-10-06-to-09-through-1000-low-high-bearish-rollover.csv")
const output = [columns.join(","), ...candidates.map((row) => columns.map((column) =>
  csvValue(typeof row[column] === "number" ? round(row[column], column === "sellOfi" ? 4 : 2) : row[column])).join(","))].join("\n") + "\n"
fs.writeFileSync(outputFile, output)
console.log(JSON.stringify({ scannedDates: dates, stocks: symbols.length, matches: candidates.length, top10: candidates.slice(0, 10).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "number" ? round(value, key === "sellOfi" ? 4 : 2) : value]))), outputFile }, null, 2))
