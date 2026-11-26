#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { load, featureRow, depthFeatures, SIGNALS, DATES } from './discover-0920-pvi-nvi-short-filter.js'

// The ten names in the last user-facing 09:17 winner table. They are training
// labels only, never signal predicates. Other names remain in the 50-name replay.
const TARGETS = new Set([
  '2026-10-26|AUBANK', '2026-10-27|DALBHARAT', '2026-10-27|RECLTD', '2026-10-27|CYIENT',
  '2026-10-29|TITAGARH', '2026-10-29|KPITTECH', '2026-10-29|BAJAJHLDNG',
  '2026-10-30|SUZLON', '2026-10-30|DALBHARAT', '2026-10-30|INOXWIND',
])
const clock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const avg = xs => xs.length ? xs.reduce((a,b) => a+b,0)/xs.length : null
const pct = (a,b) => 100*(a/b-1)
const rnd = x => Number.isFinite(x) ? +x.toFixed(5) : null
const STEM = '2026-10-26-to-2026-10-30-three-or-0917-0940-two-session'
const unique = suffix => {
  let i=1, file
  do { file=path.join('reports',`${STEM}${i===1?'':`-${i}`}.${suffix}`); i++ } while(fs.existsSync(file))
  return file
}
const cacheArg = process.argv.indexOf('--dataset')
const replayArg = process.argv.indexOf('--replay')
const beamSize = 140

function outcome(day, m) {
  // m labels the last observed bar. Signal at m+1; fill after bar m+1
  // completes (m+2 clock). No target/MAE from before the fill is included.
  const entry=day.find(r=>r.minute===m+1)
  if(!entry || entry.v<=0) return null
  const entryPrice=entry.c, subsequent=day.filter(r=>r.minute>m+1)
  if(!subsequent.length) return null
  let cross=null, previous=entry
  for(const r of subsequent) {
    if(previous.ema[20]<=previous.ema[40] && r.ema[20]>r.ema[40]) { cross=r; break }
    previous=r
  }
  const pathRows=subsequent.filter(r=>!cross || r.minute<=cross.minute)
  const target=pathRows.find(r=>r.l<=entryPrice*.98)
  const last=day.at(-1), crossFill=cross && day.find(r=>r.minute===cross.minute+1)
  const exitRow=target || crossFill || last
  const exitPrice=target ? entryPrice*.98 : exitRow.c
  const untilExit=subsequent.filter(r=>r.minute<=exitRow.minute)
  const maxHigh=Math.max(entryPrice,...untilExit.map(r=>r.h))
  const minLow=Math.min(entryPrice,...pathRows.map(r=>r.l))
  let missing=0
  for(let mm=m+2;mm<=exitRow.minute;mm++) if(!day.some(r=>r.minute===mm)) missing++
  if(missing) return null
  const grossReturnPct=100*(entryPrice-exitPrice)/entryPrice
  return {
    signalTime:clock(m+1), lastObservedCandle:clock(m), entryTime:clock(m+2), entryPrice,
    exitTime: target ? `${clock(target.minute)}-${clock(target.minute+1)}` : clock(exitRow.minute+1),
    exitPrice, exitReason:target?'2% target':cross?'EMA20 crosses above EMA40':'session close',
    targetHit:Boolean(target), grossReturnPct:rnd(grossReturnPct), after20BpsPct:rnd(grossReturnPct-.2),
    maePct:rnd(100*(maxHigh-entryPrice)/entryPrice), mfePct:rnd(100*(entryPrice-minLow)/entryPrice),
    bullishCrossCandle:cross?clock(cross.minute):null,
    emaExitReturnPct:rnd(100*(entryPrice-(crossFill||last).c)/entryPrice),
  }
}

