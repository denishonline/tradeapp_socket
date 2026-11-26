#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const IST_OFFSET_MS = 330 * 60_000
const dates = process.argv.slice(2).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
const targetDates = dates.length ? dates : ["2026-10-28", "2026-10-29"]
const dateOf = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const minuteOf = (seconds) => { const d = new Date(seconds * 1000 + IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function readCandles(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const row = JSON.parse(line)
      const candle = { time: Number(row.time), high: Number(row.high), low: Number(row.low), open: Number(row.open), close: Number(row.close), volume: Number(row.volume), date: dateOf(Number(row.time)), minute: minuteOf(Number(row.time)) }
      return [candle].every((item) => [item.time, item.high, item.low, item.open, item.close, item.volume].every(Number.isFinite)) ? [candle] : []
    } catch { return [] }
  }).sort((a, b) => a.time - b.time)
}

function historyMetrics(symbol, targetDate) {
  const all = readCandles(symbol)
  const sessions = [...new Set(all.map((row) => row.date))].filter((date) => date <= targetDate).slice(-31)
  const rows = []
  for (let index = 1; index < sessions.length; index += 1) {
    const date = sessions[index]
    const previous = all.filter((row) => row.date === sessions[index - 1])
    const day = all.filter((row) => row.date === date)
    const opening = day.filter((row) => row.minute >= 555 && row.minute <= 565)
    const first5 = day.filter((row) => row.minute >= 555 && row.minute <= 559)
    const at925 = day.find((row) => row.minute === 565)
    if (!opening.length || !first5.length || !at925 || !previous.length) continue
    const prevHigh = Math.max(...previous.map((row) => row.high))
    rows.push({
      date,
      move: (at925.close / opening[0].open - 1) * 100,
      range: (Math.max(...opening.map((row) => row.high)) / Math.min(...opening.map((row) => row.low)) - 1) * 100,
      volume5: first5.reduce((sum, row) => sum + row.volume, 0),
      volume925: at925.volume,
      green: opening.filter((row) => row.close > row.open).length / opening.length * 100,
      reclaim: (at925.close / prevHigh - 1) * 100,
    })
  }
  const target = rows.at(-1)
  const history = rows.slice(0, -1)
  if (!target || history.length < 5) return null
  const fields = ["move", "range", "volume5", "volume925", "green", "reclaim"]
  const percentiles = Object.fromEntries(fields.map((field) => {
    const values = history.map((row) => row[field]).sort((a, b) => a - b)
    return [field, round(100 * values.filter((value) => value <= target[field]).length / values.length, 1)]
  }))
  const highCount = fields.filter((field) => percentiles[field] >= 80).length
  return { ...percentiles, highCount }
}

const outputRows = []
for (const targetDate of targetDates) {
  const reportPath = path.join(ROOT, "reports", `${targetDate}-1529-resistance-support-acceleration-loose.json`)
  if (!fs.existsSync(reportPath)) continue
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
  for (const signal of report.rows.filter((row) => row["RETURN FROM SUPPORT %"] >= 2)) {
    const history = historyMetrics(signal.STOCK, targetDate)
    outputRows.push({ DATE: targetDate, STOCK: signal.STOCK, BREAKOUT: signal.BREAKOUT, RETEST: signal.SUPPORT_RETEST, ACCEL: signal.ACCELERATION, "MOVE %": signal["RETURN FROM SUPPORT %"], "ACCEL %": signal["RETURN FROM ACCEL %"], "30D HIGH COUNT": history?.highCount ?? null, "30D MOVE PCTL": history?.move ?? null, "30D RANGE PCTL": history?.range ?? null, "30D VOL PCTL": history?.volume5 ?? null, "30D RECLAIM PCTL": history?.reclaim ?? null })
  }
}
outputRows.sort((a, b) => (b["30D HIGH COUNT"] ?? -1) - (a["30D HIGH COUNT"] ?? -1) || b["MOVE %"] - a["MOVE %"])
const output = path.join(ROOT, "reports", `${targetDates.join("-")}-resistance-break-2pct-history.json`)
fs.writeFileSync(output, `${JSON.stringify({ targetDates, rule: "Loose resistance/support/acceleration pattern plus realized move from support >= 2%. Historical count is the number of six opening metrics at or above the stock's 80th percentile across its prior 30 available sessions.", rows: outputRows }, null, 2)}\n`)
console.table(outputRows)
console.log(`Matched ${outputRows.length} signals; saved ${output}`)
