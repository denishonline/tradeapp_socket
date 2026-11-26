import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const allScreen = process.argv.includes('--all-screen')
const excludeBelow = Number(process.argv.find(arg => arg.startsWith('--exclude-below='))?.split('=')[1] ?? 0)
if (!Number.isFinite(excludeBelow)) throw new Error('Invalid --exclude-below threshold')
const symbols = allScreen
  ? JSON.parse(fs.readFileSync(path.join(root, 'reports/2026-10-16-0930-all-stocks-five-check-screen.json'), 'utf8')).eligibleSymbols
  : ['CYIENTDLM', 'BOSCHLTD', 'SAMMAANCAP', 'SOLARINDS', 'SONACOMS']
const priorStart = Date.parse('2026-10-15T09:15:00+05:30') / 1000
const priorEnd = Date.parse('2026-10-15T15:30:00+05:30') / 1000
const currentStart = Date.parse('2026-10-16T09:15:00+05:30') / 1000
const currentEnd = Date.parse('2026-10-16T09:30:00+05:30') / 1000
const hhmm = t => new Date(t * 1000 + 330 * 60_000).toISOString().slice(11, 16)
const round = n => Number(n.toFixed(4))

function prices(symbol) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!Number.isFinite(row.time) || !Number.isFinite(row.close) || row.close <= 0 ||
      !((row.time >= priorStart && row.time < priorEnd) || (row.time >= currentStart && row.time < currentEnd))) continue
    if (!unique.has(row.time)) unique.set(row.time, row)
  }
  const rows = [...unique.values()].sort((a, b) => a.time - b.time)
  const prior = rows.filter(row => row.time >= priorStart && row.time < priorEnd).at(-1)
  const current = rows.filter(row => row.time >= currentStart && row.time < currentEnd).at(-1)
  if (!prior || !current) return { symbol, eligible: false, reason: 'missing prior close or 09:29 candle' }
  const movePct = 100 * (current.close / prior.close - 1)
  return { symbol, previousCloseTimeIST: hhmm(prior.time), previousClose: prior.close,
    currentCloseTimeIST: hhmm(current.time), currentClose: current.close,
    moveFromPreviousClosePct: round(movePct), belowZero: movePct < 0,
    eligible: allScreen ? movePct >= excludeBelow : movePct > -0.3 }
}

const results = symbols.map(prices)
const output = { date: '2026-10-16', cutoffIST: '09:30',
  rule: allScreen
    ? `Among the fourteen October 16 09:30 five-check signals, exclude moves < ${excludeBelow}% from October 15 last regular-session close to October 16 09:29 completed one-minute close.`
    : 'October 16 09:29 completed one-minute candle close versus October 15 last regular-session one-minute candle close; pass only if percentage move > -0.3%.',
  source: 'db/candles/<SYMBOL>.jsonl', results,
  belowZeroSymbols: results.filter(row => row.belowZero).map(row => row.symbol),
  excludedSymbols: results.filter(row => !row.eligible).map(row => row.symbol),
  eligibleSymbols: results.filter(row => row.eligible).map(row => row.symbol) }
let n = 1, file
const stem = allScreen
  ? `2026-10-16-0930-fourteen-screen-stocks-prev-close-exclude-below-${String(excludeBelow).replace('-', 'minus').replace('.', 'p')}`
  : '2026-10-16-0930-five-stocks-previous-close-minus0p3-filter'
do { file = path.join(root, 'reports', `${stem}${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, excludedSymbols: output.excludedSymbols, eligibleSymbols: output.eligibleSymbols,
  results: allScreen ? results.filter(row => row.moveFromPreviousClosePct < 0) : results }, null, 2))
