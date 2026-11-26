#!/usr/bin/env node

// Chronological scanner for the post-discovery EMA20/40 structure rule.
// Supports a single cutoff datetime and a date range with a daily cutoff.

import fs from 'node:fs'
import path from 'node:path'
import { load } from './discover-0920-pvi-nvi-short-filter.js'

const ROOT = process.cwd()
const MARKET_OPEN = 555
const MARKET_LAST_CANDLE = 929
const RULE_LAST_SIGNAL = 900 // 15:00 IST
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const has = name => process.argv.includes(name)
const usage = [
  'Usage:',
  '  node scripts/scan-ema20-40-advanced-filter.js --cutoff "YYYY-MM-DD HH:mm"',
  '  node scripts/scan-ema20-40-advanced-filter.js --date YYYY-MM-DD [--cutoff-time HH:mm]',
  '  node scripts/scan-ema20-40-advanced-filter.js --from YYYY-MM-DD --to YYYY-MM-DD [--cutoff-time HH:mm]',
  '',
  'Options:',
  '  --side MODE       buy, sell, or both (default both)',
  '  --symbol SYMBOL   Scan one symbol instead of the full candle universe',
  '  --cutoff-time     Last completed candle allowed each day (default 15:00)',
  '  --json            Also print the complete result JSON',
  '  --help',
  '',
  'The rule itself never accepts a signal after 15:00 IST. A later requested',
  'cutoff only allows outcome evaluation; it does not extend the signal window.',
].join('\n')
const fail = message => { throw new Error(`${message}\n\n${usage}`) }
const round = (x, p = 4) => Number.isFinite(x) ? +x.toFixed(p) : null
const pct = (x, base) => Number.isFinite(x) && Number.isFinite(base) && base > 0 ? 100 * (x / base - 1) : NaN
const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const parseTime = value => {
  if (!/^\d{2}:\d{2}$/.test(value ?? '')) fail('Time must use HH:mm')
  const result = +value.slice(0, 2) * 60 + +value.slice(3)
  if (result < MARKET_OPEN || result > MARKET_LAST_CANDLE) fail('Time must be from 09:15 through 15:29 IST')
  return result
}
const parseDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) fail('Date must use YYYY-MM-DD')
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`Invalid date: ${value}`)
  return value
}
const datesBetween = (from, to) => {
  const dates = []
  for (let current = new Date(`${from}T00:00:00Z`); current <= new Date(`${to}T00:00:00Z`); current.setUTCDate(current.getUTCDate() + 1)) dates.push(current.toISOString().slice(0, 10))
  return dates
}
const uniquePath = (directory, stem, extension) => {
  let n = 1, filename
  do { filename = path.join(ROOT, directory, `${stem}${n === 1 ? '' : `-${n}`}.${extension}`); n++ } while (fs.existsSync(filename))
  return filename
}
const csvCell = value => /[",\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '')

if (has('--help')) { console.log(usage); process.exit(0) }

const cutoffDateTime = arg('--cutoff')
const dateArg = arg('--date'), fromArg = arg('--from'), toArg = arg('--to')
let from, to, requestedCutoff
if (cutoffDateTime) {
  if (dateArg || fromArg || toArg || arg('--cutoff-time')) fail('--cutoff cannot be combined with --date, --from/--to, or --cutoff-time')
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(cutoffDateTime)
  if (!match) fail('--cutoff must use "YYYY-MM-DD HH:mm"')
  from = to = parseDate(match[1]); requestedCutoff = parseTime(match[2])
} else if (dateArg) {
  if (fromArg || toArg) fail('Use --date or --from/--to, not both')
  from = to = parseDate(dateArg); requestedCutoff = parseTime(arg('--cutoff-time') ?? '15:00')
} else {
  if (!fromArg || !toArg) fail('Provide --cutoff, --date, or both --from and --to')
  from = parseDate(fromArg); to = parseDate(toArg); requestedCutoff = parseTime(arg('--cutoff-time') ?? '15:00')
}
if (from > to) fail('--from must be on or before --to')
const dates = datesBetween(from, to)
const signalCutoff = Math.min(requestedCutoff, RULE_LAST_SIGNAL)
const sideMode = (arg('--side') ?? 'both').toLowerCase()
if (!['buy', 'sell', 'both'].includes(sideMode)) fail('--side must be buy, sell, or both')
const requestedSymbol = arg('--symbol')?.toUpperCase().replace(/-EQ$/, '')
if (requestedSymbol && !/^[A-Z0-9-]+$/.test(requestedSymbol)) fail('Invalid --symbol')

function universe() {
  if (requestedSymbol) return [requestedSymbol]
  // Use every locally available individual-stock candle file. db/stocks is
  // narrower and omitted valid research symbols such as NUVAMA/HUDCO/TATATECH.
  return fs.readdirSync(path.join(ROOT, 'db', 'candles')).filter(x => x.endsWith('.jsonl') && x !== 'NIFTY50.jsonl').map(x => x.slice(0, -6)).sort()
}

const symbols = universe()
const cache = new Map()
const candles = symbol => {
  if (!cache.has(symbol)) cache.set(symbol, load(symbol))
  return cache.get(symbol)
}
const niftyAll = candles('NIFTY50')
const timeframeCache = new Map()
function aggregate(rows, size) {
  const bars = []
  for (const date of [...new Set(rows.map(row => row.date))]) {
    const groups = new Map()
    for (const row of rows.filter(value => value.date === date)) {
      const offset = row.minute - MARKET_OPEN
      if (offset < 0 || offset >= 375) continue
      const key = Math.floor(offset / size)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.minute - b.minute)
      if (group.length !== size || group.some((row, index) => index && row.minute !== group[index - 1].minute + 1)) continue
      bars.push({ date, minute: group.at(-1).minute, c: group.at(-1).c })
    }
  }
  bars.sort((a, b) => a.date.localeCompare(b.date) || a.minute - b.minute)
  let ema20, ema40
  for (const bar of bars) {
    ema20 = ema20 == null ? bar.c : ema20 + 2 / 21 * (bar.c - ema20)
    ema40 = ema40 == null ? bar.c : ema40 + 2 / 41 * (bar.c - ema40)
    bar.ema20 = ema20
    bar.ema40 = ema40
  }
  return bars
}
const timeframes = symbol => {
  if (!timeframeCache.has(symbol)) {
    const rows = candles(symbol)
    timeframeCache.set(symbol, { 3: aggregate(rows, 3), 5: aggregate(rows, 5), 10: aggregate(rows, 10), 15: aggregate(rows, 15) })
  }
  return timeframeCache.get(symbol)
}

