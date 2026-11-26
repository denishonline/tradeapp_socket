import fs from 'node:fs'
import path from 'node:path'

// Opening continuation screen, frozen from the October 19 research.  It only
// uses candles through 09:29; --cutoff controls whether that completed signal
// is available in the returned result.
const root = process.cwd()
const args = process.argv.slice(2)
const date = args[0]
const cutoffFlag = args.indexOf('--cutoff')
const positionalCutoff = args[1] && /^\d{2}:\d{2}$/.test(args[1]) ? args[1] : null
const cutoff = cutoffFlag >= 0 ? args[cutoffFlag + 1] : (positionalCutoff ?? '09:30')
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(cutoff)) {
  throw new Error('Usage: node scripts/screen-opening-zero-stop-filter.js YYYY-MM-DD [HH:MM | --cutoff HH:MM]')
}
if (cutoff < '09:29') throw new Error('The opening signal is completed at 09:29. Use a cutoff of 09:29 or later.')

const allowedDates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
const dateIndex = allowedDates.indexOf(date)
if (dateIndex < 4) throw new Error(`Need four prior scoped sessions for ${date}`)
const priorDates = allowedDates.slice(dateIndex - 4, dateIndex)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8'))
  .map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]
const round = (value, places = 4) => Number.isFinite(value) ? Number(value.toFixed(places)) : null
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
const localStamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const sumVolume = rows => rows.reduce((sum, row) => sum + row.volume, 0)
const pct = (newValue, oldValue) => 100 * (newValue / oldValue - 1)

function readSessions(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const wanted = new Set([...priorDates, date]), unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw; try { raw = JSON.parse(line) } catch { continue }
    const stamp = localStamp(+raw.time), rowDate = stamp.slice(0, 10), minute = stamp.slice(11)
    if (!wanted.has(rowDate) || minute < '09:15' || minute > '15:29') continue
    if (![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => Number.isFinite(+value))) continue
    unique.set(stamp, { stamp, date: rowDate, minute, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  const rows = [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
  const byDate = Object.fromEntries([...wanted].map(day => [day, rows.filter(row => row.date === day)]))
  // Only the first 15 minutes are required.  This keeps the live scanner usable
  // before market close while retaining exact same-time volume comparison.
  return [...priorDates, date].every(day => byDate[day].filter(row => row.minute <= '09:29').length === 15) ? byDate : null
}

function vwap(rows) {
  const volume = sumVolume(rows)
  return rows.reduce((sum, row) => sum + ((row.high + row.low + row.close) / 3) * row.volume, 0) / volume
}

function screen(symbol) {
  const byDate = readSessions(symbol)
  if (!byDate) return null
  const opening = byDate[date].filter(row => row.minute <= '09:29')
  const previousOpeningVolumes = priorDates.map(day => sumVolume(byDate[day].filter(row => row.minute <= '09:29')))
  const openingReturnPct = pct(opening.at(-1).close, opening[0].open)
  const side = openingReturnPct >= 0 ? 'BUY' : 'SELL'
  const direction = side === 'BUY' ? 1 : -1
  const openingVwap = vwap(opening), firstTenVwap = vwap(opening.slice(0, 10))
  const thirdFive = opening.slice(10, 15)
  const third5ReturnDirectionalPct = direction * pct(thirdFive.at(-1).close, thirdFive[0].open)
  const relativeVolume = sumVolume(opening) / mean(previousOpeningVolumes)
  const vwapGapDirectionalPct = direction * pct(opening.at(-1).close, openingVwap)
  const vwapSlopeDirectionalPct = direction * pct(openingVwap, firstTenVwap)
  const absoluteMove = Math.abs(openingReturnPct)
  const passed = absoluteMove >= 0.75 && absoluteMove <= 2.1724 && relativeVolume >= 1 && vwapGapDirectionalPct > 0 && vwapSlopeDirectionalPct > 0 && third5ReturnDirectionalPct <= 0.287448
  return {
    symbol, side, signalTime: `${date} 09:29`, cutoff: `${date} ${cutoff}`,
    openingMovePct: round(openingReturnPct), openingMoveAbsPct: round(absoluteMove),
    volumeThrough0929: sumVolume(opening), priorFourAverageVolumeThrough0929: round(mean(previousOpeningVolumes), 2), relativeVolume: round(relativeVolume),
    vwap: round(openingVwap, 4), vwapGapDirectionalPct: round(vwapGapDirectionalPct), vwapSlopeDirectionalPct: round(vwapSlopeDirectionalPct),
    third5ReturnDirectionalPct: round(third5ReturnDirectionalPct),
    proposedEntry: round(opening.at(-1).close, 4), execution: 'Enter on the next completed one-minute candle after this signal.',
    stopPct: 0.75, targetPct: 1.5, passed
  }
}

const scanned = [], missing = []
process.stdout.write(`Loading ${symbols.length} stocks using prior sessions ${priorDates.join(', ')}: `)
for (const [index, symbol] of symbols.entries()) {
  const row = screen(symbol)
  if (row) scanned.push(row); else missing.push(symbol)
  const completed = index + 1
  if (completed % 5 === 0 || completed === symbols.length) process.stdout.write('.')
}
process.stdout.write('\n')
const signals = scanned.filter(row => row.passed).sort((a, b) => b.openingMoveAbsPct - a.openingMoveAbsPct || a.symbol.localeCompare(b.symbol))
const report = {
  strategy: 'Opening continuation zero-stop research filter',
  warning: 'Thresholds were fitted on October 19 outcomes. This scanner is a causal signal screen, not evidence that future trades have zero stops.',
  scope: { date, cutoff, priorDates, symbolsRequested: symbols.length, symbolsScanned: scanned.length, symbolsMissingOpeningData: missing },
  timing: 'All predicates use the completed 09:15 through 09:29 candles. The scanner never reads later candles. Enter on the next completed candle.',
  rules: [
    'Absolute move from 09:15 open to 09:29 close: 0.75% to 2.1724%.',
    'Cumulative volume through 09:29 is at least the same-time mean of the prior four sessions.',
    'BUY closes above a rising session VWAP; SELL closes below a falling session VWAP.',
    'Directional return in 09:25 through 09:29 is at most +0.287448%, allowing a controlled pullback or consolidation.',
    'Proposed stop: 0.75%. Proposed target: 1.5%.'
  ],
  signalCount: signals.length,
  signals
}
let suffix = 1, output
do { output = path.join(root, 'reports', `${date}-${cutoff.replace(':', '')}-opening-zero-stop-screen${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(`Scanned: ${scanned.length}/${symbols.length}; missing opening data: ${missing.length}; signals: ${signals.length}`)
for (const signal of signals) console.log(`${signal.symbol}\t${signal.signalTime}`)
console.log(`Report: ${output}`)
