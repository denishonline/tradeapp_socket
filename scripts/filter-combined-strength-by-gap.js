import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const targetDate = process.argv[2] || "2026-10-12"
const previousDate = process.argv[3] || "2026-10-09"
const maxGapPct = Number(process.argv[4] || 0.5)
const input = process.argv[5] || path.join(ROOT, "csv", "2026-10-06-to-12-0930-all-stock-combined-depth-candle-strength.csv")
const output = process.argv[6] || path.join(ROOT, "csv", "2026-10-06-to-12-0930-all-stock-combined-depth-candle-strength-gap-lte-0.5.csv")
const MINUTE = 60_000

function parseCsv(text) {
  const rows = []
  let row = []
  let value = ""
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++ }
      else quoted = !quoted
    } else if (character === "," && !quoted) {
      row.push(value); value = ""
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index++
      row.push(value); value = ""
      if (row.some((cell) => cell !== "")) rows.push(row)
      row = []
    } else value += character
  }
  if (value || row.length) { row.push(value); rows.push(row) }
  const [header, ...data] = rows
  return data.map((cells) => Object.fromEntries(header.map((column, index) => [column, cells[index] ?? ""])))
}

function csvValue(value) {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function indiaDate(at) {
  return new Date(at + 330 * MINUTE).toISOString().slice(0, 10)
}

function openingGap(symbol) {
  const candleFile = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(candleFile)) return null
  const previousCandles = new Map()
  const targetCandles = new Map()
  for (const line of fs.readFileSync(candleFile, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.partial) continue
    const at = Number(row.time) * 1000
    const open = Number(row.open)
    const close = Number(row.close)
    if (!Number.isFinite(at) || !(open > 0) || !(close > 0)) continue
    const date = indiaDate(at)
    if (date === previousDate) previousCandles.set(at, { at, close })
    else if (date === targetDate) targetCandles.set(at, { at, open })
  }
  const previous = [...previousCandles.values()].sort((left, right) => left.at - right.at).at(-1)
  const target = [...targetCandles.values()].sort((left, right) => left.at - right.at)[0]
  if (!previous || !target) return null
  return {
    previousClose: previous.close,
    openingPrice: target.open,
    gapPct: 100 * (target.open / previous.close - 1),
  }
}

const rows = parseCsv(fs.readFileSync(input, "utf8"))
const analyzed = rows.map((row) => {
  const gap = openingGap(row.symbol)
  return { ...row, previousClose: gap?.previousClose ?? null, openingPrice: gap?.openingPrice ?? null,
    gapPct: gap ? Number(gap.gapPct.toFixed(2)) : null,
    gapEligible: gap ? Math.abs(gap.gapPct) <= maxGapPct : false }
})
const eligible = analyzed.filter((row) => row.gapEligible)
  .sort((left, right) => Number(right.combinedAverage) - Number(left.combinedAverage))
eligible.forEach((row, index) => { row.filteredRank = index + 1 })
const columns = ["filteredRank", "symbol", "combinedAverage", "gapPct", "previousClose", "openingPrice",
  "totalMinutes", "qualifiedMinutes", "todayAverage", "periods"]
const csv = [columns.join(","), ...eligible.map((row) =>
  columns.map((column) => csvValue(row[column])).join(","))]
fs.writeFileSync(output, `${csv.join("\n")}\n`)
console.log(JSON.stringify({ targetDate, previousDate, maxAbsoluteGapPct: maxGapPct,
  requested: analyzed.length, eligible: eligible.length,
  excluded: analyzed.length - eligible.length, output, top10: eligible.slice(0, 10) }, null, 2))
