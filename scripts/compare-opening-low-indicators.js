#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null }
const ROOT = process.cwd(), DATE = arg("--date") || "2026-11-04", OPEN = 555, END = 560, IST = 330 * 60_000
const requested = ["TIINDIA", "VEDL", "NATIONALUM"]
const symbolArg = arg("--symbols")
const allMode = process.argv.includes("--similar")
const symbols = symbolArg ? symbolArg.split(",").map(value => value.replace(/^NSE:/, "").replace(/-EQ$/, "")) : allMode ? JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8")) : requested
const dateOf = t => new Date(t * 1000 + IST).toISOString().slice(0, 10)
const minuteOf = t => { const s = new Date(t * 1000 + IST).toISOString().slice(11, 16); return +s.slice(0, 2) * 60 + +s.slice(3) }
const pct = (a, b) => b ? 100 * (a / b - 1) : NaN
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN
const median = a => { const x = a.filter(Number.isFinite).sort((u, v) => u - v); return x.length ? x[Math.floor(x.length / 2)] : NaN }
const round = (v, d = 4) => Number.isFinite(v) ? +v.toFixed(d) : null
const cache = new Map()
function load(symbol) {
  if (cache.has(symbol)) return cache.get(symbol)
  const file = path.join(ROOT, "db", "candles", `${symbol}.jsonl`)
  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).sort((a, b) => a.time - b.time).map(row => ({ ...row, date: dateOf(row.time), minute: minuteOf(row.time) }))
  cache.set(symbol, rows); return rows
}
function ema(rows, period) { let value = null; const alpha = 2 / (period + 1); return rows.map(row => value = value == null ? row.close : alpha * row.close + (1 - alpha) * value) }
function features(symbol, date, priorOpeningVolumes) {
  const rows = load(symbol), opening = rows.filter(row => row.date === date && row.minute >= OPEN && row.minute < END)
  if (opening.length < 5) return null
  const before = rows.filter(row => row.time <= opening.at(-1).time), e20 = ema(before, 20), e20Last = e20.at(-1), e20Prev = e20.at(-2)
  const last60 = e20.slice(-60), current = opening.at(-1), first = opening[0], vwap = opening.reduce((s, r) => s + ((r.high + r.low + r.close) / 3) * r.volume, 0) / opening.reduce((s, r) => s + r.volume, 0)
  const tr = before.slice(-15).map((r, i, a) => i ? Math.max(r.high - r.low, Math.abs(r.high - a[i - 1].close), Math.abs(r.low - a[i - 1].close)) : r.high - r.low)
  const pathMove = opening.slice(1).reduce((s, r, i) => s + Math.abs(r.close - opening[i].close), 0)
  return {
    openingReturnPct: pct(current.close, first.open), cumulativeVolume: opening.reduce((s, r) => s + r.volume, 0),
    volumeAcceleration: opening.reduce((s, r) => s + r.volume, 0) / median(priorOpeningVolumes),
    ema20Angle: last60.length > 1 ? Math.atan((last60.at(-1) - last60[0]) / (last60.length - 1)) * 180 / Math.PI : NaN,
    ema20GapPct: pct(current.close, e20Last), ema20ChangePct: pct(e20Last, e20Prev), rsi14: (() => { const d = before.slice(-15).slice(1).map((r, i) => r.close - before.slice(-15)[i].close), g = mean(d.map(v => Math.max(0, v))), l = mean(d.map(v => Math.max(0, -v))); return l ? 100 - 100 / (1 + g / l) : 100 })(),
    atr14Pct: 100 * mean(tr) / current.close, rangePct: 100 * (Math.max(...opening.map(r => r.high)) - Math.min(...opening.map(r => r.low))) / first.open,
    bodyAbsPct: 100 * Math.abs(current.close - first.open) / first.open, closeLocation: (current.close - Math.min(...opening.map(r => r.low))) / (Math.max(...opening.map(r => r.high)) - Math.min(...opening.map(r => r.low)) || 1),
    vwapGapPct: pct(current.close, vwap), efficiency: pathMove ? Math.abs(current.close - first.open) / pathMove : 0,
    greenShare: opening.filter(r => r.close > r.open).length / opening.length, lastCandleReturnPct: pct(current.close, current.open),
  }
}
const nifty = load("NIFTY50"), sessions = [...new Set(nifty.map(r => r.date).filter(d => d < DATE))].sort().slice(-10)
const result = [], similar = []
for (const symbol of symbols) {
  const rows = load(symbol), dates = [...sessions, DATE], openingVolumes = date => rows.filter(r => r.date === date && r.minute >= OPEN && r.minute < END).reduce((s, r) => s + r.volume, 0)
  const all = dates.map((date, i) => { const previous = dates.slice(Math.max(0, i - 10), i).map(openingVolumes); return { date, f: features(symbol, date, previous) } }).filter(x => x.f)
  const today = all.find(x => x.date === DATE), prior = all.filter(x => x.date !== DATE).slice(-10)
  if (allMode && today?.f && today.f.openingReturnPct < 0 && today.f.vwapGapPct < 0 && today.f.ema20Angle < 0 && today.f.rsi14 < 35 && today.f.closeLocation < .3) similar.push({ symbol, openingReturnPct: round(today.f.openingReturnPct), vwapGapPct: round(today.f.vwapGapPct), ema20Angle: round(today.f.ema20Angle), rsi14: round(today.f.rsi14), closeLocation: round(today.f.closeLocation) })
  const names = Object.keys(today?.f ?? {}).filter(name => Number.isFinite(today.f[name]))
  const ranked = names.map(name => { const values = prior.map(x => x.f[name]).filter(Number.isFinite), value = today.f[name], lessOrEqual = values.filter(v => v <= value).length; return { symbol, indicator: name, today: round(value), priorMin: round(Math.min(...values)), priorMedian: round(median(values)), lowRankPct: round(100 * lessOrEqual / values.length), todayIsNewLow: value <= Math.min(...values) } }).sort((a, b) => a.lowRankPct - b.lowRankPct).slice(0, 10)
  result.push({ symbol, indicators: ranked })
  if (!allMode) { console.log(`\n${symbol} — 10 lowest today-vs-prior-10 indicators`); console.table(ranked) }
}
const file = path.join(ROOT, "reports", `${DATE}-opening-low-indicators-tiindia-vedl-nationalum.json`)
fs.writeFileSync(file, `${JSON.stringify({ date: DATE, cutoff: "09:20 IST; completed 09:15–09:19 candles", priorSessions: sessions, methodology: "Indicators are calculated causally through the 09:20 cutoff and ranked by the percentage of prior-ten values less than or equal to today's value; lower percentile means unusually low today.", result }, null, 2)}\n`)
console.log(`\nReport: ${file}`)
if (allMode) { similar.sort((a, b) => a.ema20Angle - b.ema20Angle); console.log("\nSimilar opening-weakness stocks:"); console.table(similar); console.log(`Comma-separated symbols: ${similar.map(row => `NSE:${row.symbol}-EQ`).join(",")}`) }
