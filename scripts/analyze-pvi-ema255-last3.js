import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), symbol = (process.argv[2] || 'INFY').replace(/^(NSE:)?|-EQ$/gi, '').toUpperCase(), IST = 330 * 60_000
const local = t => { const s = new Date(t * 1000 + IST).toISOString(); return { date: s.slice(0, 10), hm: s.slice(11, 16) } }
const rows = fs.readFileSync(path.join(root, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(x => ({ ...x, ...local(x.time) })).sort((a, b) => a.time - b.time)
const dates = [...new Set(rows.map(x => x.date))].sort().slice(-3), alpha = 2 / 256
let pvi = 1000, ema = 1000, previousVolume = null, previousClose = null, previousEma = null
const stats = Object.fromEntries(dates.map(d => [d, { date: d, candles: 0, up: 0, down: 0, flat: 0, first: null, last: null }]))
for (const row of rows) {
  if (previousVolume !== null && row.volume > previousVolume) pvi *= row.close / previousClose
  ema = alpha * pvi + (1 - alpha) * ema
  if (stats[row.date]) {
    const s = stats[row.date]; s.candles++
    if (previousEma !== null) { const direction = ema > previousEma ? 'up' : ema < previousEma ? 'down' : 'flat'; if (s.candles === 0) s.firstComparison = direction; if (direction === 'up') s.up++; else if (direction === 'down') s.down++; else s.flat++ }
    if (!s.first) s.first = { time: row.hm, ema255: +ema.toFixed(6) }
    s.last = { time: row.hm, ema255: +ema.toFixed(6) }
  }
  previousVolume = row.volume; previousClose = row.close; previousEma = ema
}
console.log(`${symbol} | PVI EMA255 candle-to-candle direction | last 3 sessions`)
console.table(Object.values(stats).map(s => ({ ...s, withinSessionUp: s.up - (s.firstComparison === 'up' ? 1 : 0), withinSessionDown: s.down - (s.firstComparison === 'down' ? 1 : 0) })))
const total = Object.values(stats).reduce((a, s) => ({ candles: a.candles + s.candles, up: a.up + s.up, down: a.down + s.down, flat: a.flat + s.flat }), { candles: 0, up: 0, down: 0, flat: 0 })
console.log('Combined:', total)
