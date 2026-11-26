#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { load } from './discover-0920-pvi-nvi-short-filter.js'

const ROOT = process.cwd()
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const FROM = arg('--from') ?? '2026-10-01', TO = arg('--to') ?? '2026-10-30'
const MAX_BRANCHES = Number(arg('--branches') ?? 3)
const MIN_RETURN = Number(arg('--min-return') ?? 0)
if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO) || FROM > TO) throw new Error('Usage: node scripts/research-loosen-ema20-40-filter-october.js [--from YYYY-MM-DD --to YYYY-MM-DD]')
if (!Number.isInteger(MAX_BRANCHES) || MAX_BRANCHES < 1 || MAX_BRANCHES > 12) throw new Error('--branches must be an integer from 1 through 12')
if (!Number.isFinite(MIN_RETURN) || MIN_RETURN < 0) throw new Error('--min-return must be zero or greater')
const round = (x,p=4)=>Number.isFinite(x)?+x.toFixed(p):null
const pct = (x,b)=>Number.isFinite(x)&&Number.isFinite(b)&&b>0?100*(x/b-1):NaN
const mean = xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:NaN
const unique=(stem,ext)=>{let n=1,f;do{f=path.join(ROOT,'reports',`${stem}${n===1?'':`-${n}`}.${ext}`);n++}while(fs.existsSync(f));return f}
const clock=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`
const symbols=fs.readdirSync(path.join(ROOT,'db','candles')).filter(x=>x.endsWith('.jsonl')&&x!=='NIFTY50.jsonl').map(x=>x.slice(0,-6)).sort()
const nifty=load('NIFTY50'), dates=[...new Set(nifty.filter(x=>x.date>=FROM&&x.date<=TO).map(x=>x.date))].sort()

function aggregate(rows,size){
  const bars=[]
  for(const date of [...new Set(rows.map(x=>x.date))]){
    const day=rows.filter(x=>x.date===date), groups=new Map()
    for(const x of day){const off=x.minute-555;if(off<0||off>=375)continue;const key=Math.floor(off/size);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(x)}
    for(const g of groups.values()){g.sort((a,b)=>a.minute-b.minute);if(g.length!==size||g.some((x,i)=>i&&x.minute!==g[i-1].minute+1))continue;bars.push({date,minute:g.at(-1).minute,o:g[0].o,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),c:g.at(-1).c,v:g.reduce((s,x)=>s+x.v,0)})}
  }
  bars.sort((a,b)=>a.date.localeCompare(b.date)||a.minute-b.minute);let e20,e40
  for(const x of bars){e20=e20==null?x.c:e20+2/21*(x.c-e20);e40=e40==null?x.c:e40+2/41*(x.c-e40);x.e20=e20;x.e40=e40}
  return bars
}
const rsi=values=>{if(values.length<15)return NaN;let g=0,l=0;for(let i=values.length-14;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)g+=d;else l-=d}return l?100-100/(1+g/l):100}
const slope=(rows,index,field,n,price,direction)=>{const w=rows.slice(Math.max(0,index-n+1),index+1);if(w.length<n)return NaN;const first=w[0][field],last=w.at(-1)[field];return direction*pct(last,first)}

function outcome(day,index,direction){
  const entryIndex=index+1,entry=day[entryIndex];if(!entry)return null
  let exitIndex=day.length-1,exitReason='EOD'
  for(let i=entryIndex;i<day.length;i++){const p=day[i-1],x=day[i],opp=direction>0?p.ema[20]>=p.ema[40]&&x.ema[20]<x.ema[40]:p.ema[20]<=p.ema[40]&&x.ema[20]>x.ema[40];if(opp){exitIndex=i;exitReason='OPPOSITE_CROSS_CLOSE';break}}
  const exit=day[exitIndex],held=day.slice(entryIndex,exitIndex+1)
  return {entryTime:clock(entry.minute),entryPrice:entry.o,exitTime:clock(exit.minute),exitPrice:exit.c,exitReason,returnPct:direction*pct(exit.c,entry.o),mfePct:direction>0?Math.max(...held.map(x=>pct(x.h,entry.o))):Math.max(...held.map(x=>pct(entry.o,x.l))),maePct:direction>0?Math.min(...held.map(x=>pct(x.l,entry.o))):Math.min(...held.map(x=>pct(entry.o,x.h)))}
}

function candidateFeatures(symbol,rows,tf,date,day,index,side,out){
  const direction=side==='BUY'?1:-1,signal=day[index],observed=day.slice(0,index+1),prior20=day.slice(Math.max(0,index-20),index)
  const avgVol=mean(prior20.map(x=>x.v)),absDistance=Math.abs(pct(signal.c,signal.ema[20])),volumeRatio=signal.v/(avgVol||1)
  if(absDistance<.4||volumeRatio<10)return null
  const high=Math.max(...observed.map(x=>x.h)),low=Math.min(...observed.map(x=>x.l)),position=direction>0?100*(signal.c-low)/(high-low||1):100*(high-signal.c)/(high-low||1)
  const w20=observed.slice(-20),path=w20.slice(1).reduce((s,x,i)=>s+Math.abs(x.c-w20[i].c),0),eff=direction*100*(signal.c-w20[0].c)/(path||1)
  const ret=n=>index>=n?direction*pct(signal.c,day[index-n].c):NaN
  const niftyDay=nifty.filter(x=>x.date===date),ni=niftyDay.findIndex(x=>x.minute===signal.minute),nret=n=>ni>=n?direction*pct(niftyDay[ni].c,niftyDay[ni-n].c):NaN
  const sv=observed.reduce((s,x)=>s+x.v,0),vwap=observed.reduce((s,x)=>s+x.v*(x.h+x.l+x.c)/3,0)/(sv||1),range=signal.h-signal.l
  const prev20=day.slice(Math.max(0,index-20),index),prev60=day.slice(Math.max(0,index-60),index),opening=day.slice(0,15)
  const breakout=w=>!w.length?NaN:direction>0?pct(signal.c,Math.max(...w.map(x=>x.h))):pct(Math.min(...w.map(x=>x.l)),signal.c)
  const values=rows.filter(x=>x.date<date||(x.date===date&&x.minute<=signal.minute)).map(x=>x.c),rr=rsi(values)
  const features={
    signalMinute:signal.minute,minutesTo1500:900-signal.minute,absDistance,volumeRatio,sessionPosition:position,efficiency20:eff,
    return3:ret(3),return5:ret(5),return10:ret(10),return15:ret(15),return30:ret(30),relative5:ret(5)-nret(5),relative15:ret(15)-nret(15),relative30:ret(30)-nret(30),
    fromOpen:direction*pct(signal.c,day[0].o),priceVwap:direction*pct(signal.c,vwap),rsiDirectional:direction>0?rr:100-rr,
    signalBody:direction*100*(signal.c-signal.o)/signal.o,signalCloseLocation:direction>0?100*(signal.c-signal.l)/(range||1):100*(signal.h-signal.c)/(range||1),
    prior20Break:breakout(prev20),prior60Break:breakout(prev60),opening15Break:breakout(opening),
  }
  // load() nests EMA values; calculate the two useful slopes explicitly.
  features.ema20Slope5=index>=4?direction*pct(signal.ema[20],day[index-4].ema[20]):NaN
  features.ema40Slope10=index>=9?direction*pct(signal.ema[40],day[index-9].ema[40]):NaN
  for(const size of [3,5,10,15]){const bars=tf[size].filter(x=>x.date<date||(x.date===date&&x.minute<=signal.minute)),last=bars.at(-1),back=bars.at(-4);features[`tf${size}Aligned`]=last&&direction*(last.e20-last.e40)>0?1:0;features[`tf${size}PriceEma20`]=last?direction*pct(last.c,last.e20):NaN;features[`tf${size}Return3`]=last&&back?direction*pct(last.c,back.c):NaN}
  return {date,symbol,side,signalTime:clock(signal.minute),...out,...Object.fromEntries(Object.entries(features).map(([k,v])=>[k,round(v)]))}
}

const candidates=[]
for(const [si,symbol] of symbols.entries()){
  if(si%25===0)process.stdout.write(`\rLoading ${si}/${symbols.length} symbols...`)
  const rows=load(symbol),tf=Object.fromEntries([3,5,10,15].map(n=>[n,aggregate(rows,n)]))
  for(const date of dates){const day=rows.filter(x=>x.date===date);for(let i=1;i<day.length-1;i++){const p=day[i-1],x=day[i],buy=p.ema[20]<=p.ema[40]&&x.ema[20]>x.ema[40],sell=p.ema[20]>=p.ema[40]&&x.ema[20]<x.ema[40];if(!buy&&!sell)continue;const side=buy?'BUY':'SELL',out=outcome(day,i,buy?1:-1);if(!out)continue;const row=candidateFeatures(symbol,rows,tf,date,day,i,side,out);if(row)candidates.push(row)}}
}
console.log(`\rLoaded ${symbols.length}/${symbols.length} symbols; ${candidates.length} base candidates.`)

// Rounded thresholds only. No symbol, date, exact return, MFE, or MAE is usable.
const grids={
  signalMinute:[600,630,660,690,720,750,780,810,840,870,900],sessionPosition:[70,80,85,90,92,95,97,98],efficiency20:[0,10,20,30,40,50,58,60,65,70,75],
  return5:[0,.25,.5,.75,1],return15:[0,.5,.75,1,1.25,1.5,2],return30:[0,.5,1,1.5,2,3],relative5:[0,.25,.5,1],relative15:[0,.25,.5,.75,1,1.25],relative30:[0,.5,1,1.5],
  fromOpen:[0,.5,1,1.5,2,3],priceVwap:[0,.25,.5,.75,1,1.5,2],rsiDirectional:[50,55,60,65,70,75,80,85,90],ema20Slope5:[0,.01,.02,.03,.05,.1],ema40Slope10:[0,.01,.02,.03,.05],
  signalBody:[0,.1,.2,.4,.6,1],signalCloseLocation:[50,60,70,80,90,95],prior20Break:[0,.1,.25,.5,1],prior60Break:[0,.1,.25,.5,1],opening15Break:[0,.25,.5,1],
  tf3Aligned:[1],tf5Aligned:[1],tf10Aligned:[1],tf15Aligned:[1],tf3PriceEma20:[0,.25,.5,1],tf5PriceEma20:[0,.25,.5,1],tf10PriceEma20:[0,.25,.5,1],tf15PriceEma20:[0,.25,.5,1],
}
const conditions=[]
for(const [feature,thresholds] of Object.entries(grids))for(const threshold of thresholds)for(const op of ['>=','<='])conditions.push({feature,op,threshold,pass:x=>Number.isFinite(x[feature])&&(op==='>='?x[feature]>=threshold:x[feature]<=threshold)})
const positive=x=>x.returnPct>=MIN_RETURN
const useful=conditions.map(c=>{const selected=candidates.filter(c.pass),tp=selected.filter(positive).length,fp=selected.length-tp;return{...c,tp,fp}}).filter(c=>c.tp>=2&&c.tp+c.fp<=120).sort((a,b)=>a.fp-b.fp||b.tp-a.tp).slice(0,350)
const clean=[]
for(let i=0;i<useful.length;i++)for(let j=i+1;j<useful.length;j++){const selected=candidates.filter(x=>useful[i].pass(x)&&useful[j].pass(x)),wins=selected.filter(positive);if(selected.length>=2&&selected.length===wins.length)clean.push({conditions:[useful[i],useful[j]],selected:wins})}
const triplePool=useful.slice(0,220)
for(let i=0;i<triplePool.length;i++)for(let j=i+1;j<triplePool.length;j++){
  const pairSelected=candidates.filter(x=>triplePool[i].pass(x)&&triplePool[j].pass(x)),pairWins=pairSelected.filter(positive)
  if(pairWins.length<2||pairSelected.length>30||pairSelected.length===pairWins.length)continue
  for(let k=0;k<triplePool.length;k++){
    if(k===i||k===j)continue
    const selected=pairSelected.filter(triplePool[k].pass),wins=selected.filter(positive)
    if(selected.length>=2&&selected.length===wins.length)clean.push({conditions:[triplePool[i],triplePool[j],triplePool[k]],selected:wins})
  }
}
clean.sort((a,b)=>b.selected.length-a.selected.length)
const branches=[];const covered=new Set()
for(const rule of clean){const fresh=rule.selected.filter(x=>!covered.has(`${x.date}|${x.symbol}|${x.signalTime}`));if(fresh.length<2)continue;branches.push(rule);for(const x of rule.selected)covered.add(`${x.date}|${x.symbol}|${x.signalTime}`);if(branches.length===MAX_BRANCHES)break}
const selected=[...new Map(branches.flatMap(b=>b.selected).map(x=>[`${x.date}|${x.symbol}|${x.signalTime}`,x])).values()].sort((a,b)=>a.date.localeCompare(b.date)||a.signalTime.localeCompare(b.signalTime))
const compactCondition=c=>({feature:c.feature,op:c.op,threshold:c.threshold})
const summary={minimumReturnPct:MIN_RETURN,baseCandidates:candidates.length,qualifiedBase:candidates.filter(positive).length,selected:selected.length,winRatePct:selected.length?100:null,averageReturnPct:round(mean(selected.map(x=>x.returnPct))),totalReturnPct:round(selected.reduce((s,x)=>s+x.returnPct,0)),maximumAdverseExcursionPct:selected.length?round(Math.min(...selected.map(x=>x.maePct))):null,daysWithSignals:new Set(selected.map(x=>x.date)).size}
const result={warning:`Outcome-fitted discovery. All selected returns are at least ${MIN_RETURN}%, in-sample; this is not a guarantee. Freeze these branches and test untouched dates.`,dates,summary,branches:branches.map(b=>({conditions:b.conditions.map(compactCondition),selectedCount:b.selected.length})),signals:selected.map(x=>({date:x.date,symbol:x.symbol,side:x.side,signalTime:x.signalTime,entryTime:x.entryTime,entryPrice:x.entryPrice,exitTime:x.exitTime,exitPrice:x.exitPrice,returnPct:round(x.returnPct),mfePct:round(x.mfePct),maePct:round(x.maePct)})),candidates}
const file=unique(`${FROM}-to-${TO}-ema20-40-looser-zero-loss-discovery`,'json');fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({file,warning:result.warning,summary,branches:result.branches,signals:result.signals},null,2))
