import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const CANDLE_ROOT = path.join(ROOT, "db", "candles")
const REPORT_ROOT = path.join(ROOT, "reports")
// Usage: node scripts/scan-ema10-20-trend-legs.js START_DATE END_DATE MIN_MOVE_PCT
// Example: node scripts/scan-ema10-20-trend-legs.js 2026-10-01 2026-10-29 2
const [startDate = "2026-10-05", endDate = "2026-10-16", rawThreshold = "1.5"] = process.argv.slice(2)
if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate || !Number.isFinite(+rawThreshold)) throw new Error("Usage: node scripts/scan-ema10-20-trend-legs.js START_DATE END_DATE MIN_MOVE_PCT")
const DATES = []
for (let d = new Date(`${startDate}T00:00:00Z`); d <= new Date(`${endDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) DATES.push(d.toISOString().slice(0, 10))
}
const DATE_SET = new Set(DATES)
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const THRESHOLD_PCT = Number(rawThreshold)

const indiaDate = (at) => new Date(at + IST_OFFSET).toISOString().slice(0, 10)
const indiaTime = (at) => new Date(at + IST_OFFSET).toISOString().slice(11, 16)
const pct = (value, base) => base > 0 ? 100 * (value / base - 1) : NaN
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function csvValue(value) {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function uniqueOutput(base, extension) {
  let index = 0
  while (true) {
    const suffix = index ? `-${index + 1}` : ""
    const filename = path.join(REPORT_ROOT, `${base}${suffix}.${extension}`)
    if (!fs.existsSync(filename)) return filename
    index++
  }
}

function loadCandles(symbol) {
  const filename = path.join(CANDLE_ROOT, `${symbol}.jsonl`)
  if (!fs.existsSync(filename)) return new Map()
  const byDate = new Map()
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      const at = Number(value.time) * 1000
      const date = indiaDate(at)
      const candle = {
        at, open: Number(value.open), high: Number(value.high), low: Number(value.low), close: Number(value.close), volume: Number(value.volume),
      }
      if (!DATE_SET.has(date) || !Object.values(candle).every(Number.isFinite) ||
          candle.open <= 0 || candle.volume <= 0 || candle.high < Math.max(candle.open, candle.close) ||
          candle.low > Math.min(candle.open, candle.close)) continue
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date).push(candle)
    } catch {
      // Ignore malformed historic records.
    }
  }
  for (const rows of byDate.values()) {
    rows.sort((left, right) => left.at - right.at)
    const unique = rows.filter((row, index) => !index || row.at !== rows[index - 1].at)
    rows.splice(0, rows.length, ...unique)
  }
  return byDate
}

function addEma(rows) {
  let ema10 = null
  let ema20 = null
  let previousSign = 0
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    ema10 = ema10 == null ? row.close : row.close * 2 / 11 + ema10 * 9 / 11
    ema20 = ema20 == null ? row.close : row.close * 2 / 21 + ema20 * 19 / 21
    row.ema10 = ema10
    row.ema20 = ema20
    row.sign = ema10 > ema20 ? 1 : ema10 < ema20 ? -1 : 0
    row.cross = index >= 19 && previousSign && row.sign && row.sign !== previousSign
    if (index >= 19 && row.sign) previousSign = row.sign
  }
}

function continuous(rows, from, to) {
  for (let index = from + 1; index <= to; index++) {
    if (rows[index].at !== rows[index - 1].at + MINUTE) return false
  }
  return true
}

function trendLeg(rows, symbol, date, cross, nextCross) {
  const entryIndex = cross.index + 1
  const exitIndex = nextCross.index + 1
  if (exitIndex >= rows.length || !continuous(rows, entryIndex, exitIndex)) return null
  const direction = cross.row.sign
  const entry = rows[entryIndex]
  const exit = rows[exitIndex]
  const path = rows.slice(entryIndex, nextCross.index + 1)
  const high = Math.max(...path.map((row) => row.high))
  const low = Math.min(...path.map((row) => row.low))
  const maxFavorablePct = direction > 0 ? pct(high, entry.open) : pct(entry.open, low)
  const maxAdversePct = direction > 0 ? pct(low, entry.open) : pct(entry.open, high)
  const returnPct = direction > 0 ? pct(exit.open, entry.open) : pct(entry.open, exit.open)
  const extreme = direction > 0
    ? path.reduce((best, row) => row.high > best.high ? row : best, path[0])
    : path.reduce((best, row) => row.low < best.low ? row : best, path[0])

  return {
    date, symbol, side: direction > 0 ? "BUY" : "SELL",
    crossoverTime: indiaTime(cross.row.at), entryTime: indiaTime(entry.at), entryPrice: round(entry.open),
    oppositeCrossoverTime: indiaTime(nextCross.row.at), exitTime: indiaTime(exit.at), exitPrice: round(exit.open),
    holdMinutes: (exit.at - entry.at) / MINUTE,
    returnPct: round(returnPct), maxFavorablePct: round(maxFavorablePct), maxAdversePct: round(maxAdversePct),
    extremeTime: indiaTime(extreme.at), crossedEma10: round(cross.row.ema10), crossedEma20: round(cross.row.ema20),
  }
}

function summarize(rows) {
  const returns = rows.map((row) => row.returnPct).filter(Number.isFinite)
  const adverse = rows.map((row) => row.maxAdversePct).filter(Number.isFinite)
  const byDate = new Map()
  for (const row of rows) byDate.set(row.date, (byDate.get(row.date) || 0) + row.returnPct)
  const worst = [...byDate.entries()].sort((left, right) => left[1] - right[1])[0]
  return {
    tradeCount: rows.length,
    winRatePct: round(100 * rows.filter((row) => row.returnPct > 0).length / (rows.length || 1), 2),
    averageReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1)),
    totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)),
    averageMaxAdversePct: round(adverse.reduce((sum, value) => sum + value, 0) / (adverse.length || 1)),
    worstMaxAdversePct: round(Math.min(...adverse)),
    worstDay: worst ? { date: worst[0], summedReturnPct: round(worst[1]) } : null,
  }
}

const symbols = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
  .map((symbol) => String(symbol).trim().toUpperCase().replace(/-EQ$/, ""))
const allLegs = []
const coverage = []

for (const symbol of symbols) {
  const byDate = loadCandles(symbol)
  let sessions = 0
  let candles = 0
  for (const date of DATES) {
    const rows = byDate.get(date) || []
    if (rows.length) sessions++
    candles += rows.length
    if (rows.length < 21) continue
    addEma(rows)
    const crosses = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.cross)
    for (let index = 0; index + 1 < crosses.length; index++) {
      const leg = trendLeg(rows, symbol, date, crosses[index], crosses[index + 1])
      if (leg) allLegs.push(leg)
    }
  }
  coverage.push({ symbol, sessions, candles })
}

const selected = allLegs.filter((row) => row.returnPct > THRESHOLD_PCT)
  .sort((left, right) => left.date.localeCompare(right.date) || left.entryTime.localeCompare(right.entryTime) || left.symbol.localeCompare(right.symbol))
const base = `${DATES[0]}-to-${DATES.at(-1)}-ema10-ema20-over-${THRESHOLD_PCT.toFixed(1).replace('.', 'p')}-trend-legs`
fs.mkdirSync(REPORT_ROOT, { recursive: true })
const outputCsv = uniqueOutput(base, "csv")
const outputJson = uniqueOutput(base, "json")
const columns = ["date", "symbol", "side", "crossoverTime", "entryTime", "entryPrice", "oppositeCrossoverTime", "exitTime", "exitPrice", "holdMinutes", "returnPct", "maxFavorablePct", "maxAdversePct", "extremeTime", "crossedEma10", "crossedEma20"]
fs.writeFileSync(outputCsv, `${[columns.join(","), ...selected.map((row) => columns.map((key) => csvValue(row[key])).join(","))].join("\n")}\n`)

const report = {
  methodology: "Each session is processed independently. EMA-10 and EMA-20 are seeded from the session's first close; crossover detection begins after 20 completed candles. A BUY/SELL leg starts at the next candle open after its crossover and exits at the next candle open after the opposite crossover. Only complete, minute-contiguous legs are evaluated.",
  threshold: { returnPct: `strictly greater than ${THRESHOLD_PCT}%`, selection: "return from entry to EMA reversal exit, not intraleg MFE" },
  dates: DATES,
  source: "db/candles/<SYMBOL>.jsonl",
  stocksScanned: symbols.length,
  coverage: { completeSessions: coverage.filter((row) => row.sessions === DATES.length).length, rows: coverage },
  allCompletedEmaLegs: summarize(allLegs),
  qualifyingLegs: summarize(selected),
  outputCsv,
  legs: selected,
}
fs.writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({
  stocksScanned: symbols.length,
  allCompletedEmaLegs: report.allCompletedEmaLegs,
  qualifyingLegs: report.qualifyingLegs,
  outputCsv,
  outputJson,
}, null, 2))
