import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = '2026-10-21'
const signals = [
  ['HEROMOTOCO','09:22'],['RELIANCE','09:24'],['WIPRO','09:25'],['JSWSTEEL','09:26'],['INFY','09:26'],['HINDZINC','09:28'],['NHPC','09:29'],['IDEA','09:30'],['KALYANKJIL','09:31'],['SONACOMS','09:32'],['ULTRACEMCO','09:35'],['PETRONET','09:35'],['BHEL','09:38'],['DALBHARAT','09:38'],['PNBHOUSING','09:41'],['ICICIBANK','09:46'],['BOSCHLTD','09:47'],['INDHOTEL','10:03'],['APLAPOLLO','11:25']
].map(([symbol, signalTime]) => ({ symbol, signalTime, entryMinute: Number(signalTime.slice(0,2))*60 + Number(signalTime.slice(3)) + 1 }))
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0,16).replace('T',' ')
const rowsFor = symbol => {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`), rows = []
  if (!fs.existsSync(file)) return rows
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line), time = stamp(+r.time)
      if (time.slice(0,10) !== date || ![r.open,r.high,r.low,r.close].every(v => Number.isFinite(+v))) continue
      const minute = Number(time.slice(11,13))*60 + Number(time.slice(14,16))
      if (minute >= 555 && minute < 930) rows.push({ time, minute, open:+r.open, high:+r.high, low:+r.low, close:+r.close })
    } catch {}
  }
  return rows.sort((a,b) => a.minute-b.minute)
}
const output = signals.map(signal => {
  const rows = rowsFor(signal.symbol), entryIndex = rows.findIndex(row => row.minute === signal.entryMinute)
  if (entryIndex < 0) return { ...signal, outcome:'NO_ENTRY_DATA' }
  const entry = rows[entryIndex].close, stop = entry * 1.005, target = entry * .98
  let outcome = 'OPEN_AT_SESSION_END', resolvedAt = null, resolvedPrice = null
  for (const row of rows.slice(entryIndex + 1)) {
    const hitStop = row.high >= stop, hitTarget = row.low <= target
    if (hitStop && hitTarget) { outcome = 'STOP_AND_TARGET_SAME_CANDLE_CONSERVATIVE_STOP'; resolvedAt = row.time; resolvedPrice = stop; break }
    if (hitStop) { outcome = 'STOP'; resolvedAt = row.time; resolvedPrice = stop; break }
    if (hitTarget) { outcome = 'TARGET_-2%'; resolvedAt = row.time; resolvedPrice = target; break }
  }
  return { ...signal, entryTime: rows[entryIndex].time, entryPrice: entry, stopPrice: stop, targetPrice: target, outcome, resolvedAt, resolvedPrice }
})
const report = { date, side:'SELL', entryRule:'next completed candle close after listed signal minute', stopPct:0.5, targetPct:2, sameCandleRule:'conservative stop', signals:output, totals:{ signals:output.length, targetBeforeStop:output.filter(x=>x.outcome==='TARGET_-2%').length, stopped:output.filter(x=>x.outcome==='STOP'||x.outcome==='STOP_AND_TARGET_SAME_CANDLE_CONSERVATIVE_STOP').length, open:output.filter(x=>x.outcome==='OPEN_AT_SESSION_END').length, missing:output.filter(x=>x.outcome==='NO_ENTRY_DATA').length } }
const file = path.join(root, 'reports', `${date}-ema-gap-sell-19-signals-stop-0_5-target-2.json`)
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ file, totals:report.totals, results:output.map(x=>({symbol:x.symbol,signalTime:x.signalTime,entryTime:x.entryTime,outcome:x.outcome,resolvedAt:x.resolvedAt})) }, null, 2))
