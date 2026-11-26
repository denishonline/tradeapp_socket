#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import {
  DEFAULT_PARAMS,
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
const date = arg("--date")
if (!date) throw new Error("Usage: node scripts/scan-opening-six-filter.js --date YYYY-MM-DD [--symbols A,B]")

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
const result = scanOpeningSixFilters({ root, dates: [date], symbols, params })
const session = result.sessions[0]
console.table(session.stages.map((stage) => ({ Stage: stage.stage, Count: stage.count, Filter: stage.filter })))
console.table(session.matches.map((row) => ({ Symbol: row.symbol, GapPct: row.openingGapPct, VWAPGapPct: row.fyers15mVwapGapPct, EMA20ChangePct: row.ema20ChangePct, PriorGreenST: row.priorGreenSupertrendBars })))

const base = `${date}-opening-six-filter-scan`
const jsonFile = uniqueReportPath(root, base, "json")
const csvFile = jsonFile.replace(/\.json$/, ".csv")
fs.writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" })
fs.writeFileSync(csvFile, matchesCsv(result), { flag: "wx" })
console.log(`Matches: ${session.matches.length}`)
console.log(`JSON: ${path.relative(root, jsonFile)}`)
console.log(`CSV: ${path.relative(root, csvFile)}`)