function extraFeatures(stock,date,m) {
  const observed=stock.filter(r=>r.date<date || r.minute<=m), today=observed.filter(r=>r.date===date), last=today.at(-1)
  const prior=observed.filter(r=>r.date<date), priorHigh=Math.max(...prior.map(r=>r.h)), priorLow=Math.min(...prior.map(r=>r.l))
  const f={distanceTwoSessionHigh:pct(last.c,priorHigh),distanceTwoSessionLow:pct(last.c,priorLow)}
  for(const n of [3,5,10,15]) {
    const before=today.slice(Math.max(0,today.length-n-1),-1)
    if(before.length<n) continue
    const hi=Math.max(...before.map(r=>r.h)),lo=Math.min(...before.map(r=>r.l))
    f[`breakPrior${n}Low`]=pct(last.c,lo)
    f[`sweep${n}HighReject`]=Number(last.h>hi && last.c<hi)
    f[`sweep${n}LowRecover`]=Number(last.l<lo && last.c>lo)
    f[`volumeVsPrior${n}`]=last.v/(avg(before.map(r=>r.v))||1)
  }
  // Completed, session-aligned higher timeframe bars only.
  for(const n of [3,5,10,15]) {
    const end=555+Math.floor((m+1-555)/n)*n
    const bars=today.filter(r=>r.minute>=end-n && r.minute<end)
    if(bars.length!==n) continue
    const high=Math.max(...bars.map(r=>r.h)),low=Math.min(...bars.map(r=>r.l)),c=bars.at(-1).c
    f[`completed${n}mReturn`]=pct(c,bars[0].o)
    f[`completed${n}mCloseLocation`]=high>low?100*(c-low)/(high-low):50
  }
  return f
}

async function build() {
  const rawCache=new Map(), raw=s=>{if(!rawCache.has(s))rawCache.set(s,load(s));return rawCache.get(s)}
  const dataset=[]
  for(const date of DATES) {
    const nd=[...new Set(raw('NIFTY50').filter(r=>r.date<date).map(r=>r.date))].sort().slice(-2)
    const nifty=load('NIFTY50',[...nd,date])
    for(const symbol of SIGNALS[date]) {
      const priorDates=[...new Set(raw(symbol).filter(r=>r.date<date).map(r=>r.date))].sort().slice(-2)
      assert.equal(priorDates.length,2)
      // load filters BEFORE seeding all recursive indicators.
      const stock=load(symbol,[...priorDates,date]),day=stock.filter(r=>r.date===date)
      const events=[]
      for(let m=556;m<=579;m++) {
        const r=featureRow(date,symbol,stock,nifty,m), future=outcome(day,m)
        if(!r||!future)continue
        const f={...r.features,...extraFeatures(stock,date,m)}
        const dep=await depthFeatures(date,symbol,m)
        for(const [k,v] of Object.entries(dep)) if(!['depthAvailable','depthSamples'].includes(k)&&Number.isFinite(v))f[k]=v
        events.push({cutoff:m,features:f,...future})
      }
      dataset.push({date,symbol,key:`${date}|${symbol}`,requestedTarget:TARGETS.has(`${date}|${symbol}`),priorDates,events})
    }
    console.log(`Built ${date}: ${dataset.length} stock-days`)
  }
  const file=unique('dataset.json')
  fs.writeFileSync(file,JSON.stringify(dataset,null,2)+'\n',{flag:'wx'})
  console.log(`Dataset: ${file}`)
  return {dataset,file}
}

// Each stock-day is a 24-bit vector in chronological order. Predicates,
// conjunctions, and OR branches all replay the FIRST matching snapshot.
const firstBit = word => 31-Math.clz32((word&-word)>>>0)
function stats(mask,groups,trainIndices) {
  let good=0,bad=0,coverage=0,selected=0
  for(const g of trainIndices) {
    const word=mask[g]
    if(!word)continue
    selected++
    const event=groups[g].events[firstBit(word)]
    if(groups[g].requestedTarget && event.targetHit) {good++;coverage|=1<<groups[g].targetIndex}
    else bad++
  }
  return {good,bad,coverage,selected}
}
const bits = n => {let x=n,c=0;while(x){x&=x-1;c++}return c}

