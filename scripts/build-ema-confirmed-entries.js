import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {CANDLE_CACHE,DEPTH_CACHE,REPORTS,STEM,MINUTE,rowKey,save,indicators,aggregate,timeframeFeatures,normalize,loadCandles} from './research-ema-coverage.js'

const delayArgument=process.argv.find(arg=>arg.startsWith('--delay='))
const delay=delayArgument?Number(delayArgument.split('=')[1]):3
assert([1,2,3,5].includes(delay),'Supported confirmation delays: 1, 2, 3, 5 minutes')
const output=path.join(REPORTS,`${STEM}-delay${delay}-candles.json`)
if(fs.existsSync(output)){console.log(`Already built: ${output}`);process.exit(0)}
const data=JSON.parse(fs.readFileSync(CANDLE_CACHE,'utf8'))
const originalDepth=JSON.parse(fs.readFileSync(DEPTH_CACHE,'utf8')).rows
const nifty=new Map([...loadCandles('NIFTY50')].map(([d,rs])=>[d,{rows:indicators(rs),frames:new Map([3,5,10,15].map(n=>[n,aggregate(rs,n)]))}]))
const groups=Map.groupBy(data.events,e=>e.symbol),events=[],breadth=new Map();let done=0
const excluded=[]
for(const [symbol,opportunities]of groups){
  const byDate=new Map([...loadCandles(symbol)].map(([d,raw])=>[d,{rows:indicators(raw),frames:new Map([3,5,10,15].map(n=>[n,aggregate(raw,n)]))}]))
  for(const session of byDate.values())for(const r of session.rows){if(!breadth.has(r.t))breadth.set(r.t,{n:0,up:0,ret5:0});const b=breadth.get(r.t);b.n++;b.up+=r.sign>0?1:0;b.ret5+=Number.isFinite(r.f.ret5)?r.f.ret5:0}
  for(const e of opportunities){
    const session=byDate.get(e.date),signalAt=e.signalAt+delay*MINUTE,d=e.side==='BUY'?1:-1
    const index=session.rows.findIndex(r=>r.t===signalAt-MINUTE),entry=session.rows[index+1]
    // Accept only if the original EMA regime has remained intact throughout the wait.
    const wait=session.rows.filter(r=>r.t>=e.signalAt&&r.t<signalAt)
    if(index<0||!entry||entry.t!==signalAt||wait.length!==delay||wait.some(r=>r.sign!==d)){
      if(e.cohort)excluded.push({key:rowKey(e),reason:'Reversed during wait or missing confirmation candles'})
      continue
    }
    const ns=nifty.get(e.date),nr=ns?.rows.find(r=>r.t===signalAt-MINUTE)
    const features={...normalize(session.rows[index].f,d),...timeframeFeatures(session.frames,signalAt,d)}
    if(nr){Object.assign(features,normalize(nr.f,d,'nifty_'),timeframeFeatures(ns.frames,signalAt,d,'nifty_'));features.relativeRet5=features.ret5-features.nifty_ret5}
    const depth=originalDepth[rowKey(e)]
    // Original-crossover depth is now a known three-minute-old context, not a fresh book signal.
    if(depth)for(const [k,v]of Object.entries(depth))if(Number.isFinite(v)&&!['depthAvailable','depthLastAgeSec'].includes(k))features[`cross_${k}`]=v
    const end=e.exitReason==='OPPOSITE_CROSS'?session.rows.findIndex(r=>new Date(r.t+330*MINUTE).toISOString().slice(11,16)===e.exitTime):session.rows.length
    const future=session.rows.slice(index+1,end),hi=Math.max(entry.o,e.exitPrice,...future.map(r=>r.h)),lo=Math.min(entry.o,e.exitPrice,...future.map(r=>r.l))
    const shifted={...e,originalEntryTime:e.entryTime,signalAt,entryTime:new Date(signalAt+330*MINUTE).toISOString().slice(11,16),entryPrice:entry.o,
      returnPct:d*100*(e.exitPrice-entry.o)/entry.o,maePct:Math.min(0,d>0?100*(lo/entry.o-1):100*(1-hi/entry.o)),
      mfePct:Math.max(0,d>0?100*(hi/entry.o-1):100*(1-lo/entry.o)),features}
    events.push(shifted)
  }
  if(++done%50===0)console.log(`Confirmation ${done}/${groups.size}: ${events.length} entries`)
}
for(const e of events){const b=breadth.get(e.signalAt-MINUTE),d=e.side==='BUY'?1:-1;if(b){e.features.marketBreadth=d*(100*b.up/b.n-50);e.features.marketRet5=d*b.ret5/b.n}for(const k of Object.keys(e.features))if(!Number.isFinite(e.features[k]))delete e.features[k]}
const qualified=events.filter(e=>e.cohort).length
assert.equal(qualified+excluded.length,159)
save(output,{version:1,delayMinutes:delay,dates:data.dates,symbols:data.symbols,cohort:qualified,excludedCohort:excluded,features:[...new Set(events.flatMap(e=>Object.keys(e.features)))],events})
console.log(JSON.stringify({output,opportunities:events.length,qualified,excludedCohort:excluded},null,2))
