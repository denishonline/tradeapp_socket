#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DATES = process.argv.slice(2).length ? process.argv.slice(2) : ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]
const IST_OFFSET_MS = 330 * 60_000
const dateAt = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
const timeAt = (seconds) => new Date(seconds * 1000 + IST_OFFSET_MS).toISOString().slice(11, 16)
const round = (value, digits = 3) => Number(value.toFixed(digits))
const unique = (base) => {
  let index = 1, file
  do { file = path.join(ROOT, "reports", `${base}${index === 1 ? "" : `-${index}`}.md`); index += 1 } while (fs.existsSync(file))
  return file
}

function sessionMoves(symbol) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const byDate = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    try {
      const row = JSON.parse(line)
      const candle = { time: Number(row.time), open: Number(row.open), close: Number(row.close) }
      const date = dateAt(candle.time)
      if (!DATES.includes(date) || !Number.isFinite(candle.open) || !Number.isFinite(candle.close)) continue
      const existing = byDate.get(date)
      if (!existing) byDate.set(date, { first: candle, last: candle })
      else {
        if (candle.time < existing.first.time) existing.first = candle
        if (candle.time > existing.last.time) existing.last = candle
      }
    } catch {}
  }
  return new Map([...byDate].map(([date, { first, last }]) => [date, {
    symbol, open: first.open, close: last.close, openTime: timeAt(first.time), closeTime: timeAt(last.time), intradayReturnPct: round((last.close / first.open - 1) * 100),
  }]))
}

const symbols = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
const movesByDate = new Map(DATES.map((date) => [date, []]))
for (const symbol of symbols) {
  for (const [date, move] of sessionMoves(symbol)) movesByDate.get(date).push(move)
}
const days = DATES.map((date) => {
  const movers = movesByDate.get(date)
  return {
    date,
    coverage: movers.length,
    gainers: [...movers].sort((a, b) => b.intradayReturnPct - a.intradayReturnPct).slice(0, 10),
    losers: [...movers].sort((a, b) => a.intradayReturnPct - b.intradayReturnPct).slice(0, 10),
  }
})

const table = (rows) => ["| Rank | Symbol | Open | Close | Intraday move |", "|---:|---|---:|---:|---:|", ...rows.map((row, index) => `| ${index + 1} | ${row.symbol} | ${row.open} | ${row.close} | ${row.intradayReturnPct >= 0 ? "+" : ""}${row.intradayReturnPct}% |`)].join("\n")
const report = [
  "# Top intraday movers: 26–29 October 2026",
  "",
  "Method: each stock's return is `(last one-minute close / first one-minute open − 1) × 100` for the same NSE session. This intentionally excludes the overnight gap from the prior day's close. Source: `db/candles/<SYMBOL>.jsonl`; timezone: IST.",
  "",
  ...days.flatMap((day) => [`## ${day.date} (${day.coverage} stocks with candles)`, "", "### Top 10 gainers", "", table(day.gainers), "", "### Top 10 losers", "", table(day.losers), ""]),
].join("\n")
const output = unique(`${DATES[0]}${DATES.length > 1 ? `-to-${DATES.at(-1)}` : ""}-top10-intraday-movers-ex-gap`)
fs.writeFileSync(output, `${report}\n`)
console.log(JSON.stringify({ output, days }, null, 2))
