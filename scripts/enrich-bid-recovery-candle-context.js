import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const input = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-depth-microstructure-outcomes.csv")
const output = path.join(root, "csv", "2026-10-05-to-09-bid-supported-dip-recovery-full-context-outcomes.csv")
const minute = 60_000
const istOffset = 330 * minute
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const indiaDate = (at) => new Date(at + istOffset).toISOString().slice(0, 10)

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

function candles(symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      return [{ at: Number(row.time) * 1000, open: Number(row.open), high: Number(row.high), low: Number(row.low),
        close: Number(row.close), volume: Number(row.volume) }]
    } catch { return [] }
  }).filter((row) => Object.values(row).every(Number.isFinite)).sort((a, b) => a.at - b.at)
}

function context(all, day, signalAt) {
  const byDay = new Map()
  for (const candle of all) {
    const key = indiaDate(candle.at)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(candle)
  }
  const dates = [...byDay.keys()].sort()
  const today = byDay.get(day) || []
  const index = today.findIndex((candle) => candle.at === signalAt - minute)
  if (index < 0) return {}
  const seen = today.slice(0, index + 1)
  const current = seen.at(-1)
  const previousDates = dates.filter((date) => date < day)
  const previous = byDay.get(previousDates.at(-1)) || []
  const priorClose = previous.at(-1)?.close
  const priorHigh = previous.length ? Math.max(...previous.map((row) => row.high)) : NaN
  const priorLow = previous.length ? Math.min(...previous.map((row) => row.low)) : NaN
  const priorOpen = previous[0]?.open
  const last5 = seen.slice(-5), prior5 = seen.slice(-10, -5), last14 = seen.slice(-14)
  const sumVolume = (items) => items.reduce((sum, row) => sum + row.volume, 0)
  const openingVolume = sumVolume(seen)
  const comparisonVolumes = previousDates.slice(-4).map((date) => sumVolume((byDay.get(date) || []).slice(0, seen.length)))
    .filter((value) => value > 0)
  const averageOpeningVolume = comparisonVolumes.length ? comparisonVolumes.reduce((a, b) => a + b, 0) / comparisonVolumes.length : NaN
  const trueRanges = last14.map((row, offset) => {
    const globalIndex = index - last14.length + 1 + offset
    const prior = today[globalIndex - 1]?.close ?? row.open
    return Math.max(row.high - row.low, Math.abs(row.high - prior), Math.abs(row.low - prior))
  })
  const range5High = Math.max(...last5.map((row) => row.high))
  const range5Low = Math.min(...last5.map((row) => row.low))
  const totalRange3 = seen.slice(-3).reduce((sum, row) => sum + Math.max(0, row.high - row.low), 0)
  const netBody3 = seen.slice(-3).reduce((sum, row) => sum + row.close - row.open, 0)
  return {
    openingGapPct: round(pct(today[0]?.open, priorClose)),
    priorDayReturnPct: round(pct(previous.at(-1)?.close, priorOpen)),
    signalVsPriorClosePct: round(pct(current.close, priorClose)),
    signalVsPriorHighPct: round(pct(current.close, priorHigh)),
    signalVsPriorLowPct: round(pct(current.close, priorLow)),
    priorCloseLocationPct: round(priorHigh > priorLow ? 100 * (priorClose - priorLow) / (priorHigh - priorLow) : NaN),
    openingVolumeRatio: round(openingVolume / averageOpeningVolume),
    volume5VsPrior5: round(prior5.length === 5 && sumVolume(prior5) > 0 ? sumVolume(last5) / sumVolume(prior5) : NaN),
    atr14Pct: round(last14.length === 14 ? 100 * trueRanges.reduce((a, b) => a + b, 0) / last14.length / current.close : NaN),
    range5Pct: round(100 * (range5High - range5Low) / current.close),
    closeLocation5Pct: round(range5High > range5Low ? 100 * (current.close - range5Low) / (range5High - range5Low) : NaN),
    bodyStrength3Pct: round(totalRange3 > 0 ? 100 * netBody3 / totalRange3 : NaN),
    greenCloses5: last5.filter((row) => row.close > row.open).length,
    redCloses5: last5.filter((row) => row.close < row.open).length,
  }
}

const rows = csvRows(input)
const symbols = [...new Set(rows.map((row) => row.symbol))]
for (const symbol of symbols) {
  const all = candles(symbol)
  for (const row of rows.filter((item) => item.symbol === symbol)) {
    const signalAt = Date.parse(`${row.day}T${row.time}:00+05:30`)
    Object.assign(row, context(all, row.day, signalAt))
  }
}

const columns = Object.keys(rows[0])
const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`
fs.writeFileSync(output, [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n") + "\n")
console.log(JSON.stringify({ input, output, signals: rows.length, symbols: symbols.length }, null, 2))