function fit(groups, trainIndices) {
  const featureNames=[...new Set(trainIndices.flatMap(g=>groups[g].events.flatMap(e=>Object.keys(e.features))))]
    .filter(n=>!['depthAvailable','depthSamples','priorDayCloseToOpen','return0916to0920'].includes(n))
  const predicates=[]
  for(const feature of featureNames) {
    const values=[...new Set(trainIndices.flatMap(g=>groups[g].events.map(e=>e.features[feature])).filter(Number.isFinite))].sort((a,b)=>a-b)
    if(values.length<2)continue
    const thresholds=new Set()
    // Fixed quantile budget bounds the search. Thresholds derived only from training dates.
    for(let j=1;j<=48;j++) {const i=Math.min(values.length-2,Math.floor(j*(values.length-1)/49));thresholds.add((values[i]+values[i+1])/2)}
    for(const threshold of thresholds) for(const op of ['lt','gt']) {
      const mask=new Uint32Array(groups.length)
      for(let g=0;g<groups.length;g++) groups[g].events.forEach((e,i)=>{
        const v=e.features[feature]
        if(Number.isFinite(v) && (op==='lt'?v<threshold:v>threshold))mask[g]|=1<<i
      })
      // Retain predicates that can reach a positive event, even if they fire too early alone.
      if(!trainIndices.some(g=>groups[g].requestedTarget && groups[g].events.some((e,i)=>e.targetHit && (mask[g]&(1<<i)))))continue
      const rules=[{feature,op,threshold}]
      predicates.push({rules,mask,...stats(mask,groups,trainIndices)})
    }
  }
  const clean=new Map()
  const remember=x=>{
    if(!x.bad && x.good) {
      const old=clean.get(x.coverage)
      if(!old || x.rules.length<old.rules.length)clean.set(x.coverage,x)
    }
  }
  const quality=x=>x.good-1.8*x.bad
  function beam(candidates) {
    const seen=new Set(), selected=[]
    const add=x=>{const key=Array.from(x.mask).join(',');if(!seen.has(key)){seen.add(key);selected.push(x)}}
    candidates.sort((a,b)=>quality(b)-quality(a)||b.good-a.good||a.rules.length-b.rules.length)
    candidates.slice(0,beamSize).forEach(add)
    // Preserve branches specialized to each requested winner as well.
    for(let t=0;t<10;t++) candidates.filter(x=>x.coverage&(1<<t)).slice(0,12).forEach(add)
    return selected
  }
  predicates.forEach(remember)
  let frontier=beam([...predicates])
  for(let depth=2;depth<=3;depth++) {
    let candidates=[]
    for(const a of frontier) for(const b of predicates) {
      if(a.rules.some(r=>r.feature===b.rules[0].feature))continue
      const mask=new Uint32Array(groups.length)
      for(let g=0;g<groups.length;g++)mask[g]=a.mask[g]&b.mask[g]
      const s=stats(mask,groups,trainIndices)
      if(!s.good)continue
      const x={rules:[...a.rules,...b.rules],mask,...s}
      remember(x)
      candidates.push(x)
      if(candidates.length>20000)candidates=beam(candidates)
    }
    frontier=beam(candidates)
  }
  // Exact union coverage over the retained zero-error branch candidates.
  let states=new Map([[0,[]]])
  for(let count=1;count<=3;count++) {
    const next=new Map(states)
    for(const [covered,branches] of states) for(const clause of clean.values()) {
      if(branches.length>=3)continue
      const union=covered|clause.coverage, proposal=[...branches,clause]
      const old=next.get(union)
      if(!old || proposal.reduce((s,b)=>s+b.rules.length,0)<old.reduce((s,b)=>s+b.rules.length,0))next.set(union,proposal)
    }
    states=next
  }
  const best=[...states].sort((a,b)=>bits(b[0])-bits(a[0])||a[1].length-b[1].length||a[1].reduce((s,b)=>s+b.rules.length,0)-b[1].reduce((s,b)=>s+b.rules.length,0))[0]
  return {predicates:predicates.length,cleanCoverages:clean.size,covered:bits(best[0]),branches:best[1].map(x=>x.rules)}
}
function replay(groups,branches) {
  const selected=[]
  for(const g of groups) for(const e of g.events) {
    const branch=branches.findIndex(rs=>rs.every(r=>Number.isFinite(e.features[r.feature])&&(r.op==='lt'?e.features[r.feature]<r.threshold:e.features[r.feature]>r.threshold)))
    if(branch<0)continue
    const {features,...event}=e
    selected.push({date:g.date,symbol:g.symbol,requestedTarget:g.requestedTarget,branch:branch+1,...event})
    break
  }
  return selected.sort((a,b)=>a.date.localeCompare(b.date)||a.signalTime.localeCompare(b.signalTime)||a.symbol.localeCompare(b.symbol))
}
function summarize(trades) {
  const daily=DATES.map(date=>({date,trades:trades.filter(t=>t.date===date).length,totalReturnPct:rnd(trades.filter(t=>t.date===date).reduce((s,t)=>s+t.grossReturnPct,0))}))
  return {tradeCount:trades.length,requestedTargets:trades.filter(t=>t.requestedTarget).length,targetHits:trades.filter(t=>t.targetHit).length,
    winRatePct:trades.length?rnd(100*trades.filter(t=>t.grossReturnPct>0).length/trades.length):null,
    averageReturnPct:rnd(avg(trades.map(t=>t.grossReturnPct))),totalReturnPct:rnd(trades.reduce((s,t)=>s+t.grossReturnPct,0)),
    totalAfter20BpsPct:rnd(trades.reduce((s,t)=>s+t.after20BpsPct,0)),maximumAdverseExcursionPct:trades.length?Math.max(...trades.map(t=>t.maePct)):null,
    worstDay:daily.filter(d=>d.trades).sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0]||null,daily}
}

