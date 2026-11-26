#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), IST = 330 * 60_000
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const dateArg = arg("--date"), fromArg = arg("--from"), toArg = arg("--to")
if (dateArg && (fromArg || toArg) || !dateArg && (!fromArg || !toArg)) throw new Error("Use --date YYYY-MM-DD or --from YYYY-MM-DD --to YYYY-MM-DD")
const from = dateArg ?? fromArg, to = dateArg ?? toArg
const startMinute = Number(arg("--start-minute") ?? 555), historyEndMinute = Number(arg("--history-end-minute") ?? 560), signalEndMinute = Number(arg("--signal-end-minute") ?? 580)
const angleMin = Number(arg("--angle-min") ?? 15), initialGapMin = Number(arg("--initial-gap-min") ?? .8), pullbackGapMin = Number(arg("--pullback-gap-min") ?? .3), relativeMin = Number(arg("--relative-min") ?? .3), volumeMin = Number(arg("--volume-min") ?? .8)
const qualityFilter = !process.argv.includes("--no-quality-filter")
const qualityRules = { vwapGapMin: .4410, higherCloseShareMax: .8001, volumeUpDownRatioMax: 2.3044, minimumGapMin: .5689, historyAverageMax: -.1205 }
const stamp = epoch => new Date(epoch * 1000 + IST).toISOString().slice(0, 16).replace("T", " ")
const dateOf = epoch => stamp(epoch).slice(0, 10), minuteOf = epoch => { const s = stamp(epoch).slice(11); return Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) }
const pct = (a, b) => 100 * (a / b - 1), round = (v, d = 3) => Number.isFinite(v) ? +v.toFixed(d) : null
const stocks = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "stocks"), "utf8"))
const cache = new Map()
const load = symbol => { if (cache.has(symbol)) return cache.get(symbol); const rows = fs.readFileSync(path.join(ROOT, "db", "candles", `${symbol}.jsonl`), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).sort((a, b) => a.time - b.time).map(x => ({ ...x, date: dateOf(x.time), minute: minuteOf(x.time) })); cache.set(symbol, rows); return rows }
const sessions = rows => [...new Set(rows.map(x => x.date))].sort()
const byWindow = (rows, date, end) => rows.filter(x => x.date === date && x.minute >= startMinute && x.minute <= end)
const median = values => { const a = values.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN }
const signalDates = [...new Set(load("NIFTY50").map(x => x.date))].filter(date => date >= from && date <= to)
const signals = []
for (const date of signalDates) {
  const nifty = byWindow(load("NIFTY50"), date, historyEndMinute)
  if (nifty.length < historyEndMinute - startMinute + 1) continue
  const niftyReturn = pct(nifty.at(-1).close, nifty[0].open)
  for (const symbol of stocks) {
    const rows = load(symbol), priorDates = sessions(rows).filter(x => x < date).slice(-10), today = rows.filter(x => x.date === date && x.minute >= startMinute && x.minute <= signalEndMinute)
    if (priorDates.length < 10 || today.length < 2) continue
    const priorOpening = priorDates.map(d => byWindow(rows, d, historyEndMinute)).filter(x => x.length === historyEndMinute - startMinute + 1)
    if (priorOpening.length < 10) continue
    const priorReturns = priorOpening.map(x => pct(x.at(-1).close, x[0].open)), priorVolumes = priorOpening.map(x => x.reduce((s, r) => s + r.volume, 0))
    const historyAverage = priorReturns.reduce((s, x) => s + x, 0) / priorReturns.length, currentHistory = today.filter(x => x.minute <= historyEndMinute)
    if (currentHistory.length < historyEndMinute - startMinute + 1) continue
    const volumeAcceleration = currentHistory.reduce((s, x) => s + x.volume, 0) / median(priorVolumes)
    const currentReturn = pct(currentHistory.at(-1).close, currentHistory[0].open)
    if (!(historyAverage < 0 && volumeAcceleration >= volumeMin && currentReturn - niftyReturn > relativeMin)) continue
    let ema = null, decorated = []
    for (const row of rows.filter(x => x.date < date || x.date === date && x.minute <= signalEndMinute)) { ema = ema == null ? row.close : (2 / 21) * row.close + (19 / 21) * ema; if (row.date === date && row.minute >= startMinute && row.minute <= signalEndMinute) decorated.push({ ...row, ema, gap: pct(row.close, ema) }) }
    for (let end = historyEndMinute; end <= signalEndMinute; end++) {
      const window = decorated.filter(x => x.minute <= end), angle = window.length > 1 ? Math.atan((window.at(-1).ema - window[0].ema) / (window.length - 1)) * 180 / Math.PI : NaN
      if (window.length < end - startMinute + 1 || angle <= angleMin || window[0].gap <= initialGapMin || window.some(x => x.gap < pullbackGapMin)) continue
      const last = window.at(-1), prior = window.slice(0, -1).slice(-5), high = Math.max(...prior.map(x => x.high))
      if (last.close <= high) continue
      const vwap = window.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / window.reduce((sum, row) => sum + row.volume, 0)
      const higherCloseShare = window.slice(1).filter((row, index) => row.close > window[index].close).length / Math.max(1, window.length - 1)
      const upVolumes = window.filter(row => row.close >= row.open).map(row => row.volume), downVolumes = window.filter(row => row.close < row.open).map(row => row.volume)
      const volumeUpDownRatio = downVolumes.length ? (upVolumes.reduce((sum, value) => sum + value, 0) / upVolumes.length) / (downVolumes.reduce((sum, value) => sum + value, 0) / downVolumes.length) : Infinity
      const minimumGap = Math.min(...window.map(x => x.gap)), vwapGap = pct(last.close, vwap)
      const qualityPass = vwapGap >= qualityRules.vwapGapMin && higherCloseShare <= qualityRules.higherCloseShareMax && volumeUpDownRatio <= qualityRules.volumeUpDownRatioMax && minimumGap >= qualityRules.minimumGapMin && historyAverage <= qualityRules.historyAverageMax
      // The filter classifies the first otherwise-valid BOS. Waiting for a later
      // BOS after a rejection would silently change both the fitted sample and entry.
      if (qualityFilter && !qualityPass) break
      signals.push({ date, symbol, side: "BUY", signalTime: stamp(last.time), setup: "BOS_EMA20_OPENING_CONTINUATION", angleDeg: round(angle), minimumGapPct: round(minimumGap), breakoutLevel: round(high), historyAveragePct: round(historyAverage), volumeAcceleration: round(volumeAcceleration), relativeStrengthPct: round(currentReturn - niftyReturn), vwapGapPct: round(vwapGap), higherCloseShare: round(higherCloseShare), volumeUpDownRatio: round(volumeUpDownRatio), qualityPass })
      break
    }
  }
}
const unique = [...new Map(signals.map(x => [`${x.date}|${x.symbol}`, x])).values()].sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol))
function attachExit(signal) {
  const rows = load(signal.symbol), signalTime = Date.parse(`${signal.signalTime.replace(" ", "T")}:00+05:30`) / 1000
  const index = rows.findIndex(row => row.time === signalTime), entry = rows[index + 1]
  if (!entry || dateOf(entry.time) !== signal.date) return { ...signal, outcome: "NO_NEXT_CANDLE" }
  const entryPrice = entry.open, stop = entryPrice * .993, side = signal.side
  let ema20 = null, ema40 = null, previous = null, exit = null
  for (let cursor = 0; cursor <= index; cursor++) {
    const row = rows[cursor]
    ema20 = ema20 == null ? row.close : (2 / 21) * row.close + (19 / 21) * ema20
    ema40 = ema40 == null ? row.close : (2 / 41) * row.close + (39 / 41) * ema40
    previous = { ema20, ema40 }
  }
  const sessionEnd = rows.findIndex((row, cursor) => cursor > index && dateOf(row.time) > signal.date)
  const endExclusive = sessionEnd < 0 ? rows.length : sessionEnd
  for (let cursor = index + 1; cursor < endExclusive; cursor++) {
    const row = rows[cursor]
    ema20 = (2 / 21) * row.close + (19 / 21) * ema20
    ema40 = (2 / 41) * row.close + (39 / 41) * ema40
    const hitStop = row.low <= stop
    const cross2040 = previous.ema20 >= previous.ema40 && ema20 < ema40
    if (hitStop) exit = { row, price: stop, reason: "STOP_0.7%" }
    else if (cross2040) exit = { row, price: row.close, reason: "EMA20_CROSS_EMA40" }
    if (exit) break
    previous = { ema20, ema40 }
  }
  const finalRow = rows[endExclusive - 1], final = exit ?? { row: finalRow, price: finalRow.close, reason: "SESSION_CLOSE" }
  const finalIndex = rows.findIndex(row => row.time === final.row.time)
  return { ...signal, entryTime: stamp(entry.time), entryPrice: round(entryPrice), exitTime: stamp(final.row.time), exitPrice: round(final.price), exitReason: final.reason, returnPct: round(100 * (final.price / entryPrice - 1)), maePct: round(100 * (Math.min(entryPrice, ...rows.slice(index + 1, finalIndex + 1).map(row => row.low)) / entryPrice - 1)) }
}
const completed = unique.map(attachExit)
const trades = completed.filter(signal => Number.isFinite(signal.returnPct)), winners = trades.filter(signal => signal.returnPct > 0), losers = trades.filter(signal => signal.returnPct < 0)
const byDate = Map.groupBy(trades, signal => signal.date), daily = [...byDate].map(([date, dateTrades]) => ({ date, returnPct: dateTrades.reduce((sum, trade) => sum + trade.returnPct, 0) }))
const summary = { tradeCount: trades.length, winners: winners.length, losers: losers.length, winRatePct: round(100 * winners.length / trades.length), averageReturnPct: round(trades.reduce((sum, trade) => sum + trade.returnPct, 0) / trades.length), totalReturnPct: round(trades.reduce((sum, trade) => sum + trade.returnPct, 0)), maximumAdverseExcursionPct: round(Math.min(0, ...trades.map(trade => trade.maePct))), worstDay: daily.length ? daily.sort((a, b) => a.returnPct - b.returnPct)[0] : null }
const output = { from, to, parameters: { startMinute, historyEndMinute, signalEndMinute, angleMin, initialGapMin, pullbackGapMin, relativeMin, volumeMin, qualityFilter, qualityRules: qualityFilter ? qualityRules : null, stopPct: .7, exits: ["EMA20_CROSS_EMA40", "STOP_0.7%", "SESSION_CLOSE"] }, warning: qualityFilter ? "The quality thresholds were fitted on the nine user-selected 2026-11-03 stocks and are not out-of-sample validated." : null, methodology: "Causal backtest. Prior-10 opening history, current volume/relative strength through 09:20, EMA20 angle and gap, prior-five high BOS, next-candle entry, 0.7% stop, bearish EMA20/EMA40 cross exit, and session-close fallback.", summary, signals: completed }
let n = 1, file; do { file = path.join(ROOT, "reports", `${from}${from === to ? "" : `-to-${to}`}-opening-ema20-bos-backtest${n === 1 ? "" : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
console.log(`\nReport: ${file}`)
console.table(completed.map(signal => ({
  Date: signal.date,
  Stock: signal.symbol,
  Side: signal.side,
  Signal: signal.signalTime.slice(11, 16),
  Entry: signal.entryTime?.slice(11, 16) ?? "-",
  "Entry Price": signal.entryPrice ?? "-",
  Exit: signal.exitTime?.slice(11, 16) ?? "-",
  "Exit Price": signal.exitPrice ?? "-",
  Reason: signal.exitReason ?? signal.outcome ?? "-",
  "Return %": signal.returnPct ?? "-",
  "MAE %": signal.maePct ?? "-",
})))
console.log(`Signals: ${completed.length}`)
console.table([summary])
