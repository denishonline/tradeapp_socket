import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const input = process.argv[2] ?? 'reports/2026-10-22-23-0930-high-precision-rule.json'
const source = JSON.parse(fs.readFileSync(input, 'utf8'))
const ist = t => new Date(t * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = t => ist(t).slice(0, 10)
const minuteOf = t => ist(t).slice(11)
const pct = (a, b) => b ? 100 * (a / b - 1) : null
const round = x => Number.isFinite(x) ? Number(x.toFixed(4)) : null
const readRows = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})
const ema = (rows, period) => {
  let value = null
  const alpha = 2 / (period + 1)
  for (const row of rows) value = value == null ? row.close : value + alpha * (row.close - value)
  return value
}
const directional = (side, value) => side === 'BUY' ? value : -value
const cache = new Map()
function history(symbol) {
  if (!cache.has(symbol)) cache.set(symbol, readRows(path.join(root, 'db', 'candles', `${symbol}.jsonl`))
    .filter(r => [r.open, r.high, r.low, r.close, r.volume, r.time].every(Number.isFinite) && dateOf(r.time) >= '2026-10-19' && dateOf(r.time) <= '2026-10-23')
    .sort((a, b) => a.time - b.time))
  return cache.get(symbol)
}

const inputRows = source.signals ?? source.candidates ?? source.profiles?.flatMap(profile => profile.signals) ?? []
const enriched = inputRows.map(signal => {
  const signalEpoch = Date.parse(`${signal.signalAt.replace(' ', 'T')}:00+05:30`) / 1000
  const rows = history(signal.symbol)
  const known = rows.filter(r => r.time + 60 <= signalEpoch)
  const today = known.filter(r => dateOf(r.time) === signal.date && minuteOf(r.time) >= '09:15')
  const pastDates = [...new Set(rows.map(r => dateOf(r.time)).filter(d => d < signal.date))].sort().slice(-2)
  const prior = pastDates.map(date => rows.filter(r => dateOf(r.time) === date && minuteOf(r.time) >= '09:15' && minuteOf(r.time) < '15:30'))
  const priorAll = prior.flat()
  const priorSameTimeVolumes = prior.map(dayRows => dayRows.filter(r => minuteOf(r.time + 60) <= signal.signalAt.slice(11)).reduce((s, r) => s + r.volume, 0))
  const currentVolume = today.reduce((s, r) => s + r.volume, 0)
  const priorSameTimeAverage = priorSameTimeVolumes.length ? priorSameTimeVolumes.reduce((a, b) => a + b, 0) / priorSameTimeVolumes.length : null
  const close = today.at(-1)?.close
  const e50 = ema(known, 50), e200 = ema(known, 200)
  const intervalMove = minutes => today.length >= minutes ? directional(signal.side, pct(close, today.at(-minutes).open)) : null
  const priorHigh = priorAll.length ? Math.max(...priorAll.map(r => r.high)) : null
  const priorLow = priorAll.length ? Math.min(...priorAll.map(r => r.low)) : null
  const priorFirst = priorAll.at(0), priorLast = priorAll.at(-1)
  const rangePosition = priorHigh > priorLow ? 100 * (close - priorLow) / (priorHigh - priorLow) : null
  return { ...signal,
    priorSessions: pastDates.join('|'),
    ema50Vs200DirectionalPct: round(directional(signal.side, pct(e50, e200))),
    priceVsEma50DirectionalPct: round(directional(signal.side, pct(close, e50))),
    priceVsEma200DirectionalPct: round(directional(signal.side, pct(close, e200))),
    move3mDirectionalPct: round(intervalMove(3)), move5mDirectionalPct: round(intervalMove(5)),
    move10mDirectionalPct: round(intervalMove(10)), move15mDirectionalPct: round(intervalMove(15)),
    currentVsPriorSameTimeVolumeRatio: round(priorSameTimeAverage ? currentVolume / priorSameTimeAverage : null),
    priorTwoSessionTrendDirectionalPct: round(priorFirst && priorLast ? directional(signal.side, pct(priorLast.close, priorFirst.open)) : null),
    priorRangeDirectionalPositionPct: round(signal.side === 'BUY' ? rangePosition : 100 - rangePosition),
  }
})

const dimensions = ['ema50Vs200DirectionalPct','priceVsEma50DirectionalPct','priceVsEma200DirectionalPct','move3mDirectionalPct','move5mDirectionalPct','move10mDirectionalPct','move15mDirectionalPct','currentVsPriorSameTimeVolumeRatio','priorTwoSessionTrendDirectionalPct','priorRangeDirectionalPositionPct']
const targetRows = enriched.filter(x => x.reason === 'TARGET'), stoppedRows = enriched.filter(x => x.reason === 'SL')
const average = (rows, key) => round(rows.reduce((s, x) => s + (x[key] ?? 0), 0) / (rows.length || 1))
const comparison = Object.fromEntries(dimensions.map(key => [key, { targetAverage: average(targetRows, key), stopped: stoppedRows.map(x => x[key]) }]))

let jsonFile = 'reports/2026-10-22-23-0930-high-precision-context.json', suffix = 2
while (fs.existsSync(jsonFile)) jsonFile = `reports/2026-10-22-23-0930-high-precision-context-${suffix++}.json`
let csvFile = 'reports/2026-10-22-23-0930-high-precision-context.csv'; suffix = 2
while (fs.existsSync(csvFile)) csvFile = `reports/2026-10-22-23-0930-high-precision-context-${suffix++}.csv`
const output = { method: 'Context features use only completed 1m candles available at signal time. EMA50/200 carry across earlier sessions. Prior-session features use the two latest sessions before each signal date.', comparison, signals: enriched }
fs.writeFileSync(jsonFile, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' })
const columns = ['date','symbol','side','signalAt','reason','returnPct',...dimensions]
fs.writeFileSync(csvFile, `${columns.join(',')}\n${enriched.map(row => columns.map(k => row[k] ?? '').join(',')).join('\n')}\n`, { flag: 'wx' })
console.log(JSON.stringify({ jsonFile, csvFile, comparison, stoppedRows: stoppedRows.map(x => Object.fromEntries(columns.map(k => [k, x[k]]))) }, null, 2))
