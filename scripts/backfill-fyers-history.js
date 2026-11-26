#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import apiV3 from "fyers-api-v3"
import { createCandleStore, normalizeCandle } from "../ui/candles.js"
import { toFyersIndexSymbol, toFyersSymbol } from "../ui/market-data.js"

const ROOT = process.cwd(), CANDLES = path.join(ROOT, "db", "candles"), REPORTS = path.join(ROOT, "reports")
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] }
const from = arg("--from") ?? "2026-08-01", to = arg("--to") ?? "2026-08-31"
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
if (!validDate(from) || !validDate(to) || from > to) throw new Error("Usage: node scripts/backfill-fyers-history.js --from YYYY-MM-DD --to YYYY-MM-DD")

const IST_MS = 330 * 60_000
const dateAt = epoch => new Date(epoch * 1000 + IST_MS).toISOString().slice(0, 10)
const epochForIst = (date, hour, minute) => {
  const [year, month, day] = date.split("-").map(Number)
  return Math.floor(Date.UTC(year, month - 1, day, hour - 5, minute - 30) / 1000)
}
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const sessionDates = () => {
  const dates = []
  for (let value = new Date(`${from}T00:00:00Z`); value <= new Date(`${to}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1)) {
    if (![0, 6].includes(value.getUTCDay())) dates.push(value.toISOString().slice(0, 10))
  }
  return dates
}
const storedDates = symbol => {
  const available = new Set(), file = path.join(CANDLES, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return available
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    try { available.add(dateAt(Number(JSON.parse(line).time))) } catch {}
  }
  return available
}
const uniqueReport = stem => {
  let suffix = 1, file
  do { file = path.join(REPORTS, `${stem}${suffix === 1 ? "" : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
  return file
}

const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")).map(String).filter(Boolean))]
const symbols = [...stocks, "NIFTY50"]
const token = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "token"), "utf8"))
if (typeof token !== "string" || !token.trim()) throw new Error("FYERS access token is missing. Run AutoLogin, then retry.")
const { CONSTANT } = await import("../constant.js")
const client = new apiV3.fyersModel({ enableLogging: false })
client.setAppId(CONSTANT.appId)
client.setAccessToken(token.trim())
const store = await createCandleStore({ directory: CANDLES, symbols })
const requestedDates = sessionDates()
const rangeFrom = String(epochForIst(from, 9, 15)), rangeTo = String(epochForIst(to, 15, 30) - 1)

async function fetch(symbol) {
  const response = await client.getHistory({
    symbol: symbol === "NIFTY50" ? toFyersIndexSymbol(symbol) : toFyersSymbol(symbol),
    resolution: "1", date_format: "0", range_from: rangeFrom, range_to: rangeTo, cont_flag: "1",
  })
  if (response?.s !== "ok" || !Array.isArray(response.candles)) throw new Error(response?.message || response?.msg || "FYERS returned no candles")
  const incoming = response.candles.flatMap(row => {
    if (!Array.isArray(row) || row.length < 6) return []
    const candle = normalizeCandle({ time: +row[0], open: +row[1], high: +row[2], low: +row[3], close: +row[4], volume: +row[5], source: "fyers-history" })
    return candle && dateAt(candle.time) >= from && dateAt(candle.time) <= to ? [candle] : []
  })
  return { ...await store.fillMissingHistory(symbol, incoming), received: incoming.length }
}

const index = await fetch("NIFTY50")
const availableDates = requestedDates.filter(date => storedDates("NIFTY50").has(date))
if (!availableDates.length) throw new Error("FYERS returned no NIFTY50 trading sessions for the requested period.")
console.log(`NIFTY50: ${index.added} missing candles added; ${availableDates.length} trading session(s) found.`)

let added = index.added, received = index.received
const failures = [], results = []
for (let index = 0; index < stocks.length; index++) {
  const symbol = stocks[index]
  try {
    const result = await fetch(symbol)
    added += result.added; received += result.received
    results.push({ symbol, added: result.added, received: result.received })
  } catch (error) {
    failures.push({ symbol, message: error.message })
  }
  process.stdout.write(`\rFYERS August backfill ${index + 1}/${stocks.length} · added ${added} · failures ${failures.length}`)
  if (index < stocks.length - 1) await pause(1250) // Standard-plan limit: stay below 50 data requests/minute.
}
process.stdout.write("\n")

const missingBySymbol = stocks.flatMap(symbol => {
  const dates = storedDates(symbol)
  const missing = availableDates.filter(date => !dates.has(date))
  return missing.length ? [{ symbol, missingSessions: missing }] : []
})
const output = {
  from, to, candleInterval: "1 minute", timezone: "Asia/Kolkata", source: "FYERS History API",
  requestedWeekdays: requestedDates, confirmedTradingSessions: availableDates,
  symbols: stocks.length, receivedCandles: received, addedMissingCandles: added,
  failures, symbolsMissingAnyConfirmedSession: missingBySymbol, results,
  method: "Additive merge only: existing timestamped candles were retained; FYERS history filled absent timestamps.",
}
const report = uniqueReport(`fyers-history-backfill-${from}-to-${to}`)
fs.writeFileSync(report, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
console.log(JSON.stringify({ report, addedMissingCandles: added, failures: failures.length, symbolsMissingAnyConfirmedSession: missingBySymbol.length }, null, 2))
