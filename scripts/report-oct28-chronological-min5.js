#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), DATE = "2026-10-28", IST = 330 * 60_000
const SOURCE = path.join(ROOT, "reports", "2026-10-28-1530-fixed-29-filter-chronological-driver-3.json")
const source = JSON.parse(fs.readFileSync(SOURCE, "utf8"))
const round = (x, n = 3) => Number.isFinite(x) ? +x.toFixed(n) : null
const minute = text => { const [h, m] = text.split(":").map(Number); return h * 60 + m }
const dateAt = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 10)
const timeAt = seconds => new Date(seconds * 1000 + IST).toISOString().slice(11, 16)
const unique = (stem, ext) => { let n = 1, file; do { file = path.join(ROOT, "reports", `${stem}${n === 1 ? "" : `-${n}`}.${ext}`); n++ } while (fs.existsSync(file)); return file }
const csv = value => /[",\n]/.test(String(value ?? "")) ? `"${String(value ?? "").replaceAll('"', '""')}"` : String(value ?? "")

function candles(symbol, date) {
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`), rows = []
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    try {
      const x = JSON.parse(line), t = +x.time
      if (dateAt(t) !== date) continue
      rows.push({ t, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume })
    } catch {}
  }
  return rows.sort((a, b) => a.t - b.t)
}

function audit(trade) {
  const current = candles(trade.symbol, DATE), priorDates = [...new Set(candles(trade.symbol, "2026-10-27").map(x => dateAt(x.t)))]
  const previous = candles(trade.symbol, "2026-10-27")
  const signalIndex = current.findIndex(x => timeAt(x.t) === trade.signalCandleTime)
  const entryIndex = current.findIndex(x => timeAt(x.t) === trade.entryTime), exitIndex = current.findIndex(x => timeAt(x.t) === trade.exitTime)
  if (signalIndex < 0 || entryIndex < 0 || exitIndex < 0) throw new Error(`Could not verify ${trade.symbol}`)
  const signal = current[signalIndex], entry = current[entryIndex], exit = current[exitIndex]
  if (entryIndex !== signalIndex + 1 || Math.abs(entry.o - trade.entryPrice) > 1e-8 || Math.abs(exit.o - trade.exitPrice) > 1e-8) throw new Error(`Price/time mismatch for ${trade.symbol}`)
  const prior20 = current.slice(Math.max(0, signalIndex - 20), signalIndex), or15 = current.slice(0, 15)
  const levels = {
    previousDayHigh: previous.length ? Math.max(...previous.map(x => x.h)) : null,
    prior20High: prior20.length ? Math.max(...prior20.map(x => x.h)) : null,
    opening15High: or15.length === 15 ? Math.max(...or15.map(x => x.h)) : null,
  }
  return {
    ...trade,
    verifiedSignalBeforeEntry: true,
    verifiedEntryOpen: entry.o,
    verifiedExitOpen: exit.o,
    signalClose: signal.c,
    ...Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, round(v)])),
    signalAbovePrior20High: levels.prior20High != null && signal.c > levels.prior20High,
    signalAboveOpening15High: levels.opening15High != null && signal.c > levels.opening15High,
    signalAbovePreviousDayHigh: levels.previousDayHigh != null && signal.c > levels.previousDayHigh,
  }
}

const buySignals = source.signals.filter(x => x.side === "BUY").sort((a, b) => minute(a.entryTime) - minute(b.entryTime))
const selected = []
let flatAfter = -Infinity
for (const signal of buySignals) {
  if (minute(signal.entryTime) < flatAfter) continue
  selected.push(audit(signal))
  flatAfter = minute(signal.exitTime)
}
const grossFactors = selected.map(x => 1 + x.returnPct / 100)
const compounded = 100 * (grossFactors.reduce((a, b) => a * b, 1) - 1)
const net = bps => 100 * (selected.reduce((factor, x) => factor * (1 + x.returnPct / 100 - bps / 10_000), 1) - 1)
const returns = selected.map(x => x.returnPct)
const summary = {
  date: DATE,
  capitalPolicy: "BUY only; one open position; signals arriving while a position is open are ignored rather than queued.",
  tradeCount: selected.length,
  winRatePct: round(100 * selected.filter(x => x.returnPct > 0).length / selected.length),
  averageReturnPct: round(returns.reduce((a, b) => a + b, 0) / selected.length),
  summedReturnPct: round(returns.reduce((a, b) => a + b, 0)),
  compoundedSingleCapitalReturnPct: round(compounded),
  compoundedAfter10BpsPerTradePct: round(net(10)),
  compoundedAfter20BpsPerTradePct: round(net(20)),
  maximumAdverseExcursionPct: round(Math.min(...selected.map(x => x.maximumAdverseExcursionPct))),
  worstDay: { date: DATE, compoundedReturnPct: round(compounded) },
}
const warning = "Signal generation and execution are chronological, but the 29 base thresholds and BUY driver profile were fitted on 28 October examples. This is an in-sample construction, not an out-of-sample performance claim."
const stem = "2026-10-28-chronological-single-capital-min5", json = unique(stem, "json"), csvFile = unique(stem, "csv"), md = unique(stem, "md")
fs.writeFileSync(json, `${JSON.stringify({ warning, source: SOURCE, methodology: source.methodology, summary, trades: selected }, null, 2)}\n`, { flag: "wx" })
const fields = ["symbol", "signalCandleTime", "entryTime", "entryPrice", "exitTime", "exitPrice", "returnPct", "maximumFavorableExcursionPct", "maximumAdverseExcursionPct", "driverScore", "signalClose", "prior20High", "opening15High", "previousDayHigh", "signalAbovePrior20High", "signalAboveOpening15High", "signalAbovePreviousDayHigh"]
fs.writeFileSync(csvFile, `${[fields.join(","), ...selected.map(row => fields.map(f => csv(row[f])).join(","))].join("\n")}\n`, { flag: "wx" })
const table = ["| Symbol | Signal | Entry | Exit | Return | MFE | MAE | Driver | S/R state at signal |", "|---|---:|---:|---:|---:|---:|---:|---:|---|", ...selected.map(x => `| ${x.symbol} | ${x.signalCandleTime} | ${x.entryTime} @ ${x.entryPrice} | ${x.exitTime} @ ${x.exitPrice} | ${x.returnPct}% | ${x.maximumFavorableExcursionPct}% | ${x.maximumAdverseExcursionPct}% | ${x.driverScore}/10 | close ${x.signalClose}; prior20H ${x.prior20High}; OR15H ${x.opening15High}; PDH ${x.previousDayHigh} |`)].join("\n")
const report = [`# 28 October chronological minimum-5% construction`, "", `Warning: ${warning}`, "", "## Result", "", `- Trades: ${summary.tradeCount}`, `- Win rate: ${summary.winRatePct}%`, `- Average / summed return: ${summary.averageReturnPct}% / ${summary.summedReturnPct}%`, `- Compounded single-capital return: ${summary.compoundedSingleCapitalReturnPct}%`, `- After 10 bps per trade: ${summary.compoundedAfter10BpsPerTradePct}%`, `- After 20 bps per trade: ${summary.compoundedAfter20BpsPerTradePct}%`, `- Worst MAE: ${summary.maximumAdverseExcursionPct}%`, "", "## Execution rule", "", "1. Scan the full 215-stock universe with the frozen 29-rule EMA10/EMA20, 15-candle price-action/VWAP/PVI/volume and market-depth screen.", "2. Require at least 6 of the 10 BUY driver conditions.", "3. Allow one BUY position. Ignore every new signal while occupied; do not queue it.", "4. Enter at the open immediately after the completed signal candle.", "5. Exit at the next one-minute open after a completed EMA10-below-EMA20 crossover; otherwise use the last session close.", "", "## Trades", "", table, "", `JSON: ${json}`, `CSV: ${csvFile}`].join("\n")
fs.writeFileSync(md, `${report}\n`, { flag: "wx" })
console.log(JSON.stringify({ warning, summary, json, csv: csvFile, md, trades: selected.map(x => ({ symbol: x.symbol, signal: x.signalCandleTime, entry: x.entryTime, exit: x.exitTime, returnPct: x.returnPct })) }, null, 2))