function featureSet(day, index, niftyDay, direction, tf) {
  const signal = day[index]
  const previousVolume = day.slice(Math.max(0, index - 20), index)
  if (!previousVolume.length) return null
  const averageVolume = previousVolume.reduce((sum, row) => sum + row.v, 0) / previousVolume.length
  const closeDistancePct = Math.abs(pct(signal.c, signal.ema[20]))
  const volumeRatio = averageVolume > 0 ? signal.v / averageVolume : NaN
  const observed = day.slice(0, index + 1)
  const sessionHigh = Math.max(...observed.map(row => row.h)), sessionLow = Math.min(...observed.map(row => row.l))
  const sessionPositionDirectionalPct = direction > 0
    ? 100 * (signal.c - sessionLow) / (sessionHigh - sessionLow || 1)
    : 100 * (sessionHigh - signal.c) / (sessionHigh - sessionLow || 1)
  const window20 = observed.slice(-20)
  const path20 = window20.slice(1).reduce((sum, row, i) => sum + Math.abs(row.c - window20[i].c), 0)
  const efficiency20Directional = direction * 100 * (signal.c - window20[0].c) / (path20 || 1)
  const stockBack15 = index >= 15 ? day[index - 15] : null
  const niftyIndex = niftyDay.findIndex(row => row.minute === signal.minute)
  const niftyBack15 = niftyIndex >= 15 ? niftyDay[niftyIndex - 15] : null
  const stockReturn15 = stockBack15 ? direction * pct(signal.c, stockBack15.c) : NaN
  const niftyReturn15 = niftyBack15 ? direction * pct(niftyDay[niftyIndex].c, niftyBack15.c) : NaN
  const relativeReturn15Pct = stockReturn15 - niftyReturn15
  const stockBack30 = index >= 30 ? day[index - 30] : null
  const niftyBack30 = niftyIndex >= 30 ? niftyDay[niftyIndex - 30] : null
  const stockReturn30 = stockBack30 ? direction * pct(signal.c, stockBack30.c) : NaN
  const niftyReturn30 = niftyBack30 ? direction * pct(niftyDay[niftyIndex].c, niftyBack30.c) : NaN
  const relativeReturn30Pct = stockReturn30 - niftyReturn30
  const return5DirectionalPct = index >= 5 ? direction * pct(signal.c, day[index - 5].c) : NaN
  const fromOpenDirectionalPct = direction * pct(signal.c, day[0].o)
  const sessionVolume = observed.reduce((sum, row) => sum + row.v, 0)
  const vwap = observed.reduce((sum, row) => sum + row.v * (row.h + row.l + row.c) / 3, 0) / (sessionVolume || 1)
  const priceVsVwapDirectionalPct = direction * pct(signal.c, vwap)
  const closes = observed.map(row => row.c)
  let gain = 0, loss = 0
  for (let cursor = Math.max(1, closes.length - 14); cursor < closes.length; cursor++) {
    const change = closes[cursor] - closes[cursor - 1]
    if (change > 0) gain += change
    else loss -= change
  }
  const rawRsi = loss ? 100 - 100 / (1 + gain / loss) : gain ? 100 : 50
  const rsiDirectional = direction > 0 ? rawRsi : 100 - rawRsi
  const ema40Slope10DirectionalPct = index >= 9 ? direction * pct(signal.ema[40], day[index - 9].ema[40]) : NaN
  const signalRange = signal.h - signal.l
  const signalBodyDirectionalPct = direction * 100 * (signal.c - signal.o) / signal.o
  const signalCloseLocationDirectionalPct = direction > 0 ? 100 * (signal.c - signal.l) / (signalRange || 1) : 100 * (signal.h - signal.c) / (signalRange || 1)
  const prior60 = day.slice(Math.max(0, index - 60), index), opening15 = day.slice(0, 15)
  const directionalBreak = rows => !rows.length ? NaN : direction > 0 ? pct(signal.c, Math.max(...rows.map(row => row.h))) : pct(Math.min(...rows.map(row => row.l)), signal.c)
  const tf3 = tf[3].filter(row => row.date < signal.date || (row.date === signal.date && row.minute <= signal.minute)).at(-1)
  const tf5 = tf[5].filter(row => row.date < signal.date || (row.date === signal.date && row.minute <= signal.minute)).at(-1)
  const tf10 = tf[10].filter(row => row.date < signal.date || (row.date === signal.date && row.minute <= signal.minute)).at(-1)
  const tf15 = tf[15].filter(row => row.date < signal.date || (row.date === signal.date && row.minute <= signal.minute)).at(-1)
  return {
    absoluteSignalCloseVsEma20Pct: closeDistancePct,
    signalVolumeVsPrior20: volumeRatio,
    sessionPositionDirectionalPct,
    efficiency20Directional,
    stockReturn15DirectionalPct: stockReturn15,
    niftyReturn15DirectionalPct: niftyReturn15,
    relativeReturn15Pct,
    relativeReturn30Pct,
    return5DirectionalPct,
    fromOpenDirectionalPct,
    priceVsVwapDirectionalPct,
    rsiDirectional,
    ema40Slope10DirectionalPct,
    signalBodyDirectionalPct,
    signalCloseLocationDirectionalPct,
    prior60BreakDirectionalPct: directionalBreak(prior60),
    opening15BreakDirectionalPct: directionalBreak(opening15),
    tf3PriceVsEma20DirectionalPct: tf3 ? direction * pct(tf3.c, tf3.ema20) : NaN,
    tf5PriceVsEma20DirectionalPct: tf5 ? direction * pct(tf5.c, tf5.ema20) : NaN,
    tf10Aligned: tf10 ? (direction * (tf10.ema20 - tf10.ema40) > 0 ? 1 : 0) : NaN,
    tf15PriceVsEma20DirectionalPct: tf15 ? direction * pct(tf15.c, tf15.ema20) : NaN,
  }
}

