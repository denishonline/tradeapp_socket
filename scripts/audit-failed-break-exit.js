#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT=process.cwd(),REPORTS=path.join(ROOT,'reports'),IST=330*60_000
const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1]}
const from=arg('--from'),to=arg('--to')
if(!from||!to)throw new Error('Usage: node scripts/audit-failed-break-exit.js --from YYYY-MM-DD --to YYYY-MM-DD')
const prefix=`${from}-to-${to}-sr-mtf-high-precision`
const file=fs.readdirSync(REPORTS).filter(name=>name.startsWith(prefix)&&name.endsWith('.json')).map(name=>path.join(REPORTS,name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]
if(!file)throw new Error(`No high-precision report found for ${from} through ${to}`)
const report=JSON.parse(fs.readFileSync(file,'utf8'))
const stamp=seconds=>new Date(seconds*1000+IST).toISOString()
const round=value=>+value.toFixed(3)
const affected=[]
for(const signal of report.signals){
  const rows=fs.readFileSync(path.join(ROOT,'db','candles',`${signal.symbol}.jsonl`),'utf8').split(/\r?\n/).flatMap(line=>{
    if(!line)return[]
    try{const row=JSON.parse(line),at=stamp(+row.time);return at.slice(0,10)===signal.date?[{time:at.slice(11,16),open:+row.open,close:+row.close}]:[]}catch{return[]}
  }).sort((a,b)=>a.time.localeCompare(b.time))
  const inside=row=>signal.side==='BUY'?row.close<+signal.levelPrice:row.close>+signal.levelPrice
  const failedIndex=rows.findIndex(row=>row.time>=signal.entryTime&&row.time<signal.exitTime&&inside(row))
  if(failedIndex<0||!rows[failedIndex+1])continue
  const failed=rows[failedIndex],exit=rows[failedIndex+1],direction=signal.side==='BUY'?1:-1
  affected.push({date:signal.date,symbol:signal.symbol,side:signal.side,originalExit:signal.exitTime,originalReturnPct:+signal.returnPct,failedClose:failed.time,failedExit:exit.time,failedReturnPct:round(direction*100*(exit.open/+signal.entryPrice-1))})
}
console.table(affected.map(row=>({Date:row.date,Stock:row.symbol,Side:row.side,'Original exit':row.originalExit,'Original %':row.originalReturnPct,'Failed close':row.failedClose,'Failed exit':row.failedExit,'Failed-exit %':row.failedReturnPct})))
console.log(JSON.stringify({from,to,trades:report.signals.length,affected:affected.length,unaffected:report.signals.length-affected.length,originalTotalPct:round(report.signals.reduce((sum,row)=>sum+(+row.returnPct||0),0)),replacementTotalPct:round(report.signals.reduce((sum,row)=>sum+(affected.find(item=>item.date===row.date&&item.symbol===row.symbol&&item.side===row.side)?.failedReturnPct??(+row.returnPct||0)),0))},null,2))
