#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT=process.cwd(), PRIOR='2026-11-13', LIVE='2026-11-16', IST=330*60_000
const G1=['HEROMOTOCO','POLICYBZR','SIEMENS']
const G2=['APLAPOLLO','EICHERMOT','KALYANKJIL','YESBANK','PIDILITIND','UNIONBANK','ASIANPAINT','GLAND','TRENT','SBIN','CANBK','MFSL','ALKEM','GRASIM','ASHOKLEY','BIOCON','MARICO','TMPV']
const SYMBOLS=[...G1,...G2], round=(x,d=5)=>Number.isFinite(x)?+x.toFixed(d):null, pct=(x,y)=>100*(x/y-1)
const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`
const minuteOf=s=>+s.slice(0,2)*60 + +s.slice(3)
const median=a=>{const b=a.filter(Number.isFinite).sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]:NaN}
function ema(a,n){let v=NaN;const k=2/(n+1);return a.map(x=>(v=Number.isFinite(v)?k*x+(1-k)*v:x))}
function rsi(a,n=14){if(a.length<=n)return NaN;let up=0,down=0;for(let i=1;i<=n;i++){const d=a[i]-a[i-1];up+=Math.max(0,d);down+=Math.max(0,-d)}up/=n;down/=n;for(let i=n+1;i<a.length;i++){const d=a[i]-a[i-1];up=(up*(n-1)+Math.max(0,d))/n;down=(down*(n-1)+Math.max(0,-d))/n}return down?100-100/(1+up/down):100}
function load(symbol){
  const rows=[]
  for(const line of fs.readFileSync(path.join(ROOT,'db','candles',`${symbol}.jsonl`),'utf8').split(/\r?\n/)){
    if(!line.trim())continue;let x;try{x=JSON.parse(line)}catch{continue}
    const s=new Date(+x.time*1000+IST).toISOString(),date=s.slice(0,10),time=s.slice(11,16)
    if(time<'09:15'||time>'15:29')continue
    rows.push({date,time,minute:minuteOf(time),o:+x.open,h:+x.high,l:+x.low,c:+x.close,v:+x.volume})
  }
  return rows.sort((a,b)=>a.date.localeCompare(b.date)||a.minute-b.minute)
}
function aggregate(rows,size){
  const out=[]
  for(let i=0;i<rows.length;i+=size){const z=rows.slice(i,i+size);if(z.length<size)continue;out.push({o:z[0].o,h:Math.max(...z.map(x=>x.h)),l:Math.min(...z.map(x=>x.l)),c:z.at(-1).c,v:z.reduce((s,x)=>s+x.v,0)})}
  return out
}
function frameFeatures(out,prefix){
  if(out.length<3)return{}
  const closes=out.map(x=>x.c), e5=ema(closes,5),e10=ema(closes,10),e20=ema(closes,20),last=out.at(-1),prior=out.at(-2),range=last.h-last.l||1
  return {
    [`${prefix}_ema5_10_gap`]:pct(e5.at(-1),e10.at(-1)),[`${prefix}_ema10_20_gap`]:pct(e10.at(-1),e20.at(-1)),
    [`${prefix}_ema5_slope3`]:e5.length>3?pct(e5.at(-1),e5.at(-4)):NaN,[`${prefix}_last_return`]:pct(last.c,prior.c),
    [`${prefix}_last_body`]:100*Math.abs(last.c-last.o)/range,[`${prefix}_last_close_loc`]:100*(last.c-last.l)/range,
    [`${prefix}_last_upper_wick`]:100*(last.h-Math.max(last.o,last.c))/range,[`${prefix}_rsi14`]:rsi(closes)
  }
}
function sessionFeatures(all,date,cutoff=null){
  const day=all.filter(x=>x.date===date && (cutoff===null||x.minute<cutoff)), priorDates=[...new Set(all.filter(x=>x.date<date).map(x=>x.date))]
  if(!day.length)return{}
  const o=day[0].o,c=day.at(-1).c,h=Math.max(...day.map(x=>x.h)),l=Math.min(...day.map(x=>x.l)),range=h-l||1,totalV=day.reduce((s,x)=>s+x.v,0),vwap=day.reduce((s,x)=>s+x.v*(x.h+x.l+x.c)/3,0)/(totalV||1)
  const features={return_open:pct(c,o),range_pct:100*range/o,close_location:100*(c-l)/range,vwap_distance:pct(c,vwap),up_candle_pct:100*day.filter(x=>x.c>x.o).length/day.length,efficiency:100*Math.abs(c-o)/(day.slice(1).reduce((s,x,i)=>s+Math.abs(x.c-day[i].c),0)||range),rsi14:rsi(day.map(x=>x.c)),volume:totalV}
  for(const size of [1,3,5,10,15]) Object.assign(features,frameFeatures(aggregate(day,size),`tf${size}`))
  const opening15=day.slice(0,15), closing30=day.slice(-30)
  if(opening15.length===15){features.open15_return=pct(opening15.at(-1).c,opening15[0].o);features.open15_range=100*(Math.max(...opening15.map(x=>x.h))-Math.min(...opening15.map(x=>x.l)))/opening15[0].o;features.open15_volume_share=100*opening15.reduce((s,x)=>s+x.v,0)/(totalV||1)}
  if(closing30.length===30)features.close30_return=pct(closing30.at(-1).c,closing30[0].o)
  if(cutoff!==null){
    const prev=all.filter(x=>x.date===PRIOR).slice(0,day.length),prevVol=prev.reduce((s,x)=>s+x.v,0)
    features.relative_volume=totalV/(prevVol||totalV)
    const priorDay=all.filter(x=>x.date===PRIOR),ph=Math.max(...priorDay.map(x=>x.h)),pl=Math.min(...priorDay.map(x=>x.l)),pc=priorDay.at(-1).c
    features.gap_pct=pct(o,pc);features.distance_prior_high=pct(c,ph);features.distance_prior_low=pct(c,pl);features.distance_prior_close=pct(c,pc)
  } else {
    const earlier=priorDates.slice(-6,-1).map(d=>all.filter(x=>x.date===d)),vols=earlier.map(z=>z.reduce((s,x)=>s+x.v,0)),ranges=earlier.map(z=>100*(Math.max(...z.map(x=>x.h))-Math.min(...z.map(x=>x.l)))/z[0].o)
    features.volume_vs_5d_median=totalV/(median(vols)||totalV);features.range_vs_5d_median=features.range_pct/(median(ranges)||features.range_pct)
    const highs=earlier.map(z=>Math.max(...z.map(x=>x.h))),lows=earlier.map(z=>Math.min(...z.map(x=>x.l)))
    if(highs.length){features.distance_5d_high=pct(c,Math.max(...highs));features.distance_5d_low=pct(c,Math.min(...lows))}
  }
  return Object.fromEntries(Object.entries(features).filter(([,v])=>Number.isFinite(v)))
}
const data=new Map(SYMBOLS.map(s=>[s,load(s)])), prior=new Map(SYMBOLS.map(s=>[s,sessionFeatures(data.get(s),PRIOR)]))
function combined(symbol,cutoff){return Object.fromEntries([...Object.entries(prior.get(symbol)).map(([k,v])=>[`prior_${k}`,v]),...Object.entries(sessionFeatures(data.get(symbol),LIVE,cutoff)).map(([k,v])=>[`live_${k}`,v])])}
function predicatesAt(cutoff){
  const features=new Map(SYMBOLS.map(s=>[s,combined(s,cutoff)])), names=[...new Set(G1.flatMap(s=>Object.keys(features.get(s))))]
  const predicates=[]
  for(const name of names){const gv=G1.map(s=>features.get(s)[name]);if(!gv.every(Number.isFinite))continue;const min=Math.min(...gv),max=Math.max(...gv),span=Math.max(Math.abs(max-min),Math.abs(min)*.02,1e-9),lo=min-.05*span,hi=max+.05*span;const pass=s=>Number.isFinite(features.get(s)[name])&&features.get(s)[name]>=lo&&features.get(s)[name]<=hi;predicates.push({name,lo,hi,excluded:G2.filter(s=>!pass(s)).length,pass})}
  predicates.sort((a,b)=>b.excluded-a.excluded||a.name.localeCompare(b.name))
  let survivors=[...G2],chosen=[]
  while(survivors.length&&chosen.length<5){const best=predicates.filter(p=>!chosen.includes(p)).sort((a,b)=>survivors.filter(s=>!a.pass(s)).length-survivors.filter(s=>!b.pass(s)).length).at(-1);if(!best||!survivors.some(s=>!best.pass(s)))break;chosen.push(best);survivors=survivors.filter(s=>best.pass(s))}
  return {cutoff:clock(cutoff),features,topSingle:predicates.slice(0,10).map(x=>({feature:x.name,min:round(x.lo),max:round(x.hi),group2Excluded:x.excluded})),chosen:chosen.map(x=>({feature:x.name,min:round(x.lo),max:round(x.hi)})),survivors}
}
const checkpoints=[]
for(let cutoff=560;cutoff<=630;cutoff+=5)checkpoints.push(predicatesAt(cutoff))
const exact=checkpoints.filter(x=>!x.survivors.length).sort((a,b)=>a.chosen.length-b.chosen.length||a.cutoff.localeCompare(b.cutoff))[0]
const priorOnly=predicatesAt(555)
const table=SYMBOLS.map(s=>({symbol:s,group:G1.includes(s)?1:2,...Object.fromEntries((exact?.chosen||[]).map(p=>[p.feature,round(exact.features.get(s)[p.feature])]))}))
const chronologicalMatches=[]
if(exact) for(const symbol of SYMBOLS){
  let first=null
  for(let cutoff=556;cutoff<=630;cutoff++){
    const f=combined(symbol,cutoff),pass=exact.chosen.every(p=>Number.isFinite(f[p.feature])&&f[p.feature]>=p.min&&f[p.feature]<=p.max)
    if(pass){first=clock(cutoff);break}
  }
  chronologicalMatches.push({symbol,group:G1.includes(symbol)?1:2,firstMatch:first})
}
const priorTable=SYMBOLS.map(s=>({symbol:s,group:G1.includes(s)?1:2,...Object.fromEntries(priorOnly.chosen.map(p=>[p.feature,round(priorOnly.features.get(s)[p.feature])]))}))
const priorFeatureMatrix=SYMBOLS.map(symbol=>({symbol,group:G1.includes(symbol)?1:2,...Object.fromEntries(Object.entries(prior.get(symbol)).map(([name,value])=>[name,round(value)]))}))
const report={generatedAt:new Date().toISOString(),priorSession:PRIOR,liveSession:LIVE,warning:'Retrospective separator fitted to these named stocks on one session; chronological features do not make its thresholds out-of-sample.',priorOnly:{topSingle:priorOnly.topSingle,chosen:priorOnly.chosen,survivingGroup2:priorOnly.survivors,table:priorTable,featureMatrix:priorFeatureMatrix},checkpoints:checkpoints.map(x=>({cutoff:x.cutoff,predicateCount:x.chosen.length,survivingGroup2:x.survivors})),selected:exact?{cutoff:exact.cutoff,predicates:exact.chosen,table,chronologicalMatches}:null}
const output=path.join(ROOT,'reports','2026-11-13-prior-and-2026-11-16-live-group1-vs-group2-separation-3.json')
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({output,priorOnly:report.priorOnly,selected:report.selected&&{cutoff:report.selected.cutoff,predicates:report.selected.predicates}},null,2))
if(table.length)console.table(table)
