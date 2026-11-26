import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-11-20'
const targets = new Set(['INDUSINDBK', 'APOLLOHOSP', 'UNIONBANK', 'AXISBANK', 'PERSISTENT', 'BAJFINANCE', 'INDHOTEL'])
const minute = 60_000
const start = Date.parse(`${date}T09:15:00+05:30`)
const end = Date.parse(`${date}T09:18:00+05:30`)
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const pct = (to, from) => from ? 100 * (to / from - 1) : null
const local = at => new Date(at + 330 * minute).toISOString().slice(0, 16).replace('T', ' ')

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

const sectors = JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks_sector_wise'), 'utf8'))
const universe = [...new Set(Object.entries(sectors).flatMap(([key, values]) => key === '_meta' || !Array.isArray(values) ? [] : values))].sort()
const depthReportFile = path.join(root, 'reports', '2026-11-20-0915-0917-bullish-depth-behaviors-2.json')
const depthBySymbol = new Map(JSON.parse(fs.readFileSync(depthReportFile, 'utf8')).stocks.map(row => [row.symbol, row]))

function candleScore(symbol) {
  let ema10, ema20
  const bars = []
  for (const row of readJsonl(path.join(root, 'db', 'candles', `${symbol}.jsonl`))) {
    const at = Number(row.time) * 1000, close = +row.close
    if (!Number.isFinite(at) || !Number.isFinite(close) || at >= end) continue
    ema10 = ema10 == null ? close : ema10 + 2 / 11 * (close - ema10)
    ema20 = ema20 == null ? close : ema20 + 2 / 21 * (close - ema20)
    if (at >= start) bars.push({ at, open: +row.open, high: +row.high, low: +row.low, close, volume: +row.volume || 0, ema10, ema20 })
  }
  if (bars.length !== 3) return null
  let pv = 0, volume = 0
  for (const bar of bars) { pv += ((bar.high + bar.low + bar.close) / 3) * bar.volume; volume += bar.volume }
  const first = bars[0], last = bars.at(-1), high = Math.max(...bars.map(x => x.high)), low = Math.min(...bars.map(x => x.low))
  const openingReturn = pct(last.close, first.open), recentReturn = pct(last.close, first.open)
  const checks = {
    positiveOpeningReturn: openingReturn > 0,
    openingMoveAtLeast0p25: openingReturn >= 0.25,
    ema10AboveEma20: last.ema10 > last.ema20,
    emaGapExpanding: (last.ema10 - last.ema20) > (bars[1].ema10 - bars[1].ema20),
    closeAboveVwap: last.close > pv / volume,
    closeInUpperRange: 100 * (last.close - low) / (high - low || 1) >= 70,
    twoGreenCandles: bars.filter(x => x.close > x.open).length >= 2,
    threeCandleMomentum: recentReturn >= 0.15,
    higherCloses: bars[1].close > bars[0].close && bars[2].close > bars[1].close,
    higherLows: bars[1].low >= bars[0].low && bars[2].low >= bars[1].low
  }
  return { count: Object.values(checks).filter(Boolean).length, checks, metrics: {
    openingReturnPct: round(openingReturn), emaGapBps: round(10_000 * (last.ema10 - last.ema20) / last.close),
    closeVsVwapPct: round(pct(last.close, pv / volume)), closeLocationPct: round(100 * (last.close - low) / (high - low || 1)),
    greenCandles: bars.filter(x => x.close > x.open).length
  } }
}

const rows = universe.map(symbol => {
  const candle = candleScore(symbol), depth = depthBySymbol.get(symbol)
  if (!candle || !depth || depth.status !== 'OK') return { symbol, status: 'INCOMPLETE_DATA' }
  return { symbol, status: 'OK', candleScore: candle.count, depthScore: depth.count, totalScore: candle.count + depth.count,
    candle, depth: { checks: depth.checks, metrics: depth.metrics } }
}).filter(row => row.status === 'OK').sort((a, b) => b.totalScore - a.totalScore || b.depthScore - a.depthScore || b.candleScore - a.candleScore || a.symbol.localeCompare(b.symbol))
for (const row of rows) row.rank = rows.findIndex(other => other === row) + 1
const top10 = rows.slice(0, 10)
const targetRows = [...targets].map(symbol => rows.find(row => row.symbol === symbol) ?? { symbol, status: 'INCOMPLETE_DATA' }).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
const report = {
  date, windowIST: '09:15:00 inclusive to 09:18:00 exclusive; three completed 1-minute candles and same-window depth snapshots only.',
  methodology: {
    candleScore: '10 one-point checks: positive + >=0.25% opening return, EMA10 > EMA20, expanding EMA gap, close > VWAP, upper-30% range close, >=2 green candles, >=0.15% three-candle momentum, consecutive higher closes, consecutive non-lower lows.',
    depthScore: 'The 10 displayed order-book behaviors from the 09:15-09:17 depth audit.',
    total: 'Candle score + depth behavior score, maximum 20. No later candle, depth, or EOD result is used in ranking.'
  },
  top10, targetRows, allRows: rows
}
let suffix = 1, file
do { file = path.join(root, 'reports', `2026-11-20-0915-0917-combined-candle-depth-rank${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
const show = row => ({ Rank: row.rank ?? '-', Stock: row.symbol, Candle: row.candleScore ?? '-', Depth: row.depthScore ?? '-', 'Total / 20': row.totalScore ?? '-', 'Open %': row.candle?.metrics.openingReturnPct ?? '-', 'Depth mid %': row.depth?.metrics.midpointMovePct ?? '-' })
console.log('Top 10')
console.table(top10.map(show))
console.log('Requested stocks')
console.table(targetRows.map(show))
console.log(`Report: ${file}`)
