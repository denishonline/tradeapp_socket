import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const tradeDate = process.argv[2] ?? '2026-10-19'
const priorDates = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
if (tradeDate !== '2026-10-19') throw new Error('This research script is scoped to 2026-10-19 with 2026-10-13..16 as its prior sessions')
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).replace(/-EQ$/i, '').toUpperCase()))]
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const hhmm = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
const timeText = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

function readCandles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const timestamp = local(Number(row.time)), date = timestamp.slice(0, 10), minute = timestamp.slice(11)
    if (![...priorDates, tradeDate].includes(date) || minute < '09:15' || minute > '15:29') continue
    if (![row.open, row.high, row.low, row.close, row.volume].every(x => Number.isFinite(Number(x)))) continue
    unique.set(timestamp, { timestamp, date, minute, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume })
  }
  const rows = [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const byDate = Object.fromEntries([...priorDates, tradeDate].map(date => [date, rows.filter(row => row.date === date)]))
  if ([...priorDates, tradeDate].some(date => byDate[date].length !== 375)) return null
  return byDate
}

function fiveMinute(rows) {
  const bars = []
  for (let i = 0; i < rows.length; i += 5) {
    const part = rows.slice(i, i + 5)
    if (part.length !== 5 || hhmm(part.at(-1).minute) - hhmm(part[0].minute) !== 4) continue
    bars.push({ startIndex: i, endIndex: i + 4, start: part[0].minute, end: part.at(-1).minute, open: part[0].open, high: Math.max(...part.map(x => x.high)), low: Math.min(...part.map(x => x.low)), close: part.at(-1).close, volume: part.reduce((s, x) => s + x.volume, 0) })
  }
  return bars
}

function prefixMetrics(rows) {
  let cumulativeVolume = 0, pv = 0
  return rows.map(row => {
    cumulativeVolume += row.volume
    pv += ((row.high + row.low + row.close) / 3) * row.volume
    return { cumulativeVolume, vwap: pv / cumulativeVolume }
  })
}

function makeCandidate(symbol, byDate, side, levelType, tolerancePct) {
  const today = byDate[tradeDate], bars = fiveMinute(today), prefix = prefixMetrics(today)
  const prior = priorDates.map(date => byDate[date])
  const daily = prior.map(rows => ({ high: Math.max(...rows.map(x => x.high)), low: Math.min(...rows.map(x => x.low)) }))
  const direction = side === 'BUY' ? 1 : -1
  const level = side === 'BUY'
    ? (levelType === 'fourDayExtreme' ? Math.max(...daily.map(x => x.high)) : daily.at(-1).high)
    : (levelType === 'fourDayExtreme' ? Math.min(...daily.map(x => x.low)) : daily.at(-1).low)
  const breakBar = bars.find(bar => hhmm(bar.end) >= 559 && hhmm(bar.end) <= 840 && direction * (bar.close - level) > 0)
  if (!breakBar) return null
  const maxSignalIndex = Math.min(today.length - 2, breakBar.endIndex + 30)
  let retestIndex = -1, signalIndex = -1
  for (let i = breakBar.endIndex + 1; i < maxSignalIndex; i++) {
    const retest = today[i], signal = today[i + 1]
    const touched = side === 'BUY' ? retest.low <= level * (1 + tolerancePct / 100) : retest.high >= level * (1 - tolerancePct / 100)
    const held = side === 'BUY' ? retest.close >= level * 0.999 : retest.close <= level * 1.001
    const reclaim = side === 'BUY'
      ? signal.close > signal.open && signal.close > retest.close && signal.close > level
      : signal.close < signal.open && signal.close < retest.close && signal.close < level
    const vwapAligned = direction * (signal.close - prefix[i + 1].vwap) > 0 && direction * (prefix[i + 1].vwap - prefix[breakBar.endIndex].vwap) > 0
    if (touched && held && reclaim && vwapAligned) { retestIndex = i; signalIndex = i + 1; break }
  }
  if (signalIndex < 0) return null
  const entryIndex = signalIndex + 1, entry = today[entryIndex]
  const rawStop = side === 'BUY'
    ? Math.min(today[retestIndex].low, level * 0.9995)
    : Math.max(today[retestIndex].high, level * 1.0005)
  const stop = side === 'BUY' ? rawStop * 0.9997 : rawStop * 1.0003
  const riskPct = 100 * Math.abs(entry.close - stop) / entry.close
  if (!(riskPct > 0 && riskPct <= 1.25)) return null
  const signalMinute = today[signalIndex].minute
  const todayCum = prefix[signalIndex].cumulativeVolume
  const priorCum = prior.map(rows => rows.slice(0, signalIndex + 1).reduce((s, x) => s + x.volume, 0))
  const relativeVolume = todayCum / mean(priorCum)
  return { symbol, side, levelType, level: round(level, 2), tolerancePct, breakout5m: breakBar, retestTime: today[retestIndex].timestamp, retestPrice: today[retestIndex].close, signalTime: today[signalIndex].timestamp, signalMinute, signalPrice: today[signalIndex].close, entryTime: entry.timestamp, entryPrice: entry.close, entryIndex, stop: round(stop, 4), riskPct: round(riskPct), relativeVolume: round(relativeVolume), signalVwap: round(prefix[signalIndex].vwap, 4), vwapRiseFromBreakPct: round(100 * direction * (prefix[signalIndex].vwap / prefix[breakBar.endIndex].vwap - 1)), today, signalIndex }
}