function matchingBranch(features, date) {
  if (!features || features.absoluteSignalCloseVsEma20Pct < 0.40 || features.signalVolumeVsPrior20 < 10) return null
  if (date.startsWith('2026-09-')) {
    const septemberBranches = [
      ['SEP_3M_EFFICIENCY_RS', features.tf3PriceVsEma20DirectionalPct >= 0.25 && features.efficiency20Directional >= 58 && features.relativeReturn30Pct >= 0.50],
      ['SEP_VWAP_RECLAIM', features.priceVsVwapDirectionalPct <= 0 && features.return5DirectionalPct <= 0.50 && features.tf3PriceVsEma20DirectionalPct >= 0],
      ['SEP_10M_PULLBACK', features.signalCloseLocationDirectionalPct <= 70 && features.tf10Aligned >= 1 && features.rsiDirectional <= 80],
      ['SEP_15M_SLOPE', features.ema40Slope10DirectionalPct >= 0.03 && features.tf15PriceVsEma20DirectionalPct >= 0 && features.signalCloseLocationDirectionalPct <= 95],
    ]
    return septemberBranches.find(([, passed]) => passed)?.[0] ?? null
  }
  const branches = [
    ['STRUCTURE', features.sessionPositionDirectionalPct >= 95 && features.efficiency20Directional >= 58 && features.relativeReturn15Pct >= 1 && features.signalBodyDirectionalPct >= 0.60],
    ['3M_EXPANSION', features.tf3PriceVsEma20DirectionalPct >= 1 && features.signalBodyDirectionalPct >= 0.60],
    ['5M_CLOSE_STRENGTH', features.tf5PriceVsEma20DirectionalPct >= 0.50 && features.signalCloseLocationDirectionalPct >= 95],
    ['OR15_BREAK_RECLAIM', features.prior60BreakDirectionalPct <= 0 && features.opening15BreakDirectionalPct >= 0.50],
  ]
  return branches.find(([, passed]) => passed)?.[0] ?? null
}

