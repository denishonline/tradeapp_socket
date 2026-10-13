import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const sources = [
  ["2026-10-06", "2026-10-06-0917-to-1530-all-stock-bullish-depth-candle-strength.csv"],
  ["2026-10-07", "2026-10-07-0917-to-1530-all-stock-bullish-depth-candle-strength.csv"],
  ["2026-10-08", "2026-10-08-0917-to-1530-all-stock-bullish-depth-candle-strength.csv"],
  ["2026-10-09", "2026-10-09-0917-to-1207-all-stock-bullish-depth-candle-strength.csv"],
  ["2026-10-12 through 10:00", "2026-10-12-0917-to-1000-all-stock-bullish-depth-candle-strength.csv"],
]

function parseCsvLine(line) {
  const values = []
  let value = ""
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index++
      } else quoted = !quoted
    } else if (char === "," && !quoted) {
      values.push(value)
      value = ""
    } else value += char
  }
  values.push(value)
  return values
}

function readCsv(filename) {
  const lines = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const columns = parseCsvLine(lines[0])
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line)
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]))
  })
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : ""
const bySymbol = new Map()

for (const [label, filename] of sources) {
  for (const row of readCsv(path.join(ROOT, "csv", filename))) {
    const record = bySymbol.get(row.symbol) || {
      symbol: row.symbol, scoreSum: 0, gatedScoreSum: 0, minutes: 0,
      qualifiedMinutes: 0, score70PlusMinutes: 0, allEightMetricMinutes: 0,
    }
    const minutes = Number(row.minutes)
    const score = Number(row.averageScore)
    const gated = Number(row.averageGatedScore)
    record[`${label} average`] = round(score)
    record[`${label} minutes`] = minutes
    record.scoreSum += minutes * score
    record.gatedScoreSum += minutes * gated
    record.minutes += minutes
    record.qualifiedMinutes += Number(row.qualifiedMinutes) || 0
    record.score70PlusMinutes += Number(row.passBullishScore) || 0
    record.allEightMetricMinutes += Number(row.passAllEight) || 0
    bySymbol.set(row.symbol, record)
  }
}

const rows = [...bySymbol.values()].map((record) => ({
  symbol: record.symbol,
  combinedAverageScore: round(record.scoreSum / record.minutes),
  combinedAverageGatedScore: round(record.gatedScoreSum / record.minutes),
  scoredMinutes: record.minutes,
  qualifiedMinutes: record.qualifiedMinutes,
  score70PlusMinutes: record.score70PlusMinutes,
  allEightMetricMinutes: record.allEightMetricMinutes,
  ...Object.fromEntries(sources.flatMap(([label]) => [
    [`${label} average`, record[`${label} average`] ?? ""],
    [`${label} minutes`, record[`${label} minutes`] ?? ""],
  ])),
})).sort((left, right) => right.combinedAverageScore - left.combinedAverageScore)
rows.forEach((row, index) => { row.rank = index + 1 })

const columns = ["rank", "symbol", "combinedAverageScore", "combinedAverageGatedScore", "scoredMinutes",
  "qualifiedMinutes", "score70PlusMinutes", "allEightMetricMinutes",
  ...sources.flatMap(([label]) => [`${label} average`, `${label} minutes`])]
const output = path.join(ROOT, "csv", "2026-10-06-to-12-1000-history-plus-today-bullish-candle-depth-scores.csv")
const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))]
fs.writeFileSync(output, `${csv.join("\n")}\n`)
console.log(JSON.stringify({ stocks: rows.length, output, top10: rows.slice(0, 10) }, null, 2))
