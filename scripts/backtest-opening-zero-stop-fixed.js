import fs from 'node:fs'
import path from 'node:path'

// Fixed, causal replay of the compact 09:29 opening filter. The thresholds are
// copied unchanged from the Oct-19 research; outcomes never affect eligibility.
const root = process.cwd()
const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
const first = process.argv[2] ?? '2026-10-06', last = process.argv[3] ?? '2026-10-19'
const selectedDates = dates.filter(day => day >= first && day <= last)
if (!selectedDates.length) throw new Error('Usage: node scripts/backtest-opening-zero-stop-fixed.js [start-date] [end-date]')
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const sumVol = xs => xs.reduce((s, x) => s + x.volume, 0)
const pct = (a, b) => 100 * (a / b - 1)
const cache = new Map()

function candles(symbol) {
  if (cache.has(symbol)) return cache.get(symbol)
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const byDate = Object.fromEntries(dates.map(day => [day, []])), unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let raw; try { raw = JSON.parse(line) } catch { continue }
    const stamp = local(+raw.time), day = stamp.slice(0, 10), minute = stamp.slice(11)
    if (!byDate[day] || minute < '09:15' || minute > '15:29' || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(x => Number.isFinite(+x))) continue
    unique.set(stamp, { stamp, day, minute, open: +raw.open, high: +raw.high, low: +raw.low, close: +raw.close, volume: +raw.volume })
  }
  for (const row of unique.values()) byDate[row.day].push(row)
  for (const day of dates) byDate[day].sort((a, b) => a.stamp.localeCompare(b.stamp))
  cache.set(symbol, byDate); return byDate
}

function vwap(rows) { return rows.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / sumVol(rows) }
function exitTrade(rows, entryIndex, side) {
  const direction = side === 'BUY' ? 1 : -1, entry = rows[entryIndex].close
  const stop = entry * (1 - direction * .75 / 100), target = entry * (1 + direction * 1.5 / 100)
  let mae = 0
  for (let i = entryIndex + 1; i < rows.length; i++) {
    const bar = rows[i], adverse = side === 'BUY' ? pct(bar.low, entry) : 100 * (1 - bar.high / entry)
    mae = Math.min(mae, adverse)
    const hitStop = side === 'BUY' ? bar.low <= stop : bar.high >= stop
    const hitTarget = side === 'BUY' ? bar.high >= target : bar.low <= target
    if (hitStop || hitTarget) {
      // A one-minute OHLC candle cannot establish intrabar order. Use the conservative stop-first rule.
      const price = hitStop ? stop : target
      return { entryPrice: round(entry), entryTime: rows[entryIndex].stamp, stop: round(stop), target: round(target), exitTime: bar.stamp, exitPrice: round(price), exitReason: hitStop ? 'stop' : 'target', returnPct: hitStop ? -.75 : 1.5, maximumAdverseExcursionPct: round(mae) }
    }
  }
  const last = rows.at(-1), result = direction * pct(last.close, entry)
  return { entryPrice: round(entry), entryTime: rows[entryIndex].stamp, stop: round(stop), target: round(target), exitTime: last.stamp, exitPrice: round(last.close), exitReason: 'end-of-day', returnPct: round(result), maximumAdverseExcursionPct: round(mae) }
}