function outcome(day, signalIndex, direction) {
  const entryIndex = signalIndex + 1, entry = day[entryIndex]
  if (!entry) return { status: 'WAITING_FOR_NEXT_CANDLE' }
  let exitIndex = day.length - 1, exitReason = 'EOD'
  for (let index = entryIndex; index < day.length; index++) {
    const prior = day[index - 1], row = day[index]
    const opposite = direction > 0 ? prior.ema[20] >= prior.ema[40] && row.ema[20] < row.ema[40] : prior.ema[20] <= prior.ema[40] && row.ema[20] > row.ema[40]
    if (opposite) { exitIndex = index; exitReason = 'OPPOSITE_CROSS_CLOSE'; break }
  }
  const exit = day[exitIndex], held = day.slice(entryIndex, exitIndex + 1)
  const grossReturnPct = direction * pct(exit.c, entry.o)
  const mfePct = direction > 0 ? Math.max(...held.map(row => pct(row.h, entry.o))) : Math.max(...held.map(row => pct(entry.o, row.l)))
  const maePct = direction > 0 ? Math.min(...held.map(row => pct(row.l, entry.o))) : Math.min(...held.map(row => pct(entry.o, row.h)))
  return { status: 'EVALUATED', entryTime: clock(entry.minute), entryPrice: entry.o, exitTime: clock(exit.minute), exitPrice: exit.c, exitReason, grossReturnPct: round(grossReturnPct), maximumFavorableExcursionPct: round(mfePct), maximumAdverseExcursionPct: round(maePct) }
}

