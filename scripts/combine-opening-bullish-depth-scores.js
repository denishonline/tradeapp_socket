import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const dates = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]
const range = "0917-to-1000"

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

for (const date of dates) {
  const filename = path.join(ROOT, "csv", `${date}-${range}-all-stock-bullish-depth-candle-strength.csv`)
  for (const row of readCsv(filename)) {
    const symbol = row.symbol
    const record = bySymbol.get(symbol) || { symbol, scoreSum: 0, gatedScoreSum: 0, minutes: 0,
      qualifiedMinutes: 0, strongMinutes: 0, allEightMinutes: 0 }
    const minutes = Number(row.minutes)
    const averageScore = Number(row.averageScore)
    const averageGatedScore = Number(row.averageGatedScore)
    record[`${date}Average`] = round(averageScore)
    record[`${date}Minutes`] = minutes
    if (Number.isFinite(minutes) && Number.isFinite(averageScore)) {
      record.scoreSum += minutes * averageScore
      record.gatedScoreSum += minutes * (Number.isFinite(averageGatedScore) ? averageGatedScore : 0)
      record.minutes += minutes
    }
    record.qualifiedMinutes += Number(row.qualifiedMinutes) || 0
    record.strongMinutes += Number(row.passBullishScore) || 0
    record.allEightMinutes += Number(row.passAllEight) || 0
    bySymbol.set(symbol, record)
  }
}

const rows = [...bySymbol.values()].map((record) => ({
  symbol: record.symbol,
  combinedAverageScore: round(record.scoreSum / record.minutes),
  combinedAverageGatedScore: round(record.gatedScoreSum / record.minutes),
  scoredMinutes: record.minutes,
  coveragePct: round(100 * record.minutes / (dates.length * 44)),
  qualifiedMinutes: record.qualifiedMinutes,
  score70PlusMinutes: record.strongMinutes,
  allEightMetricMinutes: record.allEightMinutes,
  ...Object.fromEntries(dates.flatMap((date) => [
    [`${date}Average`, record[`${date}Average`] ?? ""],
    [`${date}Minutes`, record[`${date}Minutes`] ?? ""],
  ])),
})).sort((left, right) => right.combinedAverageScore - left.combinedAverageScore)

rows.forEach((row, index) => { row.rank = index + 1 })
const columns = ["rank", "symbol", "combinedAverageScore", "combinedAverageGatedScore",
  "scoredMinutes", "coveragePct", "qualifiedMinutes", "score70PlusMinutes", "allEightMetricMinutes",
  ...dates.flatMap((date) => [`${date}Average`, `${date}Minutes`])]
const output = path.join(ROOT, "csv", `${dates[0]}-to-${dates.at(-1)}-1000-combined-bullish-candle-depth-scores.csv`)
const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))]
fs.writeFileSync(output, `${csv.join("\n")}\n`)

console.log(JSON.stringify({ dates, window: "09:17-10:00", stocks: rows.length, output, top10: rows.slice(0, 10) }, null, 2))
