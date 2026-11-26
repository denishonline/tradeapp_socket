#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT=process.cwd(), IST=330*60_000
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??fallback:fallback}
const date=option('--date',new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date()))
const cutoff=option('--cutoff','10:25')
const symbols=option('--symbols','').split(',').map(x=>x.replace(/[\\\s]+/g,'').replace(/^NSE:/i,'').replace(/-EQ$/i,'')).filter(Boolean)
if(!symbols.length)throw new Error('Provide comma-separated symbols with --symbols')

const ema=(values,period)=>{let value=NaN;const alpha=2/(period+1);return values.map(x=>(value=Number.isFinite(value)?alpha*x+(1-alpha)*value:x))}
const median=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:NaN}
function priorContext(symbol){
  const file=path.join(ROOT,'db','candles',`${symbol}.jsonl`)
  if(!fs.existsSync(file))return null
  const rows=fs.readFileSync(file,'utf8').split(/\r?\n/).flatMap(line=>{try{const x=JSON.parse(line),stamp=new Date(+x.time*1000+IST).toISOString(),day=stamp.slice(0,10),time=stamp.slice(11,16);return time>='09:15'&&time<='15:29'?[{day,time,o:+x.open,c:+x.close,v:+x.volume}]:[]}catch{return[]}})
  const earlierDates=[...new Set(rows.filter(x=>x.day<date).map(x=>x.day))].sort(),priorDate=earlierDates.at(-1)
  const day=rows.filter(x=>x.day===priorDate)
  if(day.length<30)return null
  const bars=[]
  for(let i=0;i+2<day.length;i+=3){const z=day.slice(i,i+3);bars.push({c:z.at(-1).c})}
  const e5=ema(bars.map(x=>x.c),5), slope=100*(e5.at(-1)/e5.at(-4)-1)
  const totalVolume=day.reduce((sum,x)=>sum+x.v,0), openingVolume=day.slice(0,15).reduce((sum,x)=>sum+x.v,0)
  const earlierVolumes=earlierDates.slice(-6,-1).map(session=>rows.filter(x=>x.day===session).reduce((sum,x)=>sum+x.v,0))
  return {priorDate,ema5Slope3mPct:slope,sessionReturnPct:100*(day.at(-1).c/day[0].o-1),volumeVs5dMedian:totalVolume/(median(earlierVolumes)||totalVolume),opening15VolumeSharePct:100*openingVolume/(totalVolume||1)}
}

const output=[]
for(const [index,symbol] of symbols.entries()){
  process.stderr.write(`\r\x1b[2KScanning [${index+1}/${symbols.length}] ${symbol}...`)
  const prior=priorContext(symbol)
  if(!prior||prior.ema5Slope3mPct<=0||prior.sessionReturnPct<=0||prior.volumeVs5dMedian<0.8||prior.opening15VolumeSharePct>10)continue
  const args=['scripts/analyze-smc-internal-order-blocks.js',symbol,date,'--json','--side','sell','--active-only','--early-candidates','--cutoff',cutoff]
  if(process.argv.includes('--refresh-fyers'))args.push('--refresh-fyers')
  const text=execFileSync(process.execPath,args,{encoding:'utf8'}),line=text.split(/\r?\n/).reverse().find(x=>x.trim().startsWith('[')),events=line?JSON.parse(line):[]
  const event=events.sort((a,b)=>a['Confirmed at'].localeCompare(b['Confirmed at']))[0]
  if(event)output.push({Stock:symbol,Side:'SELL','Signal time':event['Confirmed at'].slice(11),Status:event.Status,Trigger:event.Structure,'Prior trend':prior.ema5Slope3mPct>0?'UP':'DOWN','Prior return':`${prior.sessionReturnPct.toFixed(2)}%`,'Prior relative volume':`${prior.volumeVs5dMedian.toFixed(2)}x`,'Prior opening share':`${prior.opening15VolumeSharePct.toFixed(2)}%`})
}
process.stderr.write('\r\x1b[2K')
console.log(`Prior-session context + causal bearish trigger | ${date} | cutoff ${cutoff} IST`)
console.table(output)