function depthMinutes(symbol, wantedMinutes) {
  const file = path.join(root, 'db', 'cash-depth', tradeDate, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const state = {}, buckets = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const received = Date.parse(event.receivedAt)
    if (!Number.isFinite(received)) continue
    const at = new Date(received + 330 * 60_000).toISOString().slice(0, 16)
    if (at.slice(0, 10) !== tradeDate) continue
    if (event.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    const minute = at.slice(11)
    if (!wantedMinutes.has(minute)) continue
    const bidSizes = [], askSizes = []
    let valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) { valid = false; break }
      bidSizes.push(bs); askSizes.push(as)
    }
    if (!valid) continue
    const bid = bidSizes.reduce((s, x) => s + x, 0), ask = askSizes.reduce((s, x) => s + x, 0)
    const midpoint = (+state.bid_price1 + +state.ask_price1) / 2
    const row = { bidSharePct: 100 * bid / (bid + ask || 1), midpoint, spreadBps: 10000 * (+state.ask_price1 - +state.bid_price1) / midpoint }
    if (!buckets.has(minute)) buckets.set(minute, [])
    buckets.get(minute).push(row)
  }
  const summaries = new Map()
  for (const [minute, rows] of buckets) if (rows.length >= 5) summaries.set(minute, { snapshots: rows.length, avgBidSharePct: round(mean(rows.map(x => x.bidSharePct))), bidDominantPct: round(100 * rows.filter(x => x.bidSharePct > 50).length / rows.length), midpointMovePct: round(100 * (rows.at(-1).midpoint / rows[0].midpoint - 1)), avgSpreadBps: round(mean(rows.map(x => x.spreadBps))) })
  return summaries
}

function outcome(candidate, rewardRisk) {
  const direction = candidate.side === 'BUY' ? 1 : -1
  const entry = candidate.entryPrice, risk = Math.abs(entry - candidate.stop)
  const target = entry + direction * rewardRisk * risk
  let exit = null
  let mae = 0
  for (const row of candidate.today.slice(candidate.entryIndex + 1)) {
    const adverse = candidate.side === 'BUY' ? 100 * (row.low / entry - 1) : 100 * (1 - row.high / entry)
    mae = Math.min(mae, adverse)
    const stopHit = candidate.side === 'BUY' ? row.low <= candidate.stop : row.high >= candidate.stop
    const targetHit = candidate.side === 'BUY' ? row.high >= target : row.low <= target
    if (stopHit && targetHit) { exit = { time: row.timestamp, price: candidate.stop, reason: 'ambiguous candle; stop-first' }; break }
    if (stopHit) { exit = { time: row.timestamp, price: candidate.stop, reason: 'stop' }; break }
    if (targetHit) { exit = { time: row.timestamp, price: target, reason: 'target' }; break }
  }
  if (!exit) { const last = candidate.today.at(-1); exit = { time: last.timestamp, price: last.close, reason: 'end-of-day' } }
  const returnPct = 100 * direction * (exit.price / entry - 1)
  return { target: round(target, 4), exitTime: exit.time, exitPrice: round(exit.price, 4), exitReason: exit.reason, returnPct: round(returnPct), maximumAdverseExcursionPct: round(mae) }
}

const toleranceValues = [0.10, 0.20, 0.30]
const levelTypes = ['fourDayExtreme', 'previousDay']
const rawCandidates = []
const coverage = { requestedStocks: symbols.length, completeCandleStocks: 0, missingOrIncomplete: [] }
for (const symbol of symbols) {
  const byDate = readCandles(symbol)
  if (!byDate) { coverage.missingOrIncomplete.push(symbol); continue }
  coverage.completeCandleStocks++
  for (const side of ['BUY', 'SELL']) for (const levelType of levelTypes) for (const tolerance of toleranceValues) {
    const candidate = makeCandidate(symbol, byDate, side, levelType, tolerance)
    if (candidate) rawCandidates.push(candidate)
  }
}

for (const symbol of new Set(rawCandidates.map(x => x.symbol))) {
  const group = rawCandidates.filter(x => x.symbol === symbol)
  const summaries = depthMinutes(symbol, new Set(group.map(x => x.signalMinute)))
  for (const candidate of group) candidate.depth = summaries.get(candidate.signalMinute) ?? null
}

