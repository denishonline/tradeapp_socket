#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT=process.cwd(), IST=330*60_000
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??fallback:fallback}
const date=option('--date',new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date()))
const start=option('--start','09:20'),end=option('--end','09:30')
const symbols=option('--symbols','').split(',').map(x=>x.replace(/[\\\s]+/g,'').replace(/^NSE:/i,'').replace(/-EQ$/i,'')).filter((x,i,a)=>x&&a.indexOf(x)===i)
if(!symbols.length)throw new Error('Provide comma-separated symbols with --symbols')
const minuteOf=value=>+value.slice(0,2)*60 + +value.slice(3), startMinute=minuteOf(start),endMinute=minuteOf(end)
const round=(value,digits=3)=>Number.isFinite(value)?+value.toFixed(digits):null
const local=iso=>new Date(Date.parse(iso)+IST).toISOString()

function depthSamples(symbol){
  const file=path.join(ROOT,'db','cash-depth',date,symbol,`${symbol}.jsonl`)
  if(!fs.existsSync(file))return[]
  const state={},samples=[]
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line.trim())continue
    let event;try{event=JSON.parse(line)}catch{continue}
    const stamp=local(event.receivedAt),day=stamp.slice(0,10),time=stamp.slice(11,16),minute=minuteOf(time)
    if(day!==date||minute<startMinute||minute>=endMinute)continue
    if(event.kind==='checkpoint')for(const key of Object.keys(state))delete state[key]
    Object.assign(state,event.data||{})
    let bid=0,ask=0,valid=true
    for(let level=1;level<=5;level++){
      const bp=+state[`bid_price${level}`],ap=+state[`ask_price${level}`],bs=+state[`bid_size${level}`],as=+state[`ask_size${level}`]
      if(![bp,ap,bs,as].every(Number.isFinite)||ap<=bp){valid=false;break}
      bid+=bs;ask+=as
    }
    if(valid)samples.push({time,bidShare:100*bid/(bid+ask||1),mid:(+state.bid_price1+ +state.ask_price1)/2})
  }
  return samples
}
function candles(symbol){
  const file=path.join(ROOT,'db','candles',`${symbol}.jsonl`)
  if(!fs.existsSync(file))return[]
  return fs.readFileSync(file,'utf8').split(/\r?\n/).flatMap(line=>{try{const x=JSON.parse(line),stamp=new Date(+x.time*1000+IST).toISOString(),day=stamp.slice(0,10),time=stamp.slice(11,16),minute=minuteOf(time);return day===date&&minute>=startMinute&&minute<endMinute?[{o:+x.open,h:+x.high,l:+x.low,c:+x.close}]:[]}catch{return[]}})
}
const all=[]
for(const symbol of symbols){
  const depth=depthSamples(symbol),bars=candles(symbol)
  if(depth.length<10||!bars.length)continue
  const minuteStats=[...new Set(depth.map(x=>x.time))].map(time=>{const z=depth.filter(x=>x.time===time);return z.reduce((sum,x)=>sum+x.bidShare,0)/z.length})
  const firstMid=depth[0].mid,lastMid=depth.at(-1).mid,midMove=100*(lastMid/firstMid-1),priceMove=100*(bars.at(-1).c/bars[0].o-1)
  all.push({Stock:symbol,Snapshots:depth.length,'Mean bid share':round(depth.reduce((sum,x)=>sum+x.bidShare,0)/depth.length),'Bid-dominant minutes':round(100*minuteStats.filter(x=>x>50).length/minuteStats.length),'Midpoint move':round(midMove),'Price move':round(priceMove),'Status':(depth.reduce((sum,x)=>sum+x.bidShare,0)/depth.length>=60&&minuteStats.filter(x=>x>50).length/minuteStats.length>=0.70&&midMove<=-0.1&&priceMove<=-0.1)?'Bearish-to-neutral, with absorption':'Other'})
}
const matches=all.filter(row=>row.Status==='Bearish-to-neutral, with absorption').sort((a,b)=>b['Mean bid share']-a['Mean bid share'])
const output=path.join(ROOT,'reports',`${date}-${start.replace(':','')}-to-${end.replace(':','')}-bid-absorption-scan-2.json`)
fs.writeFileSync(output,JSON.stringify({date,window:`${start}–${end} IST`,definition:'Mean top-five bid share >=60%; bid-dominant in >=70% of observed minutes; midpoint and one-minute candle-window price both fall by at least 0.10%.',symbolsScanned:symbols.length,stocksWithDepth:all.length,matches,all},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({date,window:`${start}–${end} IST`,definition:'Bid share >=60%, bid-dominant minutes >=70%, midpoint <=-0.10%, price <=-0.10%.',symbolsScanned:symbols.length,stocksWithDepth:all.length,matches,output},null,2))
