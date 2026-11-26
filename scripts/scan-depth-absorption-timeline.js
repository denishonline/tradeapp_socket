#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import apiV3 from 'fyers-api-v3'
import { CONSTANT } from '../constant.js'

const ROOT=process.cwd(), IST=330*60_000
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]??fallback:fallback}
const date=option('--date',new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date()))
const start=option('--start','09:15'),end=option('--cutoff',option('--end','10:00')),windowMinutes=Number(option('--window','10'))
const countOccurrences=process.argv.includes('--count-occurrences')
const symbols=option('--symbols','').split(',').map(x=>x.replace(/[\\\s]+/g,'').replace(/^NSE:/i,'').replace(/-EQ$/i,'')).filter((x,i,a)=>x&&a.indexOf(x)===i)
if(!symbols.length)throw new Error('Provide comma-separated symbols with --symbols')
const toMinute=value=>+value.slice(0,2)*60 + +value.slice(3),clock=minute=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`
const startMinute=toMinute(start),endMinute=toMinute(end),round=(value,digits=3)=>Number.isFinite(value)?+value.toFixed(digits):null
const local=iso=>new Date(Date.parse(iso)+IST).toISOString()
let fyersClient=null
const priorCloseCache=new Map()
async function fetchPreviousSessionClose(symbol){
  if(priorCloseCache.has(symbol))return priorCloseCache.get(symbol)
  try{
    if(!fyersClient){
      const token=JSON.parse(fs.readFileSync(path.join(ROOT,'db','token'),'utf8'))
      if(typeof token!=='string'||!token.trim())throw new Error('FYERS token unavailable')
      fyersClient=new apiV3.fyersModel({enableLogging:false});fyersClient.setAppId(CONSTANT.appId);fyersClient.setAccessToken(token.trim())
    }
    const target=new Date(`${date}T00:00:00Z`),to=new Date(target),from=new Date(target)
    to.setUTCDate(to.getUTCDate()-1);from.setUTCDate(from.getUTCDate()-7)
    const response=await fyersClient.getHistory({symbol:`NSE:${symbol}-EQ`,resolution:'1',date_format:'1',range_from:from.toISOString().slice(0,10),range_to:to.toISOString().slice(0,10),cont_flag:'1'})
    if(response?.s!=='ok'||!Array.isArray(response.candles)||!response.candles.length)throw new Error(response?.message||'No FYERS candle data')
    const priorRows=response.candles.map(row=>({stamp:new Date(+row[0]*1000+IST).toISOString(),close:+row[4]})).filter(x=>x.stamp.slice(0,10)<date).sort((a,b)=>a.stamp.localeCompare(b.stamp))
    const last=priorRows.at(-1),value=last&&last.stamp.slice(11,16)==='15:29'?last.close:NaN
    priorCloseCache.set(symbol,value);return value
  }catch{priorCloseCache.set(symbol,NaN);return NaN}
}

function loadDepth(symbol){
  const file=path.join(ROOT,'db','cash-depth',date,symbol,`${symbol}.jsonl`)
  if(!fs.existsSync(file))return[]
  const state={},out=[]
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line.trim())continue;let event;try{event=JSON.parse(line)}catch{continue}
    const stamp=local(event.receivedAt),day=stamp.slice(0,10),time=stamp.slice(11,16),minute=toMinute(time)
    if(day!==date||minute<startMinute||minute>=endMinute)continue
    if(event.kind==='checkpoint')for(const key of Object.keys(state))delete state[key]
    Object.assign(state,event.data||{})
    let bid=0,ask=0,valid=true
    for(let level=1;level<=5;level++){
      const bp=+state[`bid_price${level}`],ap=+state[`ask_price${level}`],bs=+state[`bid_size${level}`],as=+state[`ask_size${level}`]
      if(![bp,ap,bs,as].every(Number.isFinite)||ap<=bp){valid=false;break}
      bid+=bs;ask+=as
    }
    if(valid)out.push({minute,bidShare:100*bid/(bid+ask||1),askShare:100*ask/(bid+ask||1),mid:(+state.bid_price1+ +state.ask_price1)/2})
  }
  return out
}
async function loadCandles(symbol){
  const file=path.join(ROOT,'db','candles',`${symbol}.jsonl`)
  if(!fs.existsSync(file))return{bars:[],previousClose:NaN}
  const unique=new Map()
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){try{const x=JSON.parse(line),stamp=new Date(+x.time*1000+IST).toISOString(),day=stamp.slice(0,10),time=stamp.slice(11,16),minute=toMinute(time);unique.set(`${day} ${time}`,{day,minute,o:+x.open,c:+x.close})}catch{}}
  const all=[...unique.values()].sort((a,b)=>a.day.localeCompare(b.day)||a.minute-b.minute)
  const priorDate=[...new Set(all.filter(x=>x.day<date).map(x=>x.day))].at(-1),prior=all.filter(x=>x.day===priorDate)
  const localClose=prior.at(-1)?.minute===929?prior.at(-1).c:NaN
  const previousClose=Number.isFinite(localClose)?localClose:await fetchPreviousSessionClose(symbol)
  return{bars:all.filter(x=>x.day===date&&x.minute>=startMinute&&x.minute<endMinute),previousClose,previousCloseSource:Number.isFinite(localClose)?'local-15:29':'fyers-fallback'}
}
function status(depth,bars,previousClose,from,to,side){
  const d=depth.filter(x=>x.minute>=from&&x.minute<to),c=bars.filter(x=>x.minute>=from&&x.minute<to)
  if(d.length<10||c.length<windowMinutes)return null
  const key=side==='BUY'?'askShare':'bidShare',label=side==='BUY'?'ask':'bid',observed=[...new Set(d.map(x=>x.minute))]
  const mean=d.reduce((sum,x)=>sum+x[key],0)/d.length
  const dominant=observed.filter(minute=>{const rows=d.filter(x=>x.minute===minute);return rows.reduce((sum,x)=>sum+x[key],0)/rows.length>50}).length/observed.length
  const midpointMove=100*(d.at(-1).mid/d[0].mid-1),priceMove=100*(c.at(-1).c/c[0].o-1)
  const movesWithSide=side==='BUY'?midpointMove>=.1&&priceMove>=.1:midpointMove<=-.1&&priceMove<=-.1
  if(mean<60||dominant<.70||!movesWithSide)return null
  return {Window:`${clock(from)}-${clock(to)}`,'Today return pct':round(100*(c.at(-1).c/previousClose-1)),[`Mean ${label} share`]:round(mean),[`${label[0].toUpperCase()+label.slice(1)}-dominant minutes`]:round(100*dominant),'Midpoint move':round(midpointMove),'Price move':round(priceMove),Snapshots:d.length}
}

const matches=[],occurrences=[]
for(const [index,symbol] of symbols.entries()){
  process.stderr.write(`\r\x1b[2KScanning [${index+1}/${symbols.length}] ${symbol}...`)
  const depth=loadDepth(symbol),candleData=await loadCandles(symbol),bars=candleData.bars,previousClose=candleData.previousClose
  for(const side of ['BUY','SELL']){
    const hits=[]
    for(let until=startMinute+windowMinutes;until<=endMinute;until++){
      const found=status(depth,bars,previousClose,until-windowMinutes,until,side)
      if(found)hits.push({until,...found})
      if(found&&!countOccurrences){matches.push({Stock:symbol,Side:side,'Status time':clock(until),Status:side==='BUY'?'Bullish-to-neutral, with absorption':'Bearish-to-neutral, with absorption',...found});break}
    }
    if(countOccurrences&&hits.length){
      const episodes=[]
      for(const hit of hits){
        const episode=episodes.at(-1)
        if(!episode||hit.until>episode.lastUntil+1)episodes.push({firstUntil:hit.until,lastUntil:hit.until,qualifyingWindows:1,firstWindow:hit.Window,lastWindow:hit.Window,firstTodayReturnPct:hit['Today return pct']})
        else{episode.lastUntil=hit.until;episode.qualifyingWindows++;episode.lastWindow=hit.Window}
      }
      occurrences.push({Stock:symbol,Side:side,Count:episodes.length,'First time':clock(episodes[0].firstUntil),'Last time':clock(episodes.at(-1).lastUntil),'Qualifying windows':hits.length,Episodes:episodes.map(x=>({firstTime:clock(x.firstUntil),lastTime:clock(x.lastUntil),todayReturnPct:x.firstTodayReturnPct,qualifyingWindows:x.qualifyingWindows,firstWindow:x.firstWindow,lastWindow:x.lastWindow}))})
    }
  }
}
process.stderr.write('\r\x1b[2K')
matches.sort((a,b)=>a['Status time'].localeCompare(b['Status time'])||a.Side.localeCompare(b.Side)||a.Stock.localeCompare(b.Stock))
const summary=countOccurrences?symbols.map(Stock=>{
  const buy=occurrences.find(x=>x.Stock===Stock&&x.Side==='BUY'),sell=occurrences.find(x=>x.Stock===Stock&&x.Side==='SELL')
  return {Stock,'BUY count':buy?.Count??0,'SELL count':sell?.Count??0,'BUY first':buy?.['First time']??'-','SELL first':sell?.['First time']??'-','BUY windows':buy?.['Qualifying windows']??0,'SELL windows':sell?.['Qualifying windows']??0}
}):[]
const base=path.join(ROOT,'reports',`${date}-${start.replace(':','')}-to-${end.replace(':','')}-rolling-depth-absorption${countOccurrences?'-count':''}`)
let suffix=1,output=`${base}.json`
while(fs.existsSync(output))output=`${base}-${++suffix}.json`
fs.writeFileSync(output,JSON.stringify({date,scannedUntil:end,windowMinutes,counting:countOccurrences?'Consecutive qualifying rolling windows are grouped as one episode.':'First qualifying window per stock and side.',definitions:{BUY:'Mean top-five ask share >=60%; ask dominance in >=70% observed minutes; midpoint and price both rise by >=0.10%.',SELL:'Mean top-five bid share >=60%; bid dominance in >=70% observed minutes; midpoint and price both fall by >=0.10%.'},symbolsScanned:symbols.length,matches,summary,occurrences},null,2)+'\n',{flag:'wx'})
console.log(`Depth-absorption ${countOccurrences?'occurrences':'signals'} | ${date} | through ${end} IST | rolling ${windowMinutes} minutes`)
const displayRows=countOccurrences
  ? occurrences.flatMap(item=>item.Episodes.map(episode=>({Stock:item.Stock,Side:item.Side,'Status time':episode.firstTime===episode.lastTime?episode.firstTime:`${episode.firstTime}-${episode.lastTime}`,Window:episode.firstWindow===episode.lastWindow?episode.firstWindow:`${episode.firstWindow} to ${episode.lastWindow}`,'Today return pct':episode.todayReturnPct})))
  : matches.map(item=>({Stock:item.Stock,Side:item.Side,'Status time':item['Status time'],Window:item.Window,'Today return pct':item['Today return pct']}))
const display=side=>displayRows.filter(item=>item.Side===side).map(item=>({Stock:item.Stock,'Status time':item['Status time'],Window:item.Window,"Today's return":`${item['Today return pct']>=0?'+':''}${item['Today return pct'].toFixed(2)}%`}))
for(const side of ['BUY','SELL']){
  console.log(`\n${side} side:`)
  const rows=display(side)
  if(rows.length)console.table(rows)
  else console.log(`No ${side} absorption signal was found.`)
}
console.log(`Saved report: ${output}`)
