import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2] ?? '2026-11-20'
const stamp = t => new Date(t * 1000 + 19800000).toISOString()
const pct = (to, from) => 100 * (to / from - 1)
const sectors = JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(sectors).flatMap(([key, values]) => key === '_meta' || !Array.isArray(values) ? [] : values))].sort()
const result = []

for (const symbol of symbols) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) continue
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const row = JSON.parse(line), local = stamp(row.time)
      return [{ date: local.slice(0, 10), minute: local.slice(11, 16), open: +row.open, close: +row.close, volume: +row.volume || 0 }]
    } catch { return [] }
  })
  const sessionDates = [...new Set(rows.map(row => row.date))].filter(day => day <= date).sort()
  const feature = day => {
    const bars = rows.filter(row => row.date === day && row.minute >= '09:15' && row.minute <= '09:18')
    return bars.length === 4 ? { date: day, returnPct: pct(bars.at(-1).close, bars[0].open), volume: bars.reduce((sum, row) => sum + row.volume, 0) } : null
  }
  const today = feature(date), prior = sessionDates.filter(day => day < date).slice(-10).map(feature).filter(Boolean)
  if (!today || prior.length < 10) continue
  const priorMax = Math.max(...prior.map(row => row.returnPct))
  if (today.returnPct > priorMax) {
    const priorAverageVolume = prior.reduce((sum, row) => sum + row.volume, 0) / prior.length
    const volumeRank = 1 + prior.filter(row => row.volume > today.volume).length
    result.push({ symbol, returnPct: +today.returnPct.toFixed(3), volume: today.volume, volumeRank, volumeRatio: +(today.volume / priorAverageVolume).toFixed(3), prior10MaxPct: +priorMax.toFixed(3), excessPct: +(today.returnPct - priorMax).toFixed(3) })
  }
}

result.sort((a, b) => b.returnPct - a.returnPct || a.symbol.localeCompare(b.symbol))
const report = { date, windowIST: '09:15–09:18 inclusive', definition: 'Rank 1 means today’s four-candle return is greater than every prior ten same-window return for that stock.', count: result.length, stocks: result }
let suffix = 1, file
do { file = path.join(root, 'reports', `${date}-0915-0918-own-return-rank1${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
console.table(result)
console.log(`Report: ${file}`)
