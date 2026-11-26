import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), tradeDate = process.argv[2] ?? '2026-10-19'
const priorDates = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).replace(/-EQ$/i, '').toUpperCase()))]
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')

function candles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row; try { row = JSON.parse(line) } catch { continue }
    const stamp = local(+row.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
    if (![...priorDates, tradeDate].includes(date) || minute < '09:15' || minute > '15:29') continue
    if (![row.open, row.high, row.low, row.close, row.volume].every(x => Number.isFinite(+x))) continue
    unique.set(stamp, { stamp, date, minute, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume })
  }
  const all = [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
  const byDate = Object.fromEntries([...priorDates, tradeDate].map(date => [date, all.filter(x => x.date === date)]))
  return [...priorDates, tradeDate].every(date => byDate[date].length === 375) ? byDate : null
}

function openingDepth(symbol) {
  const file = path.join(root, 'db', 'cash-depth', tradeDate, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const state = {}, rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const stamp = new Date(Date.parse(event.receivedAt) + 330 * 60_000).toISOString().slice(0, 16)
    if (stamp.slice(0, 10) !== tradeDate) continue
    const minute = stamp.slice(11)
    if (minute > '09:29') break
    if (event.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (minute < '09:25') continue
    const bidSizes = [], askSizes = []; let valid = true
    for (let i = 1; i <= 5; i++) {
      const bp = +state[`bid_price${i}`], ap = +state[`ask_price${i}`], bs = +state[`bid_size${i}`], as = +state[`ask_size${i}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) { valid = false; break }
      bidSizes.push(bs); askSizes.push(as)
    }
    if (!valid) continue
    const bid = bidSizes.reduce((s, x) => s + x, 0), ask = askSizes.reduce((s, x) => s + x, 0), midpoint = (+state.bid_price1 + +state.ask_price1) / 2
    rows.push({ bidSharePct: 100 * bid / (bid + ask || 1), midpoint, spreadBps: 10000 * (+state.ask_price1 - +state.bid_price1) / midpoint })
  }
  if (rows.length < 20) return null
  return { snapshots: rows.length, avgBidSharePct: round(mean(rows.map(x => x.bidSharePct))), bidDominantPct: round(100 * rows.filter(x => x.bidSharePct > 50).length / rows.length), midpointMovePct: round(100 * (rows.at(-1).midpoint / rows[0].midpoint - 1)), avgSpreadBps: round(mean(rows.map(x => x.spreadBps))) }
}

function feature(symbol, byDate, depth) {
  const today = byDate[tradeDate], opening = today.slice(0, 15), entry = today[15]
  const prior = priorDates.map(date => byDate[date])
  const priorHighs = prior.map(rows => Math.max(...rows.map(x => x.high))), priorLows = prior.map(rows => Math.min(...rows.map(x => x.low)))
  const priorClose = prior.at(-1).at(-1).close
  const first5 = opening.slice(0, 5), second5 = opening.slice(5, 10), third5 = opening.slice(10, 15)
  const cumulative = rows => rows.reduce((s, x) => s + x.volume, 0)
  const vwap = rows => rows.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / cumulative(rows)
  const close = opening.at(-1).close, returnPct = 100 * (close / opening[0].open - 1)
  const side = returnPct >= 0 ? 'BUY' : 'SELL', direction = side === 'BUY' ? 1 : -1
  const relVolume = cumulative(opening) / mean(prior.map(rows => cumulative(rows.slice(0, 15))))
  const previousHigh = priorHighs.at(-1), previousLow = priorLows.at(-1), fourDayHigh = Math.max(...priorHighs), fourDayLow = Math.min(...priorLows)
  const previousBreak = side === 'BUY' ? close > previousHigh : close < previousLow
  const fourDayBreak = side === 'BUY' ? close > fourDayHigh : close < fourDayLow
  const fiveMinuteStructure = side === 'BUY'
    ? Math.min(...third5.map(x => x.low)) >= Math.min(...second5.map(x => x.low)) && Math.min(...second5.map(x => x.low)) >= Math.min(...first5.map(x => x.low))
    : Math.max(...third5.map(x => x.high)) <= Math.max(...second5.map(x => x.high)) && Math.max(...second5.map(x => x.high)) <= Math.max(...first5.map(x => x.high))
  return { symbol, side, direction, signalTime: `${tradeDate} 09:29`, entryTime: entry.stamp, entryPrice: entry.close, entryIndex: 15, today, openingReturnPct: round(Math.abs(returnPct)), signedOpeningReturnPct: round(returnPct), gapPct: round(100 * (opening[0].open / priorClose - 1)), relativeVolume: round(relVolume), vwapGapDirectionalPct: round(100 * direction * (close / vwap(opening) - 1)), vwapSlopeDirectionalPct: round(100 * direction * (vwap(opening) / vwap(opening.slice(0, 10)) - 1)), previousBreak, fourDayBreak, fiveMinuteStructure, previousHigh: round(previousHigh, 2), previousLow: round(previousLow, 2), fourDayHigh: round(fourDayHigh, 2), fourDayLow: round(fourDayLow, 2), depth }
}

function outcome(row, stopPct, targetPct) {
  const entry = row.entryPrice, direction = row.direction
  const stop = entry * (1 - direction * stopPct / 100), target = entry * (1 + direction * targetPct / 100)
  let exit = null, mae = 0
  for (const candle of row.today.slice(row.entryIndex + 1)) {
    const adverse = row.side === 'BUY' ? 100 * (candle.low / entry - 1) : 100 * (1 - candle.high / entry)
    mae = Math.min(mae, adverse)
    const stopHit = row.side === 'BUY' ? candle.low <= stop : candle.high >= stop
    const targetHit = row.side === 'BUY' ? candle.high >= target : candle.low <= target
    if (stopHit && targetHit) { exit = { time: candle.stamp, price: stop, reason: 'ambiguous candle; stop-first' }; break }
    if (stopHit) { exit = { time: candle.stamp, price: stop, reason: 'stop' }; break }
    if (targetHit) { exit = { time: candle.stamp, price: target, reason: 'target' }; break }
  }
  if (!exit) { const last = row.today.at(-1); exit = { time: last.stamp, price: last.close, reason: 'end-of-day' } }
  return { stop: round(stop, 4), target: round(target, 4), exitTime: exit.time, exitPrice: round(exit.price, 4), exitReason: exit.reason, returnPct: round(100 * direction * (exit.price / entry - 1)), maximumAdverseExcursionPct: round(mae) }
}

const rows = [], coverage = { requestedStocks: symbols.length, complete: 0, missing: [] }
for (const symbol of symbols) {
  const byDate = candles(symbol)
  if (!byDate) { coverage.missing.push(symbol); continue }
  coverage.complete++
  rows.push(feature(symbol, byDate, openingDepth(symbol)))
}

const configs = []
for (const breakout of ['none', 'previousDay', 'fourDay']) for (const minOpeningMove of [0.15, 0.3, 0.5, 0.75])
for (const minRvol of [0.8, 1, 1.25, 1.5, 2]) for (const minDirectionalDepth of [null, 50, 55, 60])
for (const minDirectionalMidpoint of [null, -0.05, 0]) for (const requireStructure of [false, true])
for (const stopPct of [0.3, 0.5, 0.75]) for (const targetPct of [0.5, 0.75, 1, 1.5, 2]) {
  if ((minDirectionalDepth == null) !== (minDirectionalMidpoint == null)) continue
  const matches = rows.filter(row => row.openingReturnPct >= minOpeningMove && row.relativeVolume >= minRvol && row.vwapGapDirectionalPct > 0 && row.vwapSlopeDirectionalPct > 0 && (!requireStructure || row.fiveMinuteStructure) && (breakout === 'none' || (breakout === 'previousDay' ? row.previousBreak : row.fourDayBreak)) && (minDirectionalDepth == null || (row.depth && row.depth.avgSpreadBps <= 15 && (row.side === 'BUY' ? row.depth.avgBidSharePct : 100 - row.depth.avgBidSharePct) >= minDirectionalDepth && row.direction * row.depth.midpointMovePct >= minDirectionalMidpoint)))
  const trades = matches.map(row => ({ ...row, ...outcome(row, stopPct, targetPct) }))
  const returns = trades.map(x => x.returnPct)
  configs.push({ parameters: { signalTime: '09:29', breakout, minOpeningMove, minRvol, minDirectionalDepth, minDirectionalMidpoint, requireStructure, stopPct, targetPct }, tradeCount: trades.length, winRatePct: trades.length ? round(100 * returns.filter(x => x > 0).length / trades.length) : null, averageReturnPct: trades.length ? round(mean(returns)) : null, totalCombinedReturnPct: round(returns.reduce((s, x) => s + x, 0)), maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(x => x.maximumAdverseExcursionPct))) : null, trades })
}
configs.sort((a, b) => b.totalCombinedReturnPct - a.totalCombinedReturnPct || b.winRatePct - a.winRatePct)
const passing = configs.filter(x => x.totalCombinedReturnPct > 10 && x.tradeCount >= 10 && x.winRatePct >= 55)
const selected = passing[0] ?? configs[0]
const bestWithStructure = configs.find(x => x.parameters.requireStructure)
const bestWithDepth = configs.find(x => x.parameters.minDirectionalDepth != null)
const bestWithPriorBreakout = configs.find(x => x.parameters.breakout !== 'none')
const compact = row => ({ symbol: row.symbol, side: row.side, signalTime: row.signalTime, entryTime: row.entryTime, entryPrice: row.entryPrice, openingReturnPct: row.signedOpeningReturnPct, relativeVolume: row.relativeVolume, previousBreak: row.previousBreak, fourDayBreak: row.fourDayBreak, fiveMinuteStructure: row.fiveMinuteStructure, vwapGapDirectionalPct: row.vwapGapDirectionalPct, depth: row.depth, stop: row.stop, target: row.target, exitTime: row.exitTime, exitPrice: row.exitPrice, exitReason: row.exitReason, returnPct: row.returnPct, maximumAdverseExcursionPct: row.maximumAdverseExcursionPct })
const familySummary = row => row ? ({ parameters: row.parameters, tradeCount: row.tradeCount, winRatePct: row.winRatePct, averageReturnPct: row.averageReturnPct, totalCombinedReturnPct: row.totalCombinedReturnPct, maximumAdverseExcursionPct: row.maximumAdverseExcursionPct }) : null
const report = { scope: { tradeDate, priorDates, universe: symbols.length }, coverage, warning: 'The configuration was selected using October 19 outcomes and is in-sample. It must be frozen and tested on unseen sessions before live use.', execution: 'Signal after the 09:29 candle; entry at the 09:30 candle close. Fixed percentage stop/target from entry. Stop-first for ambiguous one-minute candles. End-of-day exit if neither is hit.', search: { configurationsTested: configs.length, passingConfigurations: passing.length, bestWithFiveMinuteStructure: familySummary(bestWithStructure), bestWithDepthGate: familySummary(bestWithDepth), bestWithPriorLevelBreakout: familySummary(bestWithPriorBreakout) }, selected: { parameters: selected.parameters, tradeCount: selected.tradeCount, winRatePct: selected.winRatePct, averageReturnPct: selected.averageReturnPct, totalCombinedReturnPct: selected.totalCombinedReturnPct, maximumAdverseExcursionPct: selected.maximumAdverseExcursionPct, worstDay: { date: tradeDate, totalCombinedReturnPct: selected.totalCombinedReturnPct }, costSensitivity: { after0_03PctPerTrade: round(selected.totalCombinedReturnPct - selected.tradeCount * 0.03), after0_05PctPerTrade: round(selected.totalCombinedReturnPct - selected.tradeCount * 0.05), maximumAverageCostPerTradeToRemainAbove10Pct: round((selected.totalCombinedReturnPct - 10) / selected.tradeCount) }, trades: selected.trades.map(compact) }, topConfigurations: configs.slice(0, 20).map(({ trades, ...rest }) => rest) }
let n = 1, output
do { output = path.join(root, 'reports', `${tradeDate}-all-stocks-opening-context${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const columns = ['symbol', 'side', 'signalTime', 'entryTime', 'entryPrice', 'openingReturnPct', 'relativeVolume', 'stop', 'target', 'exitTime', 'exitPrice', 'exitReason', 'returnPct', 'maximumAdverseExcursionPct']
const csvValue = value => /[",\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '')
let csvN = 1, csvOutput
do { csvOutput = path.join(root, 'csv', `${tradeDate}-all-stocks-opening-context-signals${csvN === 1 ? '' : `-${csvN}`}.csv`); csvN++ } while (fs.existsSync(csvOutput))
fs.writeFileSync(csvOutput, [columns.join(','), ...report.selected.trades.map(row => columns.map(column => csvValue(row[column])).join(','))].join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ coverage, passingConfigurations: passing.length, selected: report.selected, output, csvOutput }, null, 2))
