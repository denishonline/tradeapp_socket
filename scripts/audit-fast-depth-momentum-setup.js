import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), MINUTE = 60_000
const source = path.join(ROOT, "csv", "2026-10-05-to-14-fast-depth-momentum-candidates-breadth.csv")
const [header, ...lines] = fs.readFileSync(source, "utf8").trim().split(/\r?\n/)
const fields = header.split(",")
const rows = lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
const number = (row, field) => Number(row[field])
const minute = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
const time = (at) => new Date(at + 330 * MINUTE).toISOString().slice(11, 16)
const round = (value, digits = 4) => Number(value.toFixed(digits))

function selected(row) {
  return minute(row.signalTime) <= 585 && number(row, "candleReturnPct") >= .4 &&
    number(row, "breakout10Pct") <= .1 && number(row, "breadthAverageReturnPct") <= .25 &&
    number(row, "breadthAverage3Pct") <= .1 && number(row, "dayReturnRankPct") >= 50 &&
    number(row, "avgBidPct") <= 60 && number(row, "volumeRatio10") >= .7 &&
    number(row, "return3Pct") >= .1 && number(row, "deltaPct") >= 0
}

const cache = new Map()
function candles(symbol, date) {
  const key = `${date}|${symbol}`
  if (cache.has(key)) return cache.get(key)
  const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T15:31:00+05:30`)
  const result = fs.readFileSync(path.join(ROOT, "db", "candles", `${symbol}.jsonl`), "utf8").split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line), at = Number(value.time) * 1000
      return !value.partial && at >= start && at < end
        ? [{ at, open: Number(value.open), high: Number(value.high), low: Number(value.low), close: Number(value.close) }] : []
    } catch { return [] }
  }).sort((a, b) => a.at - b.at)
  cache.set(key, result); return result
}

function evaluate(row) {
  const values = candles(row.symbol, row.date)
  const at = Date.parse(`${row.date}T${row.signalTime}:00+05:30`), index = values.findIndex((item) => item.at === at)
  const entry = values[index].close, future = values.slice(index + 1, index + 11)
  let outcome = "TIME", exitTime = future.at(-1)?.at ?? at, returnPct = future.length ? 100 * (future.at(-1).close / entry - 1) : 0
  for (const candle of future) {
    if (candle.low <= entry * .997) { outcome = "STOP"; exitTime = candle.at; returnPct = -.3; break }
    if (candle.high >= entry * 1.005) { outcome = "TARGET"; exitTime = candle.at; returnPct = .5; break }
  }
  if (future.length < 10 && outcome === "TIME") outcome = "PENDING"
  return { date: row.date, symbol: row.symbol, setupCandle: row.signalTime,
    actionableAt: time(at + MINUTE), entry, outcome, exitCandle: time(exitTime), returnPct: round(returnPct),
    holdMinutes: Math.max(0, Math.round((exitTime - at) / MINUTE)), candleReturnPct: row.candleReturnPct,
    volumeRatio10: row.volumeRatio10, return3Pct: row.return3Pct, breakout10Pct: row.breakout10Pct,
    avgBidPct: row.avgBidPct, ofi: row.ofi, deltaPct: row.deltaPct, midReturnPct: row.midReturnPct,
    breadthAverageReturnPct: row.breadthAverageReturnPct, breadthAverage3Pct: row.breadthAverage3Pct,
    dayReturnRankPct: row.dayReturnRankPct }
}

const signals = rows.filter(selected).map(evaluate).sort((a, b) => a.date.localeCompare(b.date) || a.setupCandle.localeCompare(b.setupCandle) || a.symbol.localeCompare(b.symbol))
const columns = Object.keys(signals[0])
const output = path.join(ROOT, "csv", "2026-10-05-to-14-fast-depth-momentum-setup-audit.csv")
fs.writeFileSync(output, [columns.join(","), ...signals.map((row) => columns.map((column) => row[column]).join(","))].join("\n") + "\n")
const summarize = (list) => ({ signals: list.length, targets: list.filter((row) => row.outcome === "TARGET").length,
  stops: list.filter((row) => row.outcome === "STOP").length, timed: list.filter((row) => row.outcome === "TIME").length,
  pending: list.filter((row) => row.outcome === "PENDING").length,
  grossReturnPct: round(list.filter((row) => row.outcome !== "PENDING").reduce((sum, row) => sum + row.returnPct, 0)),
  averageReturnPct: round(list.filter((row) => row.outcome !== "PENDING").reduce((sum, row) => sum + row.returnPct, 0) /
    Math.max(1, list.filter((row) => row.outcome !== "PENDING").length)) })
const byDate = Object.fromEntries([...new Set(signals.map((row) => row.date))].map((date) => [date, summarize(signals.filter((row) => row.date === date))]))
console.log(JSON.stringify({ output, overall: summarize(signals), byDate, today: signals.filter((row) => row.date === "2026-10-14") }, null, 2))
