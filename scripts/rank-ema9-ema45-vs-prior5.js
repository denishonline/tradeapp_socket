import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2] ?? '2026-10-19', cutoff = process.argv[3] ?? '09:30'
const sessions = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']
const index = sessions.indexOf(date)
const priorArg = process.argv.indexOf('--prior'), priorCount = priorArg >= 0 ? Number(process.argv[priorArg + 1]) : 5
const topArg = process.argv.indexOf('--top'), topCount = topArg >= 0 ? Number(process.argv[topArg + 1]) : 5
if (index < priorCount || !/^\d{2}:\d{2}$/.test(cutoff) || !Number.isInteger(priorCount) || priorCount < 1 || !Number.isInteger(topCount) || topCount < 1) throw new Error('Usage: node scripts/rank-ema9-ema45-vs-prior5.js YYYY-MM-DD HH:MM [--prior 4|5] [--top N]')
const priorDates = sessions.slice(index - priorCount, index), cutoffMinute = Number(cutoff.slice(0, 2)) * 60 + Number(cutoff.slice(3)), symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/, '')))]
const stamp = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString(), round = (x, p = 4) => Number(x.toFixed(p)), mean = xs => xs.reduce((a,b) => a+b, 0) / xs.length

function evaluate(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`); if (!fs.existsSync(file)) return null
  const wanted = new Set([...priorDates, date]), unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row; try { row = JSON.parse(line) } catch { continue }
    const iso = stamp(+row.time), day = iso.slice(0,10), minute = Number(iso.slice(11,13))*60 + Number(iso.slice(14,16))
    // Warm the EMA from all earlier stored sessions, but retain snapshots only
    // for the current date and its five prior comparison sessions.
    if (day <= date && minute >= 555 && minute < 930 && +row.close > 0) unique.set(+row.time, { time:+row.time, day, minute, close:+row.close })
  }
  const rows = [...unique.values()].sort((a,b)=>a.time-b.time), alpha9=.2, alpha45=2/46
  if (!rows.length) return null
  let ema9=rows[0].close, ema45=rows[0].close; const snapshots={}
  for (const row of rows) {
    if (row !== rows[0]) { ema9=alpha9*row.close+(1-alpha9)*ema9; ema45=alpha45*row.close+(1-alpha45)*ema45 }
    // cutoff 09:30 sees the 09:29 candle.
    if (wanted.has(row.day) && row.minute === cutoffMinute - 1) snapshots[row.day]={ ema9, ema45, gapPct:100*(ema9/ema45-1) }
  }
  if (![...priorDates,date].every(day => snapshots[day])) return null
  const prior = priorDates.map(day => snapshots[day].gapPct), priorAbs = prior.map(Math.abs), current = snapshots[date].gapPct, currentAbs=Math.abs(current), priorAverageAbs=mean(priorAbs)
  return { symbol, gapPct:round(current), absoluteGapPct:round(currentAbs), priorAverageAbsoluteGapPct:round(priorAverageAbs), gapExpansionPct:round(currentAbs-priorAverageAbs), gapExpansionVsPriorPct:round(100*(currentAbs/priorAverageAbs-1)), direction:current>=0?'EMA9 above EMA45':'EMA9 below EMA45', priorGapPct:prior.map(x=>round(x)) }
}
const rows=symbols.map(evaluate).filter(Boolean).sort((a,b)=>b.gapExpansionPct-a.gapExpansionPct||b.absoluteGapPct-a.absoluteGapPct)
const newHighs = rows.filter(row => row.absoluteGapPct > Math.max(...row.priorGapPct.map(Math.abs)))
const report={date,cutoff,priorDates,method:'EMA9/EMA45 is updated only from candles available through the last completed candle before the requested cutoff. A stock qualifies only when its current absolute gap percentage exceeds all prior-session gaps at the same cutoff. Qualified stocks are ranked by expansion over their prior-session average absolute gap.',qualifiedCount:newHighs.length,top:newHighs.slice(0,topCount),qualified:newHighs,rows}
let n=1,output;do{output=path.join(root,'reports',`${date}-${cutoff.replace(':','')}-ema9-ema45-vs-prior5${n===1?'':`-${n}`}.json`);n++}while(fs.existsSync(output));fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(`Current ${date} ${cutoff}; prior ${priorCount}: ${priorDates.join(', ')}`)
console.log(`New ${priorCount}-session EMA-gap highs: ${report.qualifiedCount}; showing top ${report.top.length}`)
console.log('Stock\tSignal time\tGap %\tExpansion pp\tDirection')
const signalMinute = cutoffMinute - 1, signalTime = `${String(Math.floor(signalMinute / 60)).padStart(2, '0')}:${String(signalMinute % 60).padStart(2, '0')}`
for (const row of report.top) console.log(`${row.symbol}\t${date} ${signalTime}\t${row.gapPct >= 0 ? '+' : ''}${row.gapPct}%\t${row.gapExpansionPct >= 0 ? '+' : ''}${row.gapExpansionPct}\t${row.direction}`)
console.log(`Report: ${output}`)
