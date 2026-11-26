#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import {
  DEFAULT_PARAMS,
  datesInclusive,
  matchesCsv,
  scanOpeningSixFilters,
  uniqueReportPath,
} from "./lib/opening-six-filter.js"

const root = process.cwd()
const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}
const numberArg = (name, fallback) => arg(name) === null ? fallback : Number(arg(name))
const from = arg("--from")
const to = arg("--to")
if (!from || !to) throw new Error("Usage: node scripts/backtest-opening-six-filter.js --from YYYY-MM-DD --to YYYY-MM-DD [--symbols A,B]")

const params = {
  supertrendAtrPeriod: numberArg("--atr-period", DEFAULT_PARAMS.supertrendAtrPeriod),
  supertrendMultiplier: numberArg("--atr-multiplier", DEFAULT_PARAMS.supertrendMultiplier),
  pviEmaPeriod: numberArg("--pvi-ema-period", DEFAULT_PARAMS.pviEmaPeriod),
  priorPviSessions: numberArg("--prior-pvi-sessions", DEFAULT_PARAMS.priorPviSessions),
  minPriorGreenSupertrendBarsExclusive: numberArg("--min-prior-green-st-bars-exclusive", DEFAULT_PARAMS.minPriorGreenSupertrendBarsExclusive),
  minOpeningGapPctExclusive: numberArg("--min-gap-pct-exclusive", DEFAULT_PARAMS.minOpeningGapPctExclusive),
  maxOpeningGapPctInclusive: numberArg("--max-gap-pct", DEFAULT_PARAMS.maxOpeningGapPctInclusive),
  ema20StartTime: arg("--ema20-start") ?? DEFAULT_PARAMS.ema20StartTime,
  ema20EndTime: arg("--ema20-end") ?? DEFAULT_PARAMS.ema20EndTime,
  minEma20ChangePctInclusive: numberArg("--min-ema20-change-pct", DEFAULT_PARAMS.minEma20ChangePctInclusive),
  minFyers15mVwapGapPctInclusive: numberArg("--min-15m-vwap-gap-pct", DEFAULT_PARAMS.minFyers15mVwapGapPctInclusive),
}
if (Object.entries(params).some(([key, value]) => typeof value === "number" && !Number.isFinite(value))) throw new Error("All numeric parameters must be finite numbers")

const symbols = arg("--symbols")?.split(",").map((value) => value.trim()).filter(Boolean) ?? null
const result = scanOpeningSixFilters({ root, dates: datesInclusive(from, to), symbols, params })
const active = result.sessions.filter((session) => session.evaluableSymbols > 0)
console.table(active.map((session) => ({
  Date: session.date,
  Evaluated: session.evaluableSymbols,
  Stage1: session.stages[0].count,
  Stage2: session.stages[1].count,
  Stage3: session.stages[2].count,
  Stage4: session.stages[3].count,
  Stage5: session.stages[4].count,
  Stage6: session.stages[5].count,
  Symbols: session.matches.map((row) => row.symbol).join(" "),
})))

const base = `${from}-to-${to}-opening-six-filter-backtest`
const jsonFile = uniqueReportPath(root, base, "json")
const csvFile = jsonFile.replace(/\.json$/, ".csv")
fs.writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" })
fs.writeFileSync(csvFile, matchesCsv(result), { flag: "wx" })
console.log(`Sessions evaluated: ${active.length}`)
console.log(`Total matches: ${active.reduce((sum, session) => sum + session.matches.length, 0)}`)
console.log(`JSON: ${path.relative(root, jsonFile)}`)
console.log(`CSV: ${path.relative(root, csvFile)}`)

