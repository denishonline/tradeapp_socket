#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT=process.cwd(),IST=330*60_000
const cases=[
  {date:'2026-11-18',symbol:'NBCC',reference:'09:28'},
  {date:'2026-11-18',symbol:'BSE',reference:'09:40'},
  {date:'2026-11-17',symbol:'ASHOKLEY',reference:'09:30'},
  {date:'2026-11-17',symbol:'GODREJCP',reference:'09:38'},
]
const minuteOf=x=>+x.slice(0,2)*60+ +x.slice(3),clock=x=>`${String(Math.floor(x/60)).padStart(2,'0')}:${String(x%60).padStart(2,'0')}`,round=(x,d=4)=>Number.isFinite(x)?+x.toFixed(d):null
const ema=(values,n)=>{let value=NaN;const alpha=2/(n+1);return values.map(x=>(value=Number.isFinite(value)?alpha*x+(1-alpha)*value:x))}
function candles(symbol,date){
  const unique=new Map()
  for(const line of fs.readFileSync(path.join(ROOT,'db','candles',`${symbol}.jsonl`),'utf8').split(/\r?\n/)){try{const x=JSON.parse(line),stamp=new Date(+x.time*1000+IST).toISOString(),day=stamp.slice(0,10),time=stamp.slice(11,16);if(day===date)unique.set(time,{time,minute:minuteOf(time),o:+x.open,h:+x.high,l:+x.low,c:+x.close,v:+x.volume})}catch{}}
  return[...unique.values()].sort((a,b)=>a.minute-b.minute)
}
function features(all,until){
  const session=all.filter(x=>x.minute>=555&&x.minute<until),window=session.slice(-10)
  if(window.length<10)return null
  const open=window[0].o,close=window.at(-1).c,high=Math.max(...window.map(x=>x.h)),low=Math.min(...window.map(x=>x.l)),volume=window.reduce((s,x)=>s+x.v,0),vwap=window.reduce((s,x)=>s+x.v*(x.h+x.l+x.c)/3,0)/(volume||1),e5=ema(session.map(x=>x.c),5)
  return{statusTime:clock(until),window:`${window[0].time}-${clock(until)}`,windowReturnPct:100*(close/open-1),peakToClosePct:100*(close/high-1),closeLocationPct:100*(close-low)/(high-low||1),closeVsVwapPct:100*(close/vwap-1),ema5Slope3Pct:100*(e5.at(-1)/e5.at(-4)-1),redCandlePct:100*window.filter(x=>x.c<x.o).length/window.length,last3ReturnPct:100*(close/window.at(-4).c-1)}
}
const rule=x=>x&&x.windowReturnPct<=-.10&&x.peakToClosePct<=-.40&&x.closeLocationPct<=30&&x.closeVsVwapPct<0&&x.ema5Slope3Pct<0
const rows=[]
for(const item of cases){
  const all=candles(item.symbol,item.date),reference=features(all,minuteOf(item.reference)),first=[]
  for(let until=565;until<=minuteOf(item.reference);until++){const x=features(all,until);if(rule(x)){first.push(x);break}}
  const signal=first[0]??reference,signalIndex=all.findIndex(x=>x.minute===minuteOf(signal.statusTime)),entry=all[signalIndex]?.c,path=all.slice(signalIndex+1,signalIndex+31),exit=path.at(-1)?.c
  rows.push({date:item.date,symbol:item.symbol,referenceTime:item.reference,firstCausalSignal:signal.statusTime,signalWindow:signal.window,...Object.fromEntries(Object.entries(reference).filter(([key])=>!['statusTime','window'].includes(key))),sellReturn30mPct:Number.isFinite(exit)?100*(entry-exit)/entry:NaN,mae30mPct:path.length?100*(entry-Math.max(...path.map(x=>x.h)))/entry:NaN})
}
const rounded=rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='number'?round(v):v])))
const returns=rounded.map(x=>x.sellReturn30mPct),summary={tradeCount:rounded.length,winRatePct:round(100*rounded.filter(x=>x.sellReturn30mPct>0).length/rounded.length),averageReturnPct:round(returns.reduce((a,b)=>a+b,0)/returns.length),totalReturnPct:round(returns.reduce((a,b)=>a+b,0)),maximumAdverseExcursionPct:round(Math.min(...rounded.map(x=>x.mae30mPct))),worstDay:[...Map.groupBy(rounded,x=>x.date)].map(([date,z])=>({date,totalReturnPct:round(z.reduce((s,x)=>s+x.sellReturn30mPct,0))})).sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0]}
const output=path.join(ROOT,'reports','2026-11-17-18-four-stock-candle-only-sell-commonality.json')
fs.writeFileSync(output,JSON.stringify({warning:'Retrospective four-signal commonality; thresholds are in-sample and require untouched validation.',rule:['Rolling 10-minute return <= -0.10%','Peak-to-close <= -0.40%','Close location <=30%','Close below rolling VWAP','EMA(5) three-bar slope <0'],summary,rows:rounded},null,2)+'\n',{flag:'wx'})
console.table(rounded.map(x=>({Stock:x.symbol,Date:x.date,'Reference':x.referenceTime,'First causal':x.firstCausalSignal,'10m return':x.windowReturnPct,'Peak-close':x.peakToClosePct,'Close loc':x.closeLocationPct,'VWAP dist':x.closeVsVwapPct,'EMA slope':x.ema5Slope3Pct,'30m SELL':x.sellReturn30mPct})))
console.log(JSON.stringify(summary,null,2));console.log(output)