function signal(symbol, day) {
  const index = dates.indexOf(day)
  if (index < 4) return null
  const data = candles(symbol); if (!data) return null
  const priorDates = dates.slice(index - 4, index), current = data[day]
  if (current.length !== 375 || priorDates.some(date => data[date].length !== 375)) return null
  const opening = current.slice(0, 15), move = pct(opening.at(-1).close, opening[0].open), side = move >= 0 ? 'BUY' : 'SELL', direction = side === 'BUY' ? 1 : -1
  const currentVwap = vwap(opening), firstTenVwap = vwap(opening.slice(0, 10)), third = opening.slice(10, 15)
  const rvol = sumVol(opening) / mean(priorDates.map(date => sumVol(data[date].slice(0, 15))))
  const thirdDirectional = direction * pct(third.at(-1).close, third[0].open)
  const absolute = Math.abs(move)
  if (!(absolute >= .75 && absolute <= 2.1724 && rvol >= 1 && direction * pct(opening.at(-1).close, currentVwap) > 0 && direction * pct(currentVwap, firstTenVwap) > 0 && thirdDirectional <= .287448)) return null
  return { date: day, symbol, side, signalTime: `${day} 09:29`, openingMovePct: round(move), relativeVolume: round(rvol), vwapGapDirectionalPct: round(direction * pct(opening.at(-1).close, currentVwap)), third5ReturnDirectionalPct: round(thirdDirectional), ...exitTrade(current, 15, side) }
}

const trades = [], coverage = []
for (const day of selectedDates) {
  const start = dates.indexOf(day)
  if (start < 4) { coverage.push({ date: day, status: 'not eligible: fewer than four prior sessions' }); continue }
  let complete = 0
  for (const [i, symbol] of symbols.entries()) {
    const row = signal(symbol, day)
    const series = candles(symbol)
    if (series && series[day]?.length === 375 && dates.slice(start - 4, start).every(prior => series[prior]?.length === 375)) complete++
    if (row) trades.push(row)
    if ((i + 1) % 25 === 0 || i + 1 === symbols.length) process.stdout.write(`Replaying ${day}: ${i + 1}/${symbols.length}\r`)
  }
  process.stdout.write('\n'); coverage.push({ date: day, status: 'replayed', completeSymbols: complete })
}
const daySummary = selectedDates.map(day => {
  const rows = trades.filter(row => row.date === day), returns = rows.map(row => row.returnPct), total = returns.reduce((a, b) => a + b, 0)
  return { date: day, tradeCount: rows.length, winners: rows.filter(row => row.returnPct > 0).length, stops: rows.filter(row => row.exitReason === 'stop').length, winRatePct: rows.length ? round(100 * rows.filter(row => row.returnPct > 0).length / rows.length) : null, averageReturnPct: rows.length ? round(mean(returns)) : null, totalCombinedReturnPct: round(total), maximumAdverseExcursionPct: rows.length ? round(Math.min(...rows.map(row => row.maximumAdverseExcursionPct))) : null }
})
const returns = trades.map(row => row.returnPct), total = returns.reduce((a, b) => a + b, 0), worstDay = daySummary.filter(row => row.tradeCount).sort((a,b) => a.totalCombinedReturnPct - b.totalCombinedReturnPct)[0] ?? null
const report = { strategy: 'Fixed 09:29 opening continuation filter',
  caveat: 'The thresholds were selected using October 19 and then replayed unchanged. Every signal uses only 09:29-or-earlier candles; entry is the next completed 09:30 candle close. This is a retrospective replay, gross of costs. Daily combined return is the arithmetic sum across simultaneous trades, not a portfolio return.',
  rules: ['Absolute opening move 0.75% to 2.1724%.', 'Same-time opening volume at least prior-four-session mean.', 'Directionally above/below rising/falling VWAP.', 'Directional 09:25-09:29 move at most 0.287448%.', '0.75% stop, 1.5% target, stop-first in ambiguous OHLC candle, EOD exit.'],
  coverage, summary: { tradeCount: trades.length, winners: trades.filter(row => row.returnPct > 0).length, stops: trades.filter(row => row.exitReason === 'stop').length, winRatePct: trades.length ? round(100 * trades.filter(row => row.returnPct > 0).length / trades.length) : null, averageReturnPct: trades.length ? round(mean(returns)) : null, totalCombinedReturnPct: round(total), maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(row => row.maximumAdverseExcursionPct))) : null, worstDay }, days: daySummary, trades }
let n = 1, output
do { output = path.join(root, 'reports', `2026-10-06-to-2026-10-19-fixed-opening-filter-replay${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ summary: report.summary, days: daySummary, output }, null, 2))