const built=cacheArg>=0?{dataset:JSON.parse(fs.readFileSync(process.argv[cacheArg+1],'utf8')),file:process.argv[cacheArg+1]}:await build()
const groups=built.dataset
let targetIndex=0
groups.forEach(g=>{if(g.requestedTarget)g.targetIndex=targetIndex++})
assert.equal(groups.length,50);assert.equal(targetIndex,10)
const feasibility=groups.filter(g=>g.requestedTarget).map(g=>({date:g.date,symbol:g.symbol,possibleTimes:g.events.filter(e=>e.targetHit).map(e=>e.signalTime)}))
console.log('Target feasibility:',JSON.stringify(feasibility))
if(replayArg>=0) {
  const frozen=JSON.parse(fs.readFileSync(process.argv[replayArg+1],'utf8'))
  const trades=replay(groups,frozen.model.branches)
  console.log(JSON.stringify({mode:'Frozen rule replay; no fitting',summary:summarize(trades),trades},null,2))
  process.exit(0)
}
console.log('Searching up to 3 OR branches, each with up to 3 AND predicates...')
const model=fit(groups,groups.map((_,i)=>i)), selected=replay(groups,model.branches)
console.log('Full sample:',JSON.stringify({model,summary:summarize(selected),selected}))
const folds=[]
for(const heldOut of DATES) {
  const train=groups.map((g,i)=>g.date===heldOut?-1:i).filter(i=>i>=0)
  const fitted=fit(groups,train), trades=replay(groups.filter(g=>g.date===heldOut),fitted.branches)
  folds.push({heldOut,model:fitted,trades,summary:summarize(trades)})
  console.log(`Held out ${heldOut}: ${trades.length} trades, ${trades.filter(t=>t.targetHit).length} target hits`)
}
const cv=folds.flatMap(f=>f.trades)
const result={method:{window:'Actual signal availability 09:17 through 09:40 IST; last observed bar is one minute earlier',history:'Exactly two prior stock sessions plus current candles through decision; recursive indicators reseeded within that history',entry:'Next completed one-minute candle close, one minute after signal availability',exit:'2% target, otherwise next completed candle close after bullish EMA20/40 cross, or session close; no stop-loss specified',firstTrigger:'At most one signal per stock-day; earliest matching OR branch',search:'Training labels are the last listed ten winners. Up to 3 OR branches, each up to 3 AND thresholds; no stock/date/clock predicates; bounded beam search, not exhaustive',costs:'Gross price returns and illustrative 20 bps round-trip sensitivity; portfolio returns not implied by summed trades',validation:'Five leave-one-date-out fits; repeated research on these dates means this is exploratory, not untouched forward validation',limitations:'Historical candles can contain later provider corrections. Depth summaries reuse existing parser and are only supplemental. Target candle full high is conservatively counted in MAE; intrabar path is unavailable.'},definitions:{priorDayTail20Return:'100 * (last close of previous session / open of its last 20 regular-session candles - 1)',distancePrior60Low:'100 * (latest close / minimum low of the previous session last 60 regular-session candles - 1)',ema10_20Gap:'100 * (EMA10 - EMA20) / latest close; EMAs seeded only inside the two previous sessions',windowRange:'100 * (highest high - lowest low) / first open over the last up to 5 current-session completed candles',pviNviAverageDrop:'Mean percentage decline in PVI and NVI over the prior final positive-volume candle and current 09:15/09:16 candles; frozen at 09:17',last5Return:'100 * (latest close / close five regular-session candles earlier - 1); spans session boundary near the open and includes the overnight gap'},dataset:built.file,feasibility,model,summary:summarize(selected),selected,heldOutSummary:summarize(cv),folds}
result.emaOnlySummary={tradeCount:selected.length,winRatePct:rnd(100*selected.filter(t=>t.emaExitReturnPct>0).length/selected.length),averageReturnPct:rnd(avg(selected.map(t=>t.emaExitReturnPct))),totalReturnPct:rnd(selected.reduce((s,t)=>s+t.emaExitReturnPct,0)),lossCountAfter20Bps:selected.filter(t=>t.emaExitReturnPct-.2<=0).length}
const json=unique('json'),md=unique('md')
fs.writeFileSync(json,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
const rules=model.branches.map((rs,i)=>`Branch ${i+1}: `+rs.map(r=>`${r.feature} ${r.op==='lt'?'<':'>'} ${r.threshold}`).join(' AND ')).join('\n\nOR\n\n')
const table=['| Date | Stock | Signal available | Entry | Branch | Exit | Return | MAE |','|---|---|---|---|---:|---|---:|---:|',...selected.map(t=>`| ${t.date} | ${t.symbol} | ${t.signalTime} | ${t.entryTime} | ${t.branch} | ${t.exitReason} | ${t.grossReturnPct}% | ${t.maePct}% |`)].join('\n')
fs.writeFileSync(md,[`# Three OR branches, 09:17–09:40`, '', 'This is a retrospective fit to the supplied 50 candidates and ten requested winners. It is not a promise of no future losses.', '', rules,'',...Object.entries(result.definitions).map(([k,v])=>`${k}: ${v}`),'',table,'',`Full sample: ${JSON.stringify(result.summary)}`,'',`EMA-cross-only exit: ${JSON.stringify(result.emaOnlySummary)}`,'',`Held-out dates: ${JSON.stringify(result.heldOutSummary)}`,'',...Object.entries(result.method).map(([k,v])=>`${k}: ${v}`),'',`JSON: ${json}`].join('\n')+'\n',{flag:'wx'})
console.log(JSON.stringify({json,md,summary:result.summary,heldOut:result.heldOutSummary,model,selected},null,2))
