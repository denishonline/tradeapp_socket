import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const CANDLES = path.join(ROOT, 'db', 'candles')
const REPORTS = path.join(ROOT, 'reports')
const IST = 330 * 60_000
const targetDate = '2026-10-23'
const signals = [
  ['BUY', 'TECHM', '09:25'],
  ['SELL', 'ADANIENSOL', '09:15'],
  ['SELL', 'MUTHOOTFIN', '09:16'],
  ['SELL', 'SAMMAANCAP', '09:16'],
  ['SELL', 'SIEMENS', '09:18'],
  ['SELL', 'ABB', '09:20'],
  ['SELL', 'KEI', '09:20'],
  ['SELL', 'BANDHANBNK', '09:23'],
  ['SELL', 'CONCOR', '09:23'],
  ['SELL', 'AMBUJACEM', '09:24'],
  ['SELL', 'IRFC', '09:24'],
  ['SELL', 'LTF', '09:24'],
  ['SELL', 'MANAPPURAM', '09:24'],
  ['SELL', 'DELHIVERY', '09:28'],
  ['SELL', 'MOTHERSON', '09:28'],
]

const dateOf = seconds => new Date(seconds * 1000 + IST).toISOString().slice(0, 10)
const timeOf = seconds => new Date(seconds * 1000 + IST).toISOString().slice(11, 16)
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function cumulativeVolume(rows, date, cutoffTime) {
  const eligible = rows.filter(row => dateOf(row.time) === date && timeOf(row.time) >= '09:15' && timeOf(row.time) <= cutoffTime)
  return eligible.length ? eligible.reduce((sum, row) => sum + Number(row.volume || 0), 0) : null
}

const results = signals.map(([side, stock, signalTime]) => {
  const file = path.join(CANDLES, `${stock}.jsonl`)
  if (!fs.existsSync(file)) return { side, stock, signalTime, error: 'candle file missing' }
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).sort((a, b) => a.time - b.time)
  const sessions = [...new Set(rows.map(row => dateOf(row.time)))].filter(date => date < targetDate).slice(-5)
  const todayVolume = cumulativeVolume(rows, targetDate, signalTime)
  const priorVolumes = sessions.map(date => ({ date, volume: cumulativeVolume(rows, date, signalTime) }))
  if (sessions.length !== 5 || todayVolume == null || priorVolumes.some(item => item.volume == null)) {
    return { side, stock, signalTime, error: `insufficient comparable sessions (${sessions.length}/5)` }
  }
  const comparison = [{ date: targetDate, volume: todayVolume }, ...priorVolumes]
  const rank = 1 + comparison.filter(item => item.volume > todayVolume).length
  const priorAverage = priorVolumes.reduce((sum, item) => sum + item.volume, 0) / priorVolumes.length
  return {
    side,
    stock,
    signalTime,
    targetVolume: todayVolume,
    rank: `${rank}/6`,
    rankNumber: rank,
    prior5AverageVolume: round(priorAverage, 0),
    vsPrior5AveragePct: round(100 * (todayVolume / priorAverage - 1)),
    sessions,
    priorVolumes,
  }
})

const header = ['date', 'side', 'stock', 'signal_time_ist', 'cumulative_volume_0915_to_signal', 'volume_rank_among_today_plus_prior5', 'prior5_average_volume', 'vs_prior5_average_pct', 'prior_session_dates', 'prior_session_cumulative_volumes', 'error']
const csvRows = [header.join(','), ...results.map(row => [
  targetDate, row.side, row.stock, row.signalTime, row.targetVolume ?? '', row.rank ?? '', row.prior5AverageVolume ?? '', row.vsPrior5AveragePct ?? '',
  row.sessions?.join('|') ?? '', row.priorVolumes?.map(item => item.volume).join('|') ?? '', row.error ?? '',
].join(','))]
let output = path.join(REPORTS, `${targetDate}-signal-volume-ranks-vs-prior-5-sessions.csv`)
let attempt = 2
while (fs.existsSync(output)) output = path.join(REPORTS, `${targetDate}-signal-volume-ranks-vs-prior-5-sessions-${attempt++}.csv`)
fs.writeFileSync(output, `${csvRows.join('\n')}\n`)

for (const row of results) {
  if (row.error) console.log(`${row.side.padEnd(4)} ${row.stock.padEnd(12)} ${row.signalTime}  ${row.error}`)
  else console.log(`${row.side.padEnd(4)} ${row.stock.padEnd(12)} ${row.signalTime}  rank ${row.rank}  volume ${row.targetVolume.toLocaleString('en-IN')}  vs avg ${row.vsPrior5AveragePct > 0 ? '+' : ''}${row.vsPrior5AveragePct}%`)
}
console.log(`Report: ${output}`)
