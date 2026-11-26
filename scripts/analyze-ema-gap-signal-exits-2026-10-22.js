import fs from "node:fs"
import path from "node:path"

const root = process.cwd(), date = "2026-10-22"
const names = ["BAJAJHLDNG", "360ONE", "GLAND", "OIL", "EICHERMOT", "PERSISTENT", "CGPOWER", "DABUR", "GODREJCP", "UNIONBANK", "BANKBARODA"]
const ledger = JSON.parse(fs.readFileSync(path.join(root, "reports", `${date}-0920-to-1000-live-ema-gap-reversal-radar.json`), "utf8"))
const first = names.map((symbol) => ledger.reversals.filter((row) => row.symbol === symbol).sort((a, b) => String(a.signalTime).localeCompare(String(b.signalTime)))[0]).filter(Boolean)
const epoch = (text) => Date.parse(`${text.replace(" ", "T")}:00+05:30`)
const candles = (symbol) => fs.readFileSync(path.join(root, "db", "candles", `${symbol}.jsonl`), "utf8").trim().split(/\r?\n/).map(JSON.parse).filter((row) => new Date(Number(row.time) * 1000).toISOString().slice(0, 10) === date)
const ema = (rows, length) => { const alpha = 2 / (length + 1); let value = rows[0]?.close; return rows.map((row, index) => { value = index ? alpha * row.close + (1 - alpha) * value : row.close; return value }) }
const trades = first.map((signal) => {
  const rows = candles(signal.symbol), at = epoch(signal.signalTime), entryIndex = rows.findIndex((row) => Number(row.time) * 1000 > at)
  if (entryIndex < 0) return null
  const entry = rows[entryIndex].close, dir = signal.reverseDirection === "BUY" ? 1 : -1, e9 = ema(rows, 9), e20 = ema(rows, 20)
  return { symbol: signal.symbol, signalTime: signal.signalTime, direction: signal.reverseDirection, score: signal.score, entryTime: new Date(Number(rows[entryIndex].time) * 1000).toISOString(), entry, dir, rows: rows.slice(entryIndex + 1), ema9: e9, ema20: e20, baseIndex: entryIndex }
}).filter(Boolean)
function fixed(trade, stopPct, targetPct) {
  const stop = trade.entry * (1 - trade.dir * stopPct), target = trade.entry * (1 + trade.dir * targetPct)
  for (const row of trade.rows) {
    const stopHit = trade.dir > 0 ? row.low <= stop : row.high >= stop
    const targetHit = trade.dir > 0 ? row.high >= target : row.low <= target
    if (stopHit && targetHit) return { exit: stop, reason: "STOP_AND_TARGET_SAME_CANDLE" }
    if (stopHit) return { exit: stop, reason: "SL" }
    if (targetHit) return { exit: target, reason: "TARGET" }
  }
  const last = trade.rows.at(-1) || { close: trade.entry }
  return { exit: last.close, reason: "EOD" }
}
function emaTrail(trade) {
  for (let i = 0; i < trade.rows.length; i++) {
    const index = trade.baseIndex + 1 + i, crossed = trade.dir > 0 ? trade.ema9[index] < trade.ema20[index] : trade.ema9[index] > trade.ema20[index]
    if (crossed) return { exit: trade.rows[i].close, reason: "EMA9_EMA20_CROSS" }
  }
  return { exit: trade.rows.at(-1)?.close ?? trade.entry, reason: "EOD" }
}
const ret = (trade, exit) => 100 * trade.dir * (exit - trade.entry) / trade.entry
const grid = [[0.003, 0.006], [0.003, 0.009], [0.005, 0.010], [0.005, 0.015], [0.0075, 0.015], [0.01, 0.02]].map(([sl, target]) => {
  const results = trades.map((trade) => ({ ...trade, ...fixed(trade, sl, target) }))
  return { slPct: sl * 100, targetPct: target * 100, trades: results.length, wins: results.filter((x) => x.reason === "TARGET" || ret(x, x.exit) > 0).length, stops: results.filter((x) => x.reason === "SL").length, totalReturnPct: results.reduce((sum, x) => sum + ret(x, x.exit), 0), averageReturnPct: results.reduce((sum, x) => sum + ret(x, x.exit), 0) / results.length }
}).sort((a, b) => b.totalReturnPct - a.totalReturnPct)
const recommended = grid[0]
const recommendedTrades = trades.map((trade) => { const result = fixed(trade, recommended.slPct / 100, recommended.targetPct / 100); return { symbol: trade.symbol, signalTime: trade.signalTime, direction: trade.direction, score: trade.score, entryTime: trade.entryTime, entry: trade.entry, exit: result.exit, exitReason: result.reason, returnPct: ret(trade, result.exit) } })
const trailTrades = trades.map((trade) => { const result = emaTrail(trade); return { symbol: trade.symbol, signalTime: trade.signalTime, direction: trade.direction, entry: trade.entry, exit: result.exit, exitReason: result.reason, returnPct: ret(trade, result.exit) } })
const output = { date, method: "First signal per requested stock; entry at next completed 1-minute candle close; intrabar SL/target assumes stop is checked before target when both hit; gross returns exclude costs", signalCount: trades.length, grid, recommended, fixedTrades: recommendedTrades, emaTrail: { trades: trailTrades, totalReturnPct: trailTrades.reduce((sum, x) => sum + x.returnPct, 0), averageReturnPct: trailTrades.reduce((sum, x) => sum + x.returnPct, 0) / trailTrades.length } }
const out = path.join(root, "reports", `${date}-ema-gap-reversal-signal-exit-analysis.json`)
fs.writeFileSync(out, JSON.stringify(output, null, 2) + "\n")
console.log(JSON.stringify({ out, signalCount: trades.length, recommended, emaTrail: output.emaTrail }, null, 2))
