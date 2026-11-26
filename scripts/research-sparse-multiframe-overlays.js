// Exploratory, fixed-rule overlays on the chronological selective-breakdown replay.
// Usage: node scripts/research-sparse-multiframe-overlays.js reports/<range-report>.json
// Each overlay sees only the base signal and candles completed by that signal minute.
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const root = process.cwd()
const source = process.argv[2]
if (!source || process.argv.length !== 3) throw new Error("Usage: node scripts/research-sparse-multiframe-overlays.js reports/<range-report>.json")
const sourcePath = path.resolve(root, source)
const base = JSON.parse(fs.readFileSync(sourcePath, "utf8"))
if (!Array.isArray(base.signals) || !base.requestedRange) throw new Error("Expected a selective-breakdown range report")
const round = value => Number.isFinite(value) ? Number(value.toFixed(3)) : null
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const pct = (value, reference) => 100 * (value / reference - 1)
const minute = time => Number(time.slice(11, 13)) * 60 + Number(time.slice(14, 16))
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ")
const candles = new Map()

function barsFor(symbol, date) {
  const key = `${symbol}/${date}`
  if (candles.has(key)) return candles.get(key)
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  const byMinute = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const stamp = local(Number(raw.time))
    if (stamp.slice(0, 10) !== date || raw.partial) continue
    const values = [raw.open, raw.high, raw.low, raw.close, raw.volume].map(Number)
    if (!values.every(Number.isFinite) || values[0] <= 0 || values[1] < Math.max(values[0], values[3]) ||
      values[2] > Math.min(values[0], values[3])) continue
    byMinute.set(minute(stamp), { stamp, minute: minute(stamp), open: values[0], high: values[1],
      low: values[2], close: values[3], volume: values[4] })
  }
  let ema9 = null
  for (const bar of [...byMinute.values()].sort((a, b) => a.minute - b.minute)) {
    ema9 = ema9 == null ? bar.close : .2 * bar.close + .8 * ema9
    bar.ema9 = ema9
  }
  candles.set(key, byMinute)
  return byMinute
}

function features(signal) {
  const date = signal.signalTime.slice(0, 10), at = minute(signal.signalTime)
  const bars = barsFor(signal.symbol, date), now = bars.get(at)
  if (!now) throw new Error(`Missing signal candle ${signal.symbol} ${signal.signalTime}`)
  const trailing = count => {
    const rows = Array.from({ length: count }, (_, offset) => bars.get(at - count + 1 + offset))
    if (rows.some(row => !row)) return null
    const high = Math.max(...rows.map(row => row.high)), low = Math.min(...rows.map(row => row.low))
    return { movePct: pct(now.close, rows[0].open),
      closeLocation: high > low ? (now.close - low) / (high - low) : .5,
      volume: rows.reduce((sum, row) => sum + row.volume, 0) }
  }
  const t3 = trailing(3), t5 = trailing(5), t10 = trailing(10), t15 = trailing(15)
  const ema5Ago = bars.get(at - 5)?.ema9
  return { move3Pct: t3?.movePct ?? null, move5Pct: t5?.movePct ?? null,
    move10Pct: t10?.movePct ?? null, move15Pct: t15?.movePct ?? null,
    closeLocation5: t5?.closeLocation ?? null, closeLocation15: t15?.closeLocation ?? null,
    ema9Slope5Pct: ema5Ago ? pct(now.ema9, ema5Ago) : null }
}

