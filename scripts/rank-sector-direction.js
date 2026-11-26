import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2] ?? '2026-10-19', cutoff = process.argv[3] ?? '15:30', neutralBandPct = Number(process.argv[4] ?? 0.15), showAll = process.argv.includes('--all')
if (!/^\d{2}:\d{2}$/.test(cutoff)) throw new Error('Usage: node scripts/rank-sector-direction.js YYYY-MM-DD [HH:MM] [neutral-band-pct]')
const sectors = JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks_sector_wise'), 'utf8'))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString()
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null }
const round = value => Number(value.toFixed(3))
const results = []
for (const [sector, symbols] of Object.entries(sectors)) {
  if (sector === '_meta') continue
  const stocks = []
  for (const symbol of symbols) {
    const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
    if (!fs.existsSync(file)) continue
    const unique = new Map()
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      let row; try { row = JSON.parse(line) } catch { continue }
      const iso = stamp(+row.time), day = iso.slice(0, 10), time = iso.slice(11, 16)
      // Cutoff is exclusive: a 09:30 cutoff sees the completed 09:29 candle.
      if (day === date && time >= '09:15' && time < cutoff) unique.set(+row.time, row)
    }
    const rows = [...unique.values()].sort((a, b) => a.time - b.time)
    if (!rows.length || !(+rows[0].open > 0)) continue
    stocks.push({ symbol, returnPct: round(100 * (+rows.at(-1).close / +rows[0].open - 1)) })
  }
  const up = stocks.filter(row => row.returnPct > neutralBandPct), down = stocks.filter(row => row.returnPct < -neutralBandPct)
  const direction = up.length >= down.length ? 'UP' : 'DOWN', directional = direction === 'UP' ? up : down
  results.push({ sector, stockCount: stocks.length, upStocks: up.length, downStocks: down.length, neutralStocks: stocks.length - up.length - down.length, direction, directionalStocks: directional.length, directionalSharePct: round(100 * directional.length / stocks.length), medianReturnPct: round(median(stocks.map(row => row.returnPct))), meanReturnPct: round(stocks.reduce((sum, row) => sum + row.returnPct, 0) / stocks.length), leaders: directional.sort((a, b) => direction === 'UP' ? b.returnPct - a.returnPct : a.returnPct - b.returnPct).slice(0, 5) })
}
const eligible = results.filter(row => row.stockCount >= 5).sort((a, b) => b.directionalSharePct - a.directionalSharePct || Math.abs(b.medianReturnPct) - Math.abs(a.medianReturnPct) || b.directionalStocks - a.directionalStocks)
const allSectors = results.sort((a, b) => a.sector.localeCompare(b.sector))
const report = { date, cutoff, method: `Return: 09:15 open to the last completed candle before ${cutoff}. Stocks above +${neutralBandPct}% are up; below -${neutralBandPct}% are down; the remainder is neutral. Sectors with fewer than five stocks are excluded from top-three ranking.`, topThree: eligible.slice(0, 3), allSectors }
const tableRows = (showAll ? allSectors : report.topThree).map(row => ({ sector: row.sector, direction: row.direction, up: row.upStocks, down: row.downStocks, neutral: row.neutralStocks, directional: `${row.directionalStocks}/${row.stockCount}`, directionalSharePct: row.directionalSharePct, medianReturnPct: row.medianReturnPct, meanReturnPct: row.meanReturnPct }))
console.table(tableRows)
for (const row of report.topThree) console.log(`${row.sector}: ${row.leaders.map(stock => `${stock.symbol} ${stock.returnPct > 0 ? '+' : ''}${stock.returnPct}%`).join(', ')}`)
let n = 1, output
do { output = path.join(root, 'reports', `${date}-${cutoff.replace(':', '')}-sector-direction-rank${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(`Report: ${output}`)
