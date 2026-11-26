import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const input = path.join(root, 'reports/2026-10-16-0930-twelve-stock-opening-candle-shape.json')
const rows = JSON.parse(fs.readFileSync(input, 'utf8')).rows
const excluded = rows.filter(row => row.top2PositiveStepSharePct > 48.5 && row.largestBodyPct < 0.65)
const retained = rows.filter(row => !excluded.includes(row))
const output = {
  date: '2026-10-16', cutoffIST: '09:30',
  input: 'The twelve stocks remaining after the five-check screen and previous-close >= -0.4% filter.',
  rule: 'Exclude a stock when its two largest positive one-minute moves account for more than 48.5% of all positive one-minute moves from 09:15 through 09:29, AND its largest absolute one-minute open-to-close body is below 0.65%. The 09:15 move is close versus its own open; later moves are close versus the prior candle close.',
  caveat: 'Thresholds are fitted to the October 16 shortlist to remove the named stocks while retaining the other ten. This is same-day descriptive pattern fitting, not validated predictive filtering.',
  source: 'db/candles/<SYMBOL>.jsonl',
  excludedSymbols: excluded.map(row => row.symbol), retainedSymbols: retained.map(row => row.symbol),
  rows: rows.map(row => ({ symbol: row.symbol, top2PositiveStepSharePct: row.top2PositiveStepSharePct,
    largestBodyPct: row.largestBodyPct, excluded: excluded.includes(row) }))
}
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-16-0930-twelve-stock-concentrated-candle-filter${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, excludedSymbols: output.excludedSymbols, retainedSymbols: output.retainedSymbols, rows: output.rows }, null, 2))