// Predeclared hypotheses. These are overlapping variants of one base scanner,
// not 16 independent validated strategies. No outcome is inspected in a rule.
const templates = [
  { key: "depth_volume_5m", text: "directional depth >=52%; signal volume >=1.5x; 5m move >=0.35%", test: (s, f, d) => d.depth >= 52 && s.signalVolumeMultiple >= 1.5 && d.dir * f.move5Pct >= .35 },
  { key: "five_ten_break", text: "depth >=50%; 10m move >=0.6%; 5m close in directional outer quartile", test: (s, f, d) => d.depth >= 50 && d.dir * f.move10Pct >= .6 && d.location5 >= .75 },
  { key: "fifteen_breadth", text: "depth >=50%; 15m move >=0.8%; directional market breadth >=70%", test: (s, f, d) => d.depth >= 50 && d.dir * f.move15Pct >= .8 && d.breadth >= 70 },
  { key: "vwap_volume", text: "depth >=50%; VWAP distance >=0.5%; signal volume >=1.5x", test: (s, f, d) => d.depth >= 50 && d.vwapGap >= .5 && s.signalVolumeMultiple >= 1.5 },
  { key: "depth_midpoint", text: "depth >=55%; depth midpoint moves directionally; 3m move >=0.2%", test: (s, f, d) => d.depth >= 55 && d.dir * s.depth.midpointMovePct >= 0 && d.dir * f.move3Pct >= .2 },
  { key: "ema_outer_close", text: "depth >=50%; EMA9 5m slope >=0.15%; 15m close outer quartile; volume >=1.5x", test: (s, f, d) => d.depth >= 50 && d.dir * f.ema9Slope5Pct >= .15 && d.location15 >= .75 && s.signalVolumeMultiple >= 1.5 },
  { key: "fresh_three_ten", text: "depth >=52%; 3m directional move >=0.2%; prior 10m not already extended >0.4%", test: (s, f, d) => d.depth >= 52 && d.dir * f.move3Pct >= .2 && d.dir * f.move10Pct <= .4 },
  { key: "fresh_five_fifteen", text: "depth >=52%; 5m directional move >=0.3%; prior 15m not already extended >0.5%", test: (s, f, d) => d.depth >= 52 && d.dir * f.move5Pct >= .3 && d.dir * f.move15Pct <= .5 }
]
const enriched = base.signals.map(signal => ({ ...signal, multiFrame: features(signal) }))
  .sort((a, b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
const summary = trades => {
  const dates = [...new Set(trades.map(trade => trade.signalTime.slice(0, 10)))].sort()
  const daySums = dates.map(date => ({ date, totalReturnPct: round(trades.filter(trade => trade.signalTime.startsWith(date))
    .reduce((sum, trade) => sum + trade.returnPct, 0)) }))
  return { tradeCount: trades.length, targetHits: trades.filter(trade => trade.exitReason === "target").length,
    stops: trades.filter(trade => trade.exitReason === "stop").length,
    losses: trades.filter(trade => trade.returnPct <= 0).length,
    winRatePct: trades.length ? round(100 * trades.filter(trade => trade.returnPct > 0).length / trades.length) : null,
    averageReturnPct: trades.length ? round(mean(trades.map(trade => trade.returnPct))) : null,
    totalReturnPct: round(trades.reduce((sum, trade) => sum + trade.returnPct, 0)),
    maximumAdverseExcursionPct: trades.length ? round(Math.max(...trades.map(trade => trade.adverseMovePct))) : null,
    worstDay: daySums.length ? [...daySums].sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] : null,
    datesWithSignals: dates.length }
}
const strategies = []
for (const side of ["BUY", "SELL"]) for (const rule of templates) {
  const trades = enriched.filter(signal => {
    if (signal.side !== side) return false
    const dir = side === "BUY" ? 1 : -1
    const depth = side === "BUY" ? signal.depth?.bidSharePct : signal.depth?.sellSharePct
    const breadth = side === "BUY" ? signal.marketBreadth?.upPct : signal.marketBreadth?.downPct
    const vwapGap = side === "BUY" ? signal.aboveVwapPct : signal.belowVwapPct
    const location5 = side === "BUY" ? signal.multiFrame.closeLocation5 : 1 - signal.multiFrame.closeLocation5
    const location15 = side === "BUY" ? signal.multiFrame.closeLocation15 : 1 - signal.multiFrame.closeLocation15
    return [depth, breadth, vwapGap, location5, location15, signal.depth?.midpointMovePct,
      ...Object.values(signal.multiFrame)].every(Number.isFinite) &&
      rule.test(signal, signal.multiFrame, { dir, depth, breadth, vwapGap, location5, location15 })
  })
  strategies.push({ name: `${side}-${rule.key}`, side, rule: rule.text,
    sparse: trades.length > 0 && trades.length <= 10,
    overall: summary(trades), early: summary(trades.filter(x => x.signalTime.slice(0, 10) <= "2026-10-16")),
    later: summary(trades.filter(x => x.signalTime.slice(0, 10) >= "2026-10-19")),
    signals: trades.map(trade => ({ symbol: trade.symbol, side: trade.side, signalTime: trade.signalTime,
      entryTime: trade.entryTime, exitTime: trade.exitTime, exitReason: trade.exitReason,
      returnPct: trade.returnPct, adverseMovePct: trade.adverseMovePct,
      depthSharePct: side === "BUY" ? trade.depth.bidSharePct : trade.depth.sellSharePct,
      ...trade.multiFrame })) })
}
const report = { title: "Sixteen predeclared sparse multi-timeframe overlays on a chronological base scanner",
  source: path.relative(root, sourcePath), sessions: base.sessionDates,
  scope: "All stocks were scanned by the source replay. Overlays screen only its selected event stream; they are not independent whole-universe strategies. Each is at most one signal per stock per session.",
  timing: "One-minute candle and depth data through the signal minute only. Completed trailing 3/5/10/15-minute candle windows. Entry at next completed one-minute candle close, 1.55% target, 0.75% stop, conservative same-bar stop priority, otherwise session-end close.",
  validation: "Oct 6-16 versus Oct 19/21 is a chronological split, but both later dates were examined in earlier research; it is not untouched out-of-sample validation. Rules are fixed before this replay, but the base scanner itself was developed using these dates.",
  caveat: "A zero-loss subset with few trades is not evidence of zero future loss. Gross returns exclude costs/slippage; sums across trades are percentage points, not portfolio returns. Overlays overlap heavily and must not be counted as 16 independent edges.",
  baseSummary: base.summary, strategies }
const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}`
const output = path.join(root, "reports", `sparse-multiframe-overlays-${base.requestedRange.from}-to-${base.requestedRange.to}-${runId}.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
const csvPath = path.join(root, "csv", `sparse-multiframe-overlays-${base.requestedRange.from}-to-${base.requestedRange.to}-${runId}.csv`)
const columns = ["name", "side", "rule", "sparse", "tradeCount", "datesWithSignals", "targetHits", "stops", "losses",
  "winRatePct", "averageReturnPct", "totalReturnPct", "maximumAdverseExcursionPct", "worstDay",
  "earlyTrades", "earlyLosses", "laterTrades", "laterLosses"]
const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`
const csvRows = strategies.map(row => ({ name: row.name, side: row.side, rule: row.rule, sparse: row.sparse,
  ...row.overall, worstDay: row.overall.worstDay?.date ?? "", earlyTrades: row.early.tradeCount,
  earlyLosses: row.early.losses, laterTrades: row.later.tradeCount, laterLosses: row.later.losses }))
fs.writeFileSync(csvPath, [columns.map(quote).join(","),
  ...csvRows.map(row => columns.map(column => quote(row[column])).join(","))].join("\n") + "\n", { flag: "wx" })
console.log(JSON.stringify({ output, csvPath, baseSummary: base.summary, strategies: strategies.map(({ name, sparse, overall, early, later }) =>
  ({ name, sparse, overall, early, later })) }, null, 2))
