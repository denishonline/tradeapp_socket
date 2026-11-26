import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const input = process.argv[2] ?? 'reports/2026-10-22-23-0930-earlier-hybrid-signals.csv'
const lines = fs.readFileSync(input, 'utf8').trim().split(/\r?\n/)
const header = lines[0].split(',')
const signals = lines.slice(1).map(line => Object.fromEntries(line.split(',').map((value, index) => [header[index], value]))).map(row => ({ ...row, entryPrice: Number(row.entryPrice) }))
const dates = [...new Set(signals.map(row => row.date))].sort()
const ist = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const dateOf = seconds => ist(seconds).slice(0, 10)
const timeOf = seconds => ist(seconds).slice(11)
const pct = (value, base) => 100 * (value / base - 1)
const round = value => Number.isFinite(value) ? Number(value.toFixed(4)) : null
const readRows = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})
const cache = new Map()
function candles(symbol, date) {
  const key = `${symbol}|${date}`
  if (cache.has(key)) return cache.get(key)
  let e5 = null, e10 = null, e20 = null
  const rows = readRows(path.join(root, 'db', 'candles', `${symbol}.jsonl`))
    .filter(row => dateOf(row.time) === date && timeOf(row.time) >= '09:15' && timeOf(row.time) < '15:00')
    .sort((a, b) => a.time - b.time)
    .map(row => {
      e5 = e5 == null ? row.close : e5 + 2 / 6 * (row.close - e5)
      e10 = e10 == null ? row.close : e10 + 2 / 11 * (row.close - e10)
      e20 = e20 == null ? row.close : e20 + 2 / 21 * (row.close - e20)
      return { ...row, e5, e10, e20 }
    })
  cache.set(key, rows)
  return rows
}
function context(signal) {
  const rows = candles(signal.symbol, signal.date)
  const entryEpoch = Date.parse(`${signal.entryAt.replace(' ', 'T')}:00+05:30`) / 1000
  const index = rows.findIndex(row => row.time >= entryEpoch)
  const direction = signal.side === 'BUY' ? 1 : -1
  return { rows, index, direction, initialStop: signal.entryPrice * (1 - direction * .005) }
}
function stopped(row, stop, direction) {
  const gap = direction > 0 ? row.open <= stop : row.open >= stop
  const hit = direction > 0 ? row.low <= stop : row.high >= stop
  return gap || hit ? (gap ? row.open : stop) : null
}
function result(signal, reason, exitAt, exitPrice, mae, returnPct = null) {
  const direction = signal.side === 'BUY' ? 1 : -1
  return { ...signal, exitStrategy: reason, exitAt, exitPrice: round(exitPrice), returnPct: round(returnPct ?? direction * pct(exitPrice, signal.entryPrice)), maxAdverseExcursionPct: round(mae) }
}
function fixed(signal, targetPct) {
  const { rows, index, direction, initialStop } = context(signal)
  const target = signal.entryPrice * (1 + direction * targetPct / 100)
  let mae = 0
  for (let i = index; i < rows.length; i++) {
    const row = rows[i]
    mae = Math.min(mae, direction > 0 ? pct(row.low, signal.entryPrice) : -pct(row.high, signal.entryPrice))
    const stopFill = stopped(row, initialStop, direction)
    if (stopFill != null) return result(signal, 'SL', ist(row.time + 60), stopFill, mae)
    const targetHit = direction > 0 ? row.high >= target : row.low <= target
    if (targetHit) return result(signal, `TARGET_${targetPct}`, ist(row.time + 60), target, mae, targetPct)
  }
  const last = rows.at(-1)
  return result(signal, '15:00', ist(last.time + 60), last.close, mae)
}
function trail(signal, activationPct, distancePct) {
  const { rows, index, direction, initialStop } = context(signal)
  let stop = initialStop, extreme = signal.entryPrice, active = false, mae = 0
  for (let i = index; i < rows.length; i++) {
    const row = rows[i]
    mae = Math.min(mae, direction > 0 ? pct(row.low, signal.entryPrice) : -pct(row.high, signal.entryPrice))
    const stopFill = stopped(row, stop, direction)
    if (stopFill != null) return result(signal, active ? `TRAIL_${distancePct}` : 'SL', ist(row.time + 60), stopFill, mae)
    extreme = direction > 0 ? Math.max(extreme, row.high) : Math.min(extreme, row.low)
    const favorable = direction * pct(extreme, signal.entryPrice)
    if (favorable >= activationPct) {
      active = true
      const candidate = extreme * (1 - direction * distancePct / 100)
      stop = direction > 0 ? Math.max(stop, signal.entryPrice, candidate) : Math.min(stop, signal.entryPrice, candidate)
    }
  }
  const last = rows.at(-1)
  return result(signal, '15:00', ist(last.time + 60), last.close, mae)
}
function crossed(row, prior, direction, fastKey, slowKey) {
  if (!prior) return false
  return direction > 0 ? prior[fastKey] >= prior[slowKey] && row[fastKey] < row[slowKey] : prior[fastKey] <= prior[slowKey] && row[fastKey] > row[slowKey]
}
function emaExit(signal, fastKey, slowKey) {
  const { rows, index, direction, initialStop } = context(signal)
  let mae = 0
  for (let i = index; i < rows.length; i++) {
    const row = rows[i]
    mae = Math.min(mae, direction > 0 ? pct(row.low, signal.entryPrice) : -pct(row.high, signal.entryPrice))
    const stopFill = stopped(row, initialStop, direction)
    if (stopFill != null) return result(signal, 'SL', ist(row.time + 60), stopFill, mae)
    if (crossed(row, rows[i - 1], direction, fastKey, slowKey) && rows[i + 1]) return result(signal, `${fastKey.toUpperCase()}_${slowKey.toUpperCase()}_CROSS`, ist(rows[i + 1].time), rows[i + 1].open, mae)
  }
  const last = rows.at(-1)
  return result(signal, '15:00', ist(last.time + 60), last.close, mae)
}
function partialTrail(signal, distancePct) {
  const { rows, index, direction, initialStop } = context(signal)
  const target = signal.entryPrice * (1 + direction * .01)
  let stop = initialStop, extreme = signal.entryPrice, partial = false, mae = 0
  for (let i = index; i < rows.length; i++) {
    const row = rows[i]
    mae = Math.min(mae, direction > 0 ? pct(row.low, signal.entryPrice) : -pct(row.high, signal.entryPrice))
    const stopFill = stopped(row, stop, direction)
    if (stopFill != null) {
      const runnerReturn = direction * pct(stopFill, signal.entryPrice)
      return result(signal, partial ? `PARTIAL_1_TRAIL_${distancePct}` : 'SL', ist(row.time + 60), stopFill, mae, partial ? .5 + .5 * runnerReturn : runnerReturn)
    }
    if (!partial && (direction > 0 ? row.high >= target : row.low <= target)) partial = true
    extreme = direction > 0 ? Math.max(extreme, row.high) : Math.min(extreme, row.low)
    if (partial) {
      const candidate = extreme * (1 - direction * distancePct / 100)
      stop = direction > 0 ? Math.max(signal.entryPrice, candidate) : Math.min(signal.entryPrice, candidate)
    }
  }
  const last = rows.at(-1), runnerReturn = direction * pct(last.close, signal.entryPrice)
  return result(signal, partial ? 'PARTIAL_1_15:00' : '15:00', ist(last.time + 60), last.close, mae, partial ? .5 + .5 * runnerReturn : runnerReturn)
}
const strategies = [
  ['FIXED_1', signal => fixed(signal, 1)], ['FIXED_1_5', signal => fixed(signal, 1.5)],
  ['EMA5_10', signal => emaExit(signal, 'e5', 'e10')], ['EMA10_20', signal => emaExit(signal, 'e10', 'e20')],
  ['TRAIL_A0.5_D0.5', signal => trail(signal, .5, .5)], ['TRAIL_A0.5_D0.75', signal => trail(signal, .5, .75)],
  ['TRAIL_A1_D0.5', signal => trail(signal, 1, .5)], ['TRAIL_A1_D0.75', signal => trail(signal, 1, .75)], ['TRAIL_A1_D1', signal => trail(signal, 1, 1)],
  ['PARTIAL50_1_TRAIL0.5', signal => partialTrail(signal, .5)], ['PARTIAL50_1_TRAIL0.75', signal => partialTrail(signal, .75)], ['PARTIAL50_1_TRAIL1', signal => partialTrail(signal, 1)],
]
function stats(rows) {
  const total = rows.reduce((sum, row) => sum + row.returnPct, 0)
  const byDay = dates.map(date => ({ date, rows: rows.filter(row => row.date === date) })).map(item => ({ date: item.date, trades: item.rows.length, totalReturnPct: round(item.rows.reduce((sum, row) => sum + row.returnPct, 0)) }))
  return { trades: rows.length, profitable: rows.filter(row => row.returnPct > 0).length, winRatePct: round(100 * rows.filter(row => row.returnPct > 0).length / rows.length),
    averageReturnPct: round(total / rows.length), totalReturnPct: round(total), maximumAdverseExcursionPct: round(Math.min(...rows.map(row => row.maxAdverseExcursionPct))),
    worstTradePct: round(Math.min(...rows.map(row => row.returnPct))), bestTradePct: round(Math.max(...rows.map(row => row.returnPct))),
    worstDay: byDay.sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0] }
}
const evaluations = strategies.map(([name, run]) => { const trades = signals.map(run); return { name, ...stats(trades), trades } }).sort((a, b) => b.averageReturnPct - a.averageReturnPct)
let outputFile = 'reports/2026-10-22-23-0930-hybrid-exit-evaluation.json', suffix = 2
while (fs.existsSync(outputFile)) outputFile = `reports/2026-10-22-23-0930-hybrid-exit-evaluation-${suffix++}.json`
fs.writeFileSync(outputFile, `${JSON.stringify({ assumptions: '0.5% initial stop; stop priority within ambiguous candle; EMA cross exits at next candle open; trailing level updates only after candle completion and applies from next candle; 15:00 maximum exit; gross returns.', evaluations }, null, 2)}\n`, { flag: 'wx' })
const selected = evaluations.filter(item => item.winRatePct >= 90).sort((a, b) => b.averageReturnPct - a.averageReturnPct)[0]
let signalFile = 'reports/2026-10-22-23-0930-hybrid-best-trailing-exits.csv'; suffix = 2
while (fs.existsSync(signalFile)) signalFile = `reports/2026-10-22-23-0930-hybrid-best-trailing-exits-${suffix++}.csv`
const columns = ['date','symbol','side','branch','signalAt','entryAt','entryPrice','exitAt','exitPrice','exitStrategy','returnPct','maxAdverseExcursionPct']
fs.writeFileSync(signalFile, `${columns.join(',')}\n${selected.trades.map(row => columns.map(key => row[key] ?? '').join(',')).join('\n')}\n`, { flag: 'wx' })
console.log(JSON.stringify({ outputFile, signalFile, selected: { name: selected.name, ...stats(selected.trades) }, ranking: evaluations.map(({ trades, ...summary }) => summary) }, null, 2))