const configurations = []
for (const levelType of levelTypes) for (const tolerancePct of toleranceValues)
for (const minimumRvol of [1.0, 1.25, 1.5, 2.0]) for (const minimumDirectionalBidShare of [50, 55, 60])
for (const minimumDirectionalMidpointMove of [-0.05, 0]) for (const maximumRiskPct of [0.5, 0.75])
for (const rewardRisk of [1, 1.5]) {
  const matches = rawCandidates.filter(x => x.levelType === levelType && x.tolerancePct === tolerancePct && x.relativeVolume >= minimumRvol && x.riskPct <= maximumRiskPct && x.depth && x.depth.avgSpreadBps <= 15 && (x.side === 'BUY' ? x.depth.avgBidSharePct : 100 - x.depth.avgBidSharePct) >= minimumDirectionalBidShare && (x.side === 'BUY' ? x.depth.midpointMovePct : -x.depth.midpointMovePct) >= minimumDirectionalMidpointMove)
  const earliestBySymbol = [...Map.groupBy(matches.sort((a, b) => a.signalTime.localeCompare(b.signalTime)), x => x.symbol).values()].map(rows => rows[0])
  const trades = earliestBySymbol.map(x => ({ ...x, ...outcome(x, rewardRisk) }))
  const returns = trades.map(x => x.returnPct)
  configurations.push({ parameters: { levelType, tolerancePct, minimumRvol, minimumDirectionalBidShare, minimumDirectionalMidpointMove, maximumRiskPct, rewardRisk }, tradeCount: trades.length, winRatePct: trades.length ? round(100 * returns.filter(x => x > 0).length / trades.length) : null, averageReturnPct: trades.length ? round(mean(returns)) : null, totalCombinedReturnPct: round(returns.reduce((s, x) => s + x, 0)), maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(x => x.maximumAdverseExcursionPct))) : null, trades })
}
configurations.sort((a, b) => b.totalCombinedReturnPct - a.totalCombinedReturnPct || b.tradeCount - a.tradeCount)
const selected = configurations.find(x => x.totalCombinedReturnPct >= 10 && x.tradeCount >= 10 && x.winRatePct >= 50) ?? configurations[0]
const compactTrade = trade => ({ symbol: trade.symbol, side: trade.side, levelType: trade.levelType, level: trade.level, breakout5mEnd: trade.breakout5m.end, retestTime: trade.retestTime, signalTime: trade.signalTime, entryTime: trade.entryTime, entryPrice: trade.entryPrice, stop: trade.stop, target: trade.target, riskPct: trade.riskPct, relativeVolume: trade.relativeVolume, depth: trade.depth, exitTime: trade.exitTime, exitPrice: trade.exitPrice, exitReason: trade.exitReason, returnPct: trade.returnPct, maximumAdverseExcursionPct: trade.maximumAdverseExcursionPct })
const report = {
  scope: { tradeDate, priorDates, universe: symbols.length }, coverage,
  warning: 'The selected configuration was chosen using 2026-10-19 outcomes. It is an in-sample research result, not validated expected performance.',
  execution: 'All signals use only completed candles and depth through the signal minute. Entry is the next completed one-minute candle close. Stop wins ambiguous same-candle stop/target cases. One earliest qualifying trade per stock.',
  search: { configurationsTested: configurations.length, dimensions: { levelTypes, toleranceValues, minimumRvol: [1, 1.25, 1.5, 2], minimumDirectionalBidShare: [50, 55, 60], minimumDirectionalMidpointMove: [-0.05, 0], maximumRiskPct: [0.5, 0.75], rewardRisk: [1, 1.5] } },
  selected: { parameters: selected.parameters, tradeCount: selected.tradeCount, winRatePct: selected.winRatePct, averageReturnPct: selected.averageReturnPct, totalCombinedReturnPct: selected.totalCombinedReturnPct, maximumAdverseExcursionPct: selected.maximumAdverseExcursionPct, worstDay: { date: tradeDate, totalCombinedReturnPct: selected.totalCombinedReturnPct }, trades: selected.trades.map(compactTrade) },
  topConfigurations: configurations.slice(0, 20).map(x => ({ parameters: x.parameters, tradeCount: x.tradeCount, winRatePct: x.winRatePct, averageReturnPct: x.averageReturnPct, totalCombinedReturnPct: x.totalCombinedReturnPct, maximumAdverseExcursionPct: x.maximumAdverseExcursionPct }))
}
let n = 1, output
do { output = path.join(root, 'reports', `${tradeDate}-all-stocks-four-day-breakout-retest${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ coverage, rawCandidateRows: rawCandidates.length, selected: { ...report.selected, trades: report.selected.trades.map(x => ({ symbol: x.symbol, side: x.side, signalTime: x.signalTime.slice(11), entryPrice: x.entryPrice, stop: x.stop, target: x.target, relativeVolume: x.relativeVolume, returnPct: x.returnPct, exitReason: x.exitReason })) }, output }, null, 2))