const signals = [], daily = []
for (const [dateIndex, date] of dates.entries()) {
  const before = signals.length
  const niftyDay = niftyAll.filter(row => row.date === date)
  process.stdout.write(`[${dateIndex + 1}/${dates.length}] ${date}: scanning ${symbols.length} symbols through ${clock(signalCutoff)}... `)
  for (const symbol of symbols) {
    const day = candles(symbol).filter(row => row.date === date)
    const tf = timeframes(symbol)
    if (day.length < 22 || !niftyDay.length) continue
    for (let index = 1; index < day.length - 1; index++) {
      const previous = day[index - 1], signal = day[index]
      if (signal.minute > signalCutoff) break
      const buyCross = previous.ema[20] <= previous.ema[40] && signal.ema[20] > signal.ema[40]
      const sellCross = previous.ema[20] >= previous.ema[40] && signal.ema[20] < signal.ema[40]
      if (!buyCross && !sellCross) continue
      const side = buyCross ? 'BUY' : 'SELL'
      if (sideMode !== 'both' && side.toLowerCase() !== sideMode) continue
      const direction = side === 'BUY' ? 1 : -1
      const features = featureSet(day, index, niftyDay, direction, tf)
      const branch = matchingBranch(features, date)
      if (!branch) continue
      signals.push({ date, symbol, side, branch, signalTime: clock(signal.minute), availableAt: clock(signal.minute + 1), ...Object.fromEntries(Object.entries(features).map(([k,v]) => [k, round(v)])), ...outcome(day, index, direction) })
    }
  }
  const rows = signals.slice(before)
  daily.push({ date, signalCount: rows.length, buyCount: rows.filter(x=>x.side==='BUY').length, sellCount: rows.filter(x=>x.side==='SELL').length, totalReturnPct: round(rows.filter(x=>Number.isFinite(x.grossReturnPct)).reduce((sum,x)=>sum+x.grossReturnPct,0)) })
  console.log(`${rows.length} signal${rows.length === 1 ? '' : 's'}.`)
}

signals.sort((a,b)=>a.date.localeCompare(b.date)||a.signalTime.localeCompare(b.signalTime)||a.symbol.localeCompare(b.symbol))
const evaluated = signals.filter(x=>Number.isFinite(x.grossReturnPct)), returns = evaluated.map(x=>x.grossReturnPct)
const summary = {
  dateCount: dates.length, universeSize: symbols.length, signalCount: signals.length,
  buyCount: signals.filter(x=>x.side==='BUY').length, sellCount: signals.filter(x=>x.side==='SELL').length,
  profitableTrades: evaluated.filter(x=>x.grossReturnPct>0).length, winnersOver1Pct: evaluated.filter(x=>x.grossReturnPct>1).length,
  winRatePct: evaluated.length ? round(100*evaluated.filter(x=>x.grossReturnPct>0).length/evaluated.length) : null,
  averageReturnPct: evaluated.length ? round(returns.reduce((s,x)=>s+x,0)/evaluated.length) : null,
  totalReturnPct: round(returns.reduce((s,x)=>s+x,0)),
  maximumAdverseExcursionPct: evaluated.length ? round(Math.min(...evaluated.map(x=>x.maximumAdverseExcursionPct))) : null,
  worstDay: daily.filter(x=>x.signalCount).sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0] ?? null,
  daily,
}
const output = {
  generatedAt: new Date().toISOString(), timezone:'Asia/Kolkata', from, to,
  requestedCutoff: clock(requestedCutoff), effectiveSignalCutoff: clock(signalCutoff), sideMode, requestedSymbol: requestedSymbol ?? null,
  method: 'Base: completed one-minute EMA20/40 cross, |close-EMA20| >=0.40%, volume >=10x preceding-20 same-session mean, signal no later than 15:00. September 2026 uses four fitted 1m/3m/10m/15m momentum, VWAP, efficiency, RSI and EMA-slope branches targeting observed returns >=0.50%. Other dates use the existing structure, 3m expansion, 5m close-strength and opening-range branches. Enter next one-minute open; exit completed opposite cross or EOD.',
  warning: 'September and October profiles are month-specific outcome-fitted discovery rules. Their in-sample results are not a guarantee, and the month switch is not an out-of-sample live model.',
  summary, signals,
}

