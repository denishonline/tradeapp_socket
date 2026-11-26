import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const targetDate = process.argv[2] ?? '2026-10-19'
const cutoff = process.argv[3] ?? 'latest'
const sessionArg = process.argv.indexOf('--sessions')
const sessionCount = sessionArg >= 0 ? Number(process.argv[sessionArg + 1]) : null
if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || (cutoff !== 'latest' && !/^\d{2}:\d{2}$/.test(cutoff)) || (sessionArg >= 0 && (!Number.isInteger(sessionCount) || sessionCount < 1))) {
  throw new Error('Usage: node scripts/scan-ema9-ema45-gap.js YYYY-MM-DD [HH:MM|latest] [--sessions N]')
}
const tradingSessions = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19']
const targetIndex = tradingSessions.indexOf(targetDate)
if (sessionCount && targetIndex < 0) throw new Error(`No session calendar entry for ${targetDate}`)
const includedDates = sessionCount ? new Set(tradingSessions.slice(Math.max(0, targetIndex - sessionCount + 1), targetIndex + 1)) : null
const cutoffValue = cutoff === 'latest' ? Infinity : ((Number(cutoff.slice(0, 2)) * 60) + Number(cutoff.slice(3)))
const IST = 330 * 60_000
const localParts = epoch => { const d = new Date(epoch * 1000 + IST); return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() } }
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8')).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]
const alpha9 = 2 / 10, alpha45 = 2 / 46

function scan(symbol) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { symbol, eligible: false, reason: 'missing candles' }
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const time = Number(row.time), close = Number(row.close)
    if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) continue
    const local = localParts(time)
    if (local.minute < 9 * 60 + 15 || local.minute >= 15 * 60 + 30 || local.date > targetDate || (includedDates && !includedDates.has(local.date))) continue
    if (local.date === targetDate && local.minute >= cutoffValue) continue
    if (!unique.has(time)) unique.set(time, { time, close })
  }
  const candles = [...unique.values()].sort((a, b) => a.time - b.time)
  if (!candles.length || localParts(candles.at(-1).time).date !== targetDate) return { symbol, eligible: false, reason: 'no target-date candle' }
  let ema9 = candles[0].close, ema45 = candles[0].close
  for (const candle of candles.slice(1)) { ema9 = alpha9 * candle.close + (1 - alpha9) * ema9; ema45 = alpha45 * candle.close + (1 - alpha45) * ema45 }
  const last = candles.at(-1), local = localParts(last.time), gapPct = 100 * (ema9 / ema45 - 1)
  const distanceGap = ema9 - ema45
  return { symbol, eligible: true, candleTimeIST: `${local.date} ${String(Math.floor(local.minute / 60)).padStart(2, '0')}:${String(local.minute % 60).padStart(2, '0')}`,
    candlesUsed: candles.length, close: round(last.close, 2), ema9: round(ema9, 2), ema45: round(ema45, 2), gapPct: round(gapPct, 4), gapBps: round(gapPct * 100, 1),
    distanceGap: round(distanceGap, 2), absoluteDistanceGap: round(Math.abs(distanceGap), 2),
    direction: gapPct >= 0 ? 'EMA9 above EMA45' : 'EMA9 below EMA45' }
}

const rows = symbols.map(scan), eligible = rows.filter(row => row.eligible)
const byDistance = [...eligible].sort((a, b) => b.absoluteDistanceGap - a.absoluteDistanceGap || a.symbol.localeCompare(b.symbol))
const byPercent = [...eligible].sort((a, b) => b.gapPct - a.gapPct || a.symbol.localeCompare(b.symbol))
const output = { targetDate, cutoffIST: cutoff, symbolsScanned: symbols.length, eligibleCount: eligible.length,
  method: `Continuous one-minute close EMAs, ${includedDates ? `seeded at the first candle of ${[...includedDates][0]} and restricted to ${includedDates.size} sessions` : 'seeded from the earliest stored candle in local history'}, updated only through each symbol's latest target-date candle before the requested cutoff.`,
  ema: { fastPeriod: 9, slowPeriod: 45, ranking: 'absolute price distance |EMA9 - EMA45|; signed gapPct is also reported' }, top5: byDistance.slice(0, 5), top5ByPercentGap: byPercent.slice(0, 5), rows }
let n = 1, file
do { file = path.join(root, 'reports', `${targetDate}-${cutoff === 'latest' ? 'live' : cutoff.replace(':', '')}-ema9-ema45-gap${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(`Date: ${targetDate} | cutoff: ${cutoff} IST | scanned: ${symbols.length} | ranked: ${eligible.length}`)
console.log('Rank Stock             Candle time       EMA9       EMA45    Distance   Gap%')
byDistance.slice(0, 5).forEach((row, index) => console.log(`${String(index + 1).padStart(4)} ${row.symbol.padEnd(16)} ${row.candleTimeIST.padEnd(18)} ${String(row.ema9).padStart(8)} ${String(row.ema45).padStart(10)} ${row.absoluteDistanceGap.toFixed(2).padStart(10)} ${row.gapPct.toFixed(4)}%`))
console.log(`JSON: ${file}`)
