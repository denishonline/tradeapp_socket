import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sourceFile = process.argv[2] ?? 'reports/2026-10-22-23-0930-high-precision-context-2.json'
const candidates = JSON.parse(fs.readFileSync(sourceFile, 'utf8')).signals
const dates = ['2026-10-22', '2026-10-23']
const ist = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = seconds => ist(seconds).slice(0, 10)
const minuteOf = seconds => ist(seconds).slice(11)
const round = value => Number.isFinite(value) ? Number(value.toFixed(4)) : null
const pct = (value, base) => 100 * (value / base - 1)
const readRows = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})
const candleCache = new Map()
function candles(symbol, date) {
  const key = `${symbol}|${date}`
  if (!candleCache.has(key)) candleCache.set(key, readRows(path.join(root, 'db', 'candles', `${symbol}.jsonl`))
    .filter(row => dateOf(row.time) === date && minuteOf(row.time) >= '09:15' && minuteOf(row.time) < '15:00')
    .sort((a, b) => a.time - b.time))
  return candleCache.get(key)
}
function replay(signal, targetPct) {
  const rows = candles(signal.symbol, signal.date)
  const direction = signal.side === 'BUY' ? 1 : -1
  const stopPrice = signal.entryPrice * (1 - direction * .005)
  const targetPrice = signal.entryPrice * (1 + direction * targetPct / 100)
  const entryEpoch = Date.parse(`${signal.entryAt.replace(' ', 'T')}:00+05:30`) / 1000
  let mae = 0
  for (const row of rows) {
    if (row.time < entryEpoch) continue
    const adverse = direction > 0 ? pct(row.low, signal.entryPrice) : -pct(row.high, signal.entryPrice)
    mae = Math.min(mae, adverse)
    const gapStop = direction > 0 ? row.open <= stopPrice : row.open >= stopPrice
    const stopHit = direction > 0 ? row.low <= stopPrice : row.high >= stopPrice
    const targetHit = direction > 0 ? row.high >= targetPrice : row.low <= targetPrice
    if (gapStop || stopHit) return { ...signal, targetPct, reason: 'SL', exitAt: ist(row.time + 60), returnPct: round(direction * pct(gapStop ? row.open : stopPrice, signal.entryPrice)), maxAdverseExcursionPct: round(mae) }
    if (targetHit) return { ...signal, targetPct, reason: 'TARGET', exitAt: ist(row.time + 60), returnPct: targetPct, maxAdverseExcursionPct: round(mae) }
  }
  const last = rows.at(-1)
  return { ...signal, targetPct, reason: '15:00', exitAt: ist(last.time + 60), returnPct: round(direction * pct(last.close, signal.entryPrice)), maxAdverseExcursionPct: round(mae) }
}
function select(test) {
  const chosen = new Map()
  for (const row of [...candidates].sort((a, b) => a.signalAt.localeCompare(b.signalAt))) {
    if (!test(row)) continue
    const key = `${row.date}|${row.symbol}`
    if (!chosen.has(key)) chosen.set(key, row)
  }
  return [...chosen.values()]
}
const core = row => row.directionalCandles5 >= 4 && row.ema50Vs200DirectionalPct >= 1 && row.priceVsEma50DirectionalPct >= .25 && row.move10mDirectionalPct >= 0
const earlyDepth = row => row.signalAt.slice(11) < '09:40' && row.depthSharePct >= 60 && row.nifty3DirectionalPct >= .1 && row.recentVolumeRatio >= .8 && row.priorRangeDirectionalPositionPct <= 125
const earlyStrongDepth = row => row.signalAt.slice(11) < '09:40' && row.twoDirectionalPct >= .25 && row.depthSharePct >= 70 && row.depthMidMovePct >= .1 && row.nifty3DirectionalPct >= 0
const confirmedReversal = row => row.signalAt.slice(11) >= '09:40' && row.directionalCandles5 >= 5 && row.fiveDirectionalPct >= .75 && row.move10mDirectionalPct >= 1 && row.depthSharePct >= 60 && row.depthMidMovePct >= .1 && row.nifty3DirectionalPct >= .1 && row.recentVolumeRatio >= 1
const profiles = [
  ...['09:30','09:32','09:35','09:38','09:40'].map(start => ({ name: `CORE_FROM_${start.replace(':','')}`, test: row => row.signalAt.slice(11) >= start && core(row) })),
  { name: 'EARLY_DEPTH_BEFORE_0940', test: earlyDepth },
  { name: 'EARLY_STRONG_DEPTH_BEFORE_0940', test: earlyStrongDepth },
  { name: 'HYBRID_EARLY_DEPTH_THEN_CORE', test: row => earlyDepth(row) || (row.signalAt.slice(11) >= '09:40' && core(row)) },
  { name: 'HYBRID_EARLY_STRONG_DEPTH_THEN_CORE', test: row => earlyStrongDepth(row) || (row.signalAt.slice(11) >= '09:40' && core(row)) },
  { name: 'CONFIRMED_REVERSAL_FROM_0940', test: confirmedReversal },
  { name: 'HYBRID_WITH_CONFIRMED_REVERSAL', test: row => earlyDepth(row) || confirmedReversal(row) || (row.signalAt.slice(11) >= '09:40' && core(row)) },
]
const stats = rows => {
  const total = rows.reduce((sum, row) => sum + row.returnPct, 0)
  const byDay = dates.map(date => ({ date, rows: rows.filter(row => row.date === date) })).map(item => ({ date: item.date, trades: item.rows.length, totalReturnPct: round(item.rows.reduce((sum, row) => sum + row.returnPct, 0)) }))
  const signalMinutes = rows.map(row => Number(row.signalAt.slice(11, 13)) * 60 + Number(row.signalAt.slice(14, 16)))
  return { trades: rows.length, wins: rows.filter(row => row.reason === 'TARGET').length,
    winRatePct: round(100 * rows.filter(row => row.reason === 'TARGET').length / (rows.length || 1)), averageReturnPct: round(total / (rows.length || 1)), totalReturnPct: round(total),
    maximumAdverseExcursionPct: rows.length ? round(Math.min(...rows.map(row => row.maxAdverseExcursionPct))) : null,
    averageSignalTime: signalMinutes.length ? `${String(Math.floor(signalMinutes.reduce((a,b)=>a+b,0)/signalMinutes.length/60)).padStart(2,'0')}:${String(Math.round(signalMinutes.reduce((a,b)=>a+b,0)/signalMinutes.length)%60).padStart(2,'0')}` : null,
    worstDay: byDay.sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] ?? null }
}
const evaluations = profiles.map(profile => {
  const selected = select(profile.test)
  return { name: profile.name, signals: selected.length, sides: { BUY: selected.filter(x=>x.side==='BUY').length, SELL: selected.filter(x=>x.side==='SELL').length },
    targets: [1, 1.5, 2].map(target => ({ targetPct: target, ...stats(selected.map(row => replay(row, target))) })) }
})
let outputFile = 'reports/2026-10-22-23-0930-earlier-mtf-evaluation.json', suffix = 2
while (fs.existsSync(outputFile)) outputFile = `reports/2026-10-22-23-0930-earlier-mtf-evaluation-${suffix++}.json`
fs.writeFileSync(outputFile, `${JSON.stringify({ sourceFile, rules: { core: 'Base causal candidate + >=4/5 directional candles + directional EMA50/EMA200 gap >=1% + price directional distance from EMA50 >=0.25% + 10m directional move >=0' }, evaluations }, null, 2)}\n`, { flag: 'wx' })
const hybridSignals = select(row => earlyDepth(row) || (row.signalAt.slice(11) >= '09:40' && core(row))).map(row => ({ branch: earlyDepth(row) ? 'EARLY_DEPTH' : 'LATE_CORE', ...replay(row, 1) }))
let signalFile = 'reports/2026-10-22-23-0930-earlier-hybrid-signals.csv'; suffix = 2
while (fs.existsSync(signalFile)) signalFile = `reports/2026-10-22-23-0930-earlier-hybrid-signals-${suffix++}.csv`
const columns = ['date','symbol','side','branch','signalAt','entryAt','entryPrice','exitAt','reason','returnPct','maxAdverseExcursionPct','depthSharePct','depthMidMovePct','nifty3DirectionalPct','recentVolumeRatio','ema50Vs200DirectionalPct','priceVsEma50DirectionalPct','move10mDirectionalPct']
fs.writeFileSync(signalFile, `${columns.join(',')}\n${hybridSignals.map(row => columns.map(key => row[key] ?? '').join(',')).join('\n')}\n`, { flag: 'wx' })
console.log(JSON.stringify({ outputFile, signalFile, evaluations }, null, 2))