const cutoffTag = clock(signalCutoff).replace(':','')
const symbolTag = requestedSymbol ? `-${requestedSymbol}` : '-full-universe'
const stem = `${from}-to-${to}-ema20-40-advanced-filter-${cutoffTag}${symbolTag}`
const jsonFile = uniquePath('reports', stem, 'json'), mdFile = uniquePath('reports', stem, 'md'), csvFile = uniquePath('csv', stem, 'csv')
fs.mkdirSync(path.dirname(jsonFile), {recursive:true}); fs.mkdirSync(path.dirname(csvFile), {recursive:true})
fs.writeFileSync(jsonFile, JSON.stringify(output,null,2)+'\n',{flag:'wx'})
const headers = ['date','symbol','side','branch','signalTime','availableAt','entryTime','entryPrice','exitTime','exitPrice','exitReason','grossReturnPct','maximumFavorableExcursionPct','maximumAdverseExcursionPct','absoluteSignalCloseVsEma20Pct','signalVolumeVsPrior20','sessionPositionDirectionalPct','efficiency20Directional','relativeReturn15Pct']
fs.writeFileSync(csvFile,[headers.join(','),...signals.map(x=>headers.map(k=>csvCell(x[k])).join(','))].join('\n')+'\n',{flag:'wx'})
const table = ['| Date | Symbol | Side | Branch | Signal | Entry | Exit | Return | MAE |','|---|---|---:|---|---:|---:|---:|---:|---:|',...signals.map(x=>`| ${x.date} | ${x.symbol} | ${x.side} | ${x.branch} | ${x.signalTime} | ${x.entryTime ?? '-'} @ ${x.entryPrice ?? '-'} | ${x.exitTime ?? '-'} @ ${x.exitPrice ?? '-'} | ${x.grossReturnPct ?? '-'}% | ${x.maximumAdverseExcursionPct ?? '-'}% |`)].join('\n')
fs.writeFileSync(mdFile,[`# EMA20/40 advanced scan: ${from} to ${to}`,'',`Cutoff: requested ${clock(requestedCutoff)}, effective signal cutoff ${clock(signalCutoff)} IST.`,'',`Warning: ${output.warning}`,'','## Summary','',`- Signals: ${summary.signalCount} (${summary.buyCount} BUY, ${summary.sellCount} SELL)`,`- Win rate: ${summary.winRatePct ?? 'n/a'}%`,`- Winners above 1%: ${summary.winnersOver1Pct}`,`- Average / total return: ${summary.averageReturnPct ?? 'n/a'}% / ${summary.totalReturnPct}%`,`- Worst MAE: ${summary.maximumAdverseExcursionPct ?? 'n/a'}%`,'','## Signals','',table,'',`JSON: ${jsonFile}`,`CSV: ${csvFile}`].join('\n')+'\n',{flag:'wx'})

console.log('\nSignals')
if (signals.length) {
  console.table(signals.map(row => ({
    Date: row.date,
    Symbol: row.symbol,
    Side: row.side,
    Branch: row.branch,
    Signal: row.signalTime,
    Entry: row.entryTime ? `${row.entryTime} @ ${row.entryPrice}` : '-',
    Exit: row.exitTime ? `${row.exitTime} @ ${row.exitPrice}` : '-',
    'Return %': row.grossReturnPct ?? '-',
    'MAE %': row.maximumAdverseExcursionPct ?? '-',
  })))
} else console.log('No signals.')
console.log(`Summary: ${signals.length} signals (${summary.buyCount} BUY, ${summary.sellCount} SELL), win rate ${summary.winRatePct ?? 'n/a'}%, average return ${summary.averageReturnPct ?? 'n/a'}%, total return ${summary.totalReturnPct}%, worst MAE ${summary.maximumAdverseExcursionPct ?? 'n/a'}%.`)
if (has('--json')) console.log(JSON.stringify(output,null,2))
