#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null }
const root = process.cwd(), symbol = (arg('--symbol') || 'HINDPETRO').replace(/^(NSE:)?|-EQ$/gi, '').toUpperCase()
const date = arg('--date') || '2026-11-05', cutoffText = arg('--time') || '15:30', cutoff = +cutoffText.slice(0, 2) * 60 + +cutoffText.slice(3)
const IST = 330 * 60_000, minute = t => { const s = new Date(t * 1000 + IST).toISOString(); return { date: s.slice(0, 10), n: +s.slice(11, 13) * 60 + +s.slice(14, 16), hm: s.slice(11, 16) } }
const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`), all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(x => ({ ...x, ...minute(x.time) })).sort((a, b) => a.time - b.time)
const dates = [...new Set(all.map(x => x.date))].sort(), di = dates.indexOf(date), previous = di > 0 ? all.filter(x => x.date === dates[di - 1]).slice(-55) : []
const today = all.filter(x => x.date === date && x.n >= 555 && x.n < cutoff), rows = [...previous, ...today], left = 2, right = 2
const highs = new Map(), lows = new Map()
for (let i = left; i < rows.length - right; i++) {
  const window = rows.slice(i - left, i + right + 1), x = rows[i]
  if (window.every((r, j) => j === left || x.high > r.high)) highs.set(i, x.high)
  if (window.every((r, j) => j === left || x.low < r.low)) lows.set(i, x.low)
}
let bias = 'neutral', latestH, latestL, brokenH, brokenL, priorSwingHigh
const events = []
for (let i = 0; i < rows.length; i++) {
  const confirmed = i - right, row = rows[i], isToday = row.date === date
  if (highs.has(confirmed)) {
    const swing = { index: confirmed, price: highs.get(confirmed) }
    if (priorSwingHigh && Math.abs(swing.price / priorSwingHigh.price - 1) <= .001 && isToday) events.push({ time: row.hm, type: 'EQH_SELL', level: +(0.5 * (swing.price + priorSwingHigh.price)).toFixed(3) })
    priorSwingHigh = swing; latestH = swing
  }
  if (lows.has(confirmed)) latestL = { index: confirmed, price: lows.get(confirmed) }
  if (latestH && latestH.index !== brokenH && row.close > latestH.price && (i === 0 || rows[i - 1].close <= latestH.price)) { brokenH = latestH.index; bias = 'bullish' }
  if (latestL && latestL.index !== brokenL && row.close < latestL.price && (i === 0 || rows[i - 1].close >= latestL.price)) {
    const type = bias === 'bullish' ? 'CHOCH_DOWN' : 'BOS_DOWN'; brokenL = latestL.index; bias = 'bearish'
    if (isToday) events.push({ time: row.hm, type, level: +latestL.price.toFixed(3), close: +row.close.toFixed(3) })
  }
}
const counts = { CHOCH_DOWN: 0, BOS_DOWN: 0, EQH_SELL: 0 }; for (const e of events) counts[e.type]++
console.log(`${symbol} | ${date} | completed candles through ${today.at(-1)?.hm || 'none'} IST`)
console.table([{ Stock: symbol, 'CHOCH sell': counts.CHOCH_DOWN, 'BOS sell': counts.BOS_DOWN, 'EQH sell': counts.EQH_SELL, Total: events.length }])
console.table(events)
