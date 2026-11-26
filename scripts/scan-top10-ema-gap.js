#!/usr/bin/env node
/**
 * Rank stocks by the largest combined EMA gap at a historical cutoff.
 *
 * Usage:
 *   node scripts/scan-top10-ema-gap.js --cutoff "2026-10-16 12:00"
 *   node scripts/scan-top10-ema-gap.js --cutoff "2026-10-16 12:00" --side BUY
 *   node scripts/scan-top10-ema-gap.js --cutoff "2026-10-16 12:00" --top 20
 *
 * Every EMA and price used here is calculated only from candles completed by
 * the cutoff. The first 200 valid candles are used as the EMA warm-up; the
 * ranking begins once EMA200 has a full 200-candle history. TOTAL GAP% is the
 * signed sum of EMA10/EMA20, EMA50/EMA200, and close/EMA200 percentage gaps.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const CANDLES = path.join(ROOT, 'db', 'candles')
const REPORTS = path.join(ROOT, 'reports')
const IST = 330 * 60_000
const args = process.argv.slice(2)
const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] }
const cutoffText = value('--cutoff')
const sideFilter = (value('--side') ?? 'BOTH').toUpperCase()
const topN = Number(value('--top') ?? 10)
if (!cutoffText || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(cutoffText) || !['BUY', 'SELL', 'BOTH'].includes(sideFilter) || !Number.isInteger(topN) || topN < 1) {
  throw new Error('Usage: node scripts/scan-top10-ema-gap.js --cutoff "YYYY-MM-DD HH:MM" [--side BUY|SELL|BOTH] [--top 10]')
}
const cutoffMs = Date.parse(`${cutoffText.replace(' ', 'T')}:00+05:30`)
if (!Number.isFinite(cutoffMs)) throw new Error('Invalid cutoff date/time.')
const stamp = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const timeOf = seconds => stamp(seconds).slice(11)
const dateOf = seconds => stamp(seconds).slice(0, 10)
const round = (number, digits = 4) => Number.isFinite(number) ? Number(number.toFixed(digits)) : null
const pct = (value, base) => 100 * (value / base - 1)

function ema(previous, close, period) {
  return previous == null ? close : previous + 2 / (period + 1) * (close - previous)
}

function scanFile(file) {
  const symbol = path.basename(file, '.jsonl')
  if (symbol === 'NIFTY50') return null
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line), time = Number(row.time)
      const localTime = timeOf(time)
      if (!Number.isInteger(time) || time * 1000 + 60_000 > cutoffMs || localTime < '09:15' || localTime >= '15:30') continue
      if (![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) || Number(row.close) <= 0) continue
      rows.push({ time, close: Number(row.close), volume: Number(row.volume) || 0 })
    } catch { /* ignore malformed candle lines */ }
  }
  rows.sort((a, b) => a.time - b.time)
  if (rows.length < 200) return null
  let ema10 = null, ema20 = null, ema50 = null, ema200 = null
  let latest = null
  for (const row of rows) {
    ema10 = ema(ema10, row.close, 10)
    ema20 = ema(ema20, row.close, 20)
    ema50 = ema(ema50, row.close, 50)
    ema200 = ema(ema200, row.close, 200)
    latest = { ...row, ema10, ema20, ema50, ema200 }
  }
  const emaGapPct = pct(latest.ema10, latest.ema20)
  const ema50GapPct = pct(latest.ema50, latest.ema200)
  const priceGapPct = pct(latest.close, latest.ema200)
  const bullish = emaGapPct > 0 && ema50GapPct > 0 && priceGapPct > 0
  const bearish = emaGapPct < 0 && ema50GapPct < 0 && priceGapPct < 0
  const side = bullish ? 'BUY' : bearish ? 'SELL' : null
  if (!side || (sideFilter !== 'BOTH' && side !== sideFilter)) return null
  const sessions = new Map()
  for (const row of rows) {
    const date = dateOf(row.time)
    sessions.set(date, (sessions.get(date) ?? 0) + row.volume)
  }
  const priorDates = [...sessions.keys()].filter(date => date < dateOf(latest.time)).sort().slice(-2)
  const priorAverageVolume = priorDates.length === 2 ? (sessions.get(priorDates[0]) + sessions.get(priorDates[1])) / 2 : null
  const currentVolume = sessions.get(dateOf(latest.time)) ?? 0
  const volumeVsPrior2DayAveragePct = priorAverageVolume > 0 ? pct(currentVolume, priorAverageVolume) : null
  return { stock: symbol, date: dateOf(latest.time), time: timeOf(latest.time), side,
    gapPct: round(emaGapPct), absoluteGapPct: round(Math.abs(emaGapPct)),
    ema50VsEma200Pct: round(ema50GapPct), priceVsEma200Pct: round(priceGapPct),
    totalGapPct: round(emaGapPct + ema50GapPct + priceGapPct), volumeVsPrior2DayAveragePct: round(volumeVsPrior2DayAveragePct),
    price: round(latest.close, 2), ema10: round(latest.ema10, 2), ema20: round(latest.ema20, 2),
    ema50: round(latest.ema50, 2), ema200: round(latest.ema200, 2), candles: rows.length }
}

