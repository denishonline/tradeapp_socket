import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), candlesDir = path.join(root, 'db', 'candles')
const defaultSymbols = ['IIFL', 'ADANIENSOL', 'BANDHANBNK', 'MANAPPURAM', 'ADANIGREEN', 'KFINTECH', 'DELHIVERY', 'INOXWIND', 'ABB']
const symbols = process.argv.slice(2).length ? process.argv.slice(2).map(symbol => symbol.toUpperCase().replace(/-EQ$/, '')) : defaultSymbols
const dates = new Set(['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-22'])
const IST = 330 * 60_000
const stamp = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const minute = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
const round = (value, digits = 2) => Number.isFinite(value) ? +value.toFixed(digits) : null

function bars15(symbol) {
  const file = path.join(candlesDir, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const bars = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line), time = stamp(row.time), day = time.slice(0, 10), minuteOfDay = minute(time.slice(11))
      if (!dates.has(day) || minuteOfDay < 555 || minuteOfDay >= 930 || ![row.open, row.high, row.low, row.close, row.volume].every(value => Number.isFinite(+value))) continue
      const block = Math.floor((minuteOfDay - 555) / 15), key = `${day}|${block}`
      const existing = bars.get(key)
      if (!existing) bars.set(key, { day, block, candles: 1, open: +row.open, close: +row.close, volume: +row.volume })
      else { existing.candles += 1; existing.close = +row.close; existing.volume += +row.volume }
    } catch { /* ignore malformed row */ }
  }
  return [...bars.values()].filter(bar => bar.candles === 15)
}

const rows = symbols.map(stock => {
  const bars = bars15(stock), bullish = bars.filter(bar => bar.close > bar.open), bearish = bars.filter(bar => bar.close < bar.open), doji = bars.filter(bar => bar.close === bar.open)
  const bullishVolume = bullish.reduce((sum, bar) => sum + bar.volume, 0), bearishVolume = bearish.reduce((sum, bar) => sum + bar.volume, 0), totalDirectionalVolume = bullishVolume + bearishVolume
  return { stock, bars: bars.length, bullishCandles: bullish.length, bearishCandles: bearish.length, dojiCandles: doji.length, bullishVolume: Math.round(bullishVolume), bearishVolume: Math.round(bearishVolume), bullishVolumeSharePct: round(100 * bullishVolume / (totalDirectionalVolume || 1)), bearishVolumeSharePct: round(100 * bearishVolume / (totalDirectionalVolume || 1)), averageBullishVolume: Math.round(bullishVolume / (bullish.length || 1)), averageBearishVolume: Math.round(bearishVolume / (bearish.length || 1)) }
})
let output = path.join(root, 'reports', '2026-10-15-to-22-15m-bullish-bearish-volume.csv'), suffix = 2
while (fs.existsSync(output)) output = path.join(root, 'reports', `2026-10-15-to-22-15m-bullish-bearish-volume-${suffix++}.csv`)
const fields = Object.keys(rows[0])
fs.writeFileSync(output, `${fields.join(',')}\n${rows.map(row => fields.map(field => row[field]).join(',')).join('\n')}\n`)
console.log('STOCK       BULL  BEAR  DOJI  BULL_VOL_SHARE  BEAR_VOL_SHARE')
for (const row of rows) console.log(`${row.stock.padEnd(12)} ${String(row.bullishCandles).padStart(4)}  ${String(row.bearishCandles).padStart(4)}  ${String(row.dojiCandles).padStart(4)}  ${String(row.bullishVolumeSharePct).padStart(13)}%  ${String(row.bearishVolumeSharePct).padStart(13)}%`)