const files = fs.readdirSync(CANDLES).filter(file => file.endsWith('.jsonl'))
const candidates = files.map(file => scanFile(path.join(CANDLES, file))).filter(Boolean)
const ranked = side => candidates.filter(result => result.side === side)
  .sort((a, b) => Math.abs(b.totalGapPct) - Math.abs(a.totalGapPct) || a.stock.localeCompare(b.stock)).slice(0, topN)
const buyResults = sideFilter === 'SELL' ? [] : ranked('BUY')
const sellResults = sideFilter === 'BUY' ? [] : ranked('SELL')
const results = [...buyResults.map((result, index) => ({ ...result, rank: index + 1 })), ...sellResults.map((result, index) => ({ ...result, rank: index + 1 }))]

const columns = [
  ['RANK', 4], ['STOCK', 16], ['TIME', 16], ['SIDE', 4], ['EMA GAP%', 10],
  ['EMA50/200%', 12], ['EMA200 GAP%', 13], ['TOTAL GAP%', 11], ['VOL VS 2D AVG%', 14]
]
const border = `+${columns.map(([, width]) => '-'.repeat(width + 2)).join('+')}+`
const row = values => `|${columns.map(([key, width]) => ` ${String(values[key] ?? '').slice(0, width).padEnd(width)} `).join('|')}|`
const printTable = (title, rows) => {
  console.log(`\n${title}`)
  console.log(border)
  console.log(row({ RANK: 'RANK', STOCK: 'STOCK', TIME: 'TIME', SIDE: 'SIDE', 'EMA GAP%': 'EMA GAP%', 'EMA50/200%': 'EMA50/200%', 'EMA200 GAP%': 'EMA200 GAP%', 'TOTAL GAP%': 'TOTAL GAP%', 'VOL VS 2D AVG%': 'VOL VS 2D AVG%' }))
  console.log(border)
  rows.forEach((result, index) => console.log(row({ RANK: index + 1, STOCK: result.stock, TIME: `${result.date} ${result.time}`, SIDE: result.side, 'EMA GAP%': result.gapPct, 'EMA50/200%': result.ema50VsEma200Pct, 'EMA200 GAP%': result.priceVsEma200Pct, 'TOTAL GAP%': result.totalGapPct, 'VOL VS 2D AVG%': result.volumeVsPrior2DayAveragePct })))
  console.log(border)
  const totalGap = rows.reduce((sum, result) => sum + result.totalGapPct, 0)
  const totalAbsoluteGap = rows.reduce((sum, result) => sum + Math.abs(result.totalGapPct), 0)
  console.log(`Total gap: ${round(totalGap)}% | Total absolute gap: ${round(totalAbsoluteGap)}%`)
}
if (buyResults.length || sideFilter === 'BOTH') printTable('BUY — EMA10 > EMA20, EMA50 > EMA200, PRICE > EMA200', buyResults)
if (sellResults.length || sideFilter === 'BOTH') printTable('SELL — EMA10 < EMA20, EMA50 < EMA200, PRICE < EMA200', sellResults)
console.log(`Cutoff ${cutoffText} IST | side ${sideFilter} | BUY ${buyResults.length} | SELL ${sellResults.length} | ranked by absolute total gap`)

fs.mkdirSync(REPORTS, { recursive: true })
const safeCutoff = cutoffText.replace(/[ :]/g, '-')
let output = path.join(REPORTS, `top${topN}-ema10-20-gap-${sideFilter.toLowerCase()}-${safeCutoff}.csv`), attempt = 2
while (fs.existsSync(output)) output = path.join(REPORTS, `top${topN}-ema10-20-gap-${sideFilter.toLowerCase()}-${safeCutoff}-${attempt++}.csv`)
const header = ['rank', 'stock', 'date', 'time', 'side', 'ema10_ema20_gap_pct', 'absolute_gap_pct', 'ema50_ema200_gap_pct', 'price_ema200_gap_pct', 'total_gap_pct', 'volume_vs_prior_2_session_average_pct', 'ema10', 'ema20', 'ema50', 'ema200', 'candles']
const csvValue = value => value == null ? '' : String(value)
const csvRows = [header.join(','), ...results.map(result => [result.rank, result.stock, result.date, result.time, result.side, result.gapPct, result.absoluteGapPct, result.ema50VsEma200Pct, result.priceVsEma200Pct, result.totalGapPct, result.volumeVsPrior2DayAveragePct, result.ema10, result.ema20, result.ema50, result.ema200, result.candles].map(csvValue).join(','))]
fs.writeFileSync(output, `${csvRows.join('\n')}\n`, { flag: 'wx' })
console.error(`Saved ${output}`)
