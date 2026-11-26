#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT=process.cwd(),REPORTS=path.join(ROOT,'reports')
const DATES=['2026-10-01','2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-19','2026-10-21','2026-10-22','2026-10-23','2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30']
const round=(x,p=3)=>Number.isFinite(x)?+x.toFixed(p):null
const minute=s=>{const[h,m]=s.split(':').map(Number);return h*60+m}
const unique=(stem,ext)=>{let n=1,f;do{f=path.join(REPORTS,`${stem}${n===1?'':`-${n}`}.${ext}`);n++}while(fs.existsSync(f));return f}
function latest(date){const prefix=`${date}-top-movers-support-resistance-price-action-mtf-universe-first-signal`;return fs.readdirSync(REPORTS).filter(x=>x.startsWith(prefix)&&x.endsWith('.csv')).map(x=>path.join(REPORTS,x)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]}
function read(date){const file=latest(date);if(!file)throw new Error(`Missing universe CSV for ${date}`);const [head,...lines]=fs.readFileSync(file,'utf8').trim().split(/\r?\n/),names=head.split(',');return lines.map(line=>{const row=Object.fromEntries(line.split(',').map((v,i)=>[names[i],v]));for(const k of ['mtfAligned','signalMoveFromOpenPct','breakoutDistancePct','volumeRatio10','efficiency10','returnToCutoffPct','mfePct','maePct'])row[k]=Number(row[k]);return{...row,date,signalMinute:minute(row.signalTime),correctTargetDirection:row.correctTargetDirection==='true'}})}
const TARGET_PCT=1.10,STOP_PCT=2.00
const rows=DATES.flatMap(read),isWinner=x=>x.mfePct>=TARGET_PCT&&x.maePct>-STOP_PCT
const conditions=[]
const add=(name,test)=>conditions.push({name,test})
for(const side of ['BUY','SELL'])add(`side=${side}`,x=>x.side===side)
for(const family of ['OPENING_RANGE_BREAK','PRIOR_LEVEL_BREAK','LEVEL_RETEST'])add(`family=${family}`,x=>x.family===family)
add('family=BREAK',x=>x.family!=='LEVEL_RETEST')
for(const value of [4,5])add(`mtf>=${value}`,x=>x.mtfAligned>=value)
for(const value of [.5,1,1.5,2,3]){add(`move>=${value}`,x=>x.signalMoveFromOpenPct>=value);add(`move<=${value}`,x=>x.signalMoveFromOpenPct<=value)}
for(const value of [.05,.1,.25,.5,1]){add(`breakout>=${value}`,x=>x.breakoutDistancePct>=value);add(`breakout<=${value}`,x=>x.breakoutDistancePct<=value)}
for(const value of [.75,1,1.5,2,3,5]){add(`volume>=${value}`,x=>x.volumeRatio10>=value);add(`volume<=${value}`,x=>x.volumeRatio10<=value)}
for(const value of [.25,.4,.5,.6,.75,1]){add(`efficiency>=${value}`,x=>x.efficiency10>=value);add(`efficiency<=${value}`,x=>x.efficiency10<=value)}
for(const value of [570,585,600,630,660])add(`time<=${value}`,x=>x.signalMinute<=value)
for(const value of [570,585,600])add(`time>=${value}`,x=>x.signalMinute>=value)

const clean=[],candidates=[]
function consider(selected,cs){
  const wins=selected.filter(isWinner).length,precision=wins/(selected.length||1)
  if(selected.length<5||!selected.some(x=>x.date==='2026-10-15'&&x.correctTargetDirection&&isWinner(x)))return
  candidates.push({conditions:cs,selected,precision,wins})
  if(precision>.90)clean.push({conditions:cs,selected,precision})
}
for(let i=0;i<conditions.length;i++)for(let j=i+1;j<conditions.length;j++){
  const pair=rows.filter(x=>conditions[i].test(x)&&conditions[j].test(x));consider(pair,[conditions[i],conditions[j]])
  if(pair.length>40)continue
  for(let k=j+1;k<conditions.length;k++){
    const triple=pair.filter(conditions[k].test);consider(triple,[conditions[i],conditions[j],conditions[k]])
    if(triple.length>30)continue
    for(let m=k+1;m<conditions.length;m++)consider(triple.filter(conditions[m].test),[conditions[i],conditions[j],conditions[k],conditions[m]])
  }
}
clean.sort((a,b)=>b.selected.length-a.selected.length||b.precision-a.precision||a.conditions.length-b.conditions.length)
const branches=[],covered=new Set()
let union=[]
for(const rule of clean){const fresh=rule.selected.filter(x=>!covered.has(`${x.date}|${x.symbol}|${x.signalTime}`));if(fresh.length<1)continue;const combined=[...new Map([...union,...rule.selected].map(x=>[`${x.date}|${x.symbol}|${x.signalTime}`,x])).values()],precision=combined.filter(isWinner).length/combined.length;if(precision<=.90)continue;branches.push(rule);union=combined;for(const x of rule.selected)covered.add(`${x.date}|${x.symbol}|${x.signalTime}`);if(branches.length===6)break}
const selected=[...new Map(branches.flatMap(x=>x.selected).map(r=>[`${r.date}|${r.symbol}|${r.signalTime}`,r])).values()].sort((a,b)=>a.date.localeCompare(b.date)||a.signalTime.localeCompare(b.signalTime))
const topNearMisses=candidates.sort((a,b)=>b.precision-a.precision||b.selected.length-a.selected.length||a.conditions.length-b.conditions.length).slice(0,10).map(x=>({
  conditions:x.conditions.map(c=>c.name),
  ...metrics(x.selected),
  oct15Signals:x.selected.filter(row=>row.date==='2026-10-15'&&row.correctTargetDirection&&isWinner(row)).map(row=>`${row.symbol} ${row.side} ${row.signalTime}`),
  signals:x.selected.map(row=>({date:row.date,symbol:row.symbol,side:row.side,signalTime:row.signalTime,managedReturnPct:managedReturn(row),mfePct:round(row.mfePct),maePct:round(row.maePct)}))
}))
function managedReturn(x){return isWinner(x)?TARGET_PCT:Math.max(-STOP_PCT,Math.min(TARGET_PCT,x.returnToCutoffPct))}
function metrics(data){const returns=data.map(managedReturn),daily=DATES.map(date=>{const d=data.filter(x=>x.date===date);return{date,trades:d.length,winners:d.filter(isWinner).length,totalReturnPct:round(d.reduce((s,x)=>s+managedReturn(x),0))}});return{tradeCount:data.length,winnersOver1Pct:data.filter(isWinner).length,winRatePct:data.length?round(100*data.filter(isWinner).length/data.length):null,averageReturnPct:data.length?round(returns.reduce((a,b)=>a+b,0)/data.length):null,totalReturnPct:round(returns.reduce((a,b)=>a+b,0)),maximumAdverseExcursionPct:data.length?round(Math.min(...data.map(x=>x.maePct))):null,worstDay:daily.filter(x=>x.trades).sort((a,b)=>a.totalReturnPct-b.totalReturnPct)[0]??null,daily}}
const oct15=selected.filter(x=>x.date==='2026-10-15'&&x.correctTargetDirection),early=selected.filter(x=>x.date<='2026-10-15'),late=selected.filter(x=>x.date>'2026-10-15')
const result={warning:'Rules were outcome-fitted on the full October universe. The >90% figure is in-sample and not independent validation.',method:`Causal S/R break or retest before 10:30; session VWAP aligned; directional close location >=60%; at least 3 aligned completed timeframes from 1/3/5/10/15m; next 1m open entry; +${TARGET_PCT}% target and -${STOP_PCT}% stop. Winner audit is conservative: MFE must reach target and full-path MAE must never breach the stop. Branches add only signal-time MTF, move, breakout, volume, efficiency, side, family and clock thresholds.`,rawSignals:rows.length,rawWinRatePct:round(100*rows.filter(isWinner).length/rows.length),branches:branches.map(b=>({conditions:b.conditions.map(x=>x.name),selectedCount:b.selected.length})),summary:metrics(selected),oct15:{signals:oct15.map(x=>({symbol:x.symbol,side:x.side,signalTime:x.signalTime,entryTime:x.entryTime,entryPrice:+x.entryPrice,targetPrice:round(+x.entryPrice*(x.side==='BUY'?1+TARGET_PCT/100:1-TARGET_PCT/100)),stopPrice:round(+x.entryPrice*(x.side==='BUY'?1-STOP_PCT/100:1+STOP_PCT/100)),managedReturnPct:managedReturn(x),mfePct:round(x.mfePct),maePct:round(x.maePct)})),summary:metrics(oct15)},chronologicalDiagnostic:{throughOct15:metrics(early),afterOct15:metrics(late)},signals:selected.map(x=>({date:x.date,symbol:x.symbol,side:x.side,family:x.family,level:x.level,signalTime:x.signalTime,entryTime:x.entryTime,entryPrice:+x.entryPrice,targetPrice:round(+x.entryPrice*(x.side==='BUY'?1+TARGET_PCT/100:1-TARGET_PCT/100)),stopPrice:round(+x.entryPrice*(x.side==='BUY'?1-STOP_PCT/100:1+STOP_PCT/100)),managedReturnPct:managedReturn(x),mfePct:round(x.mfePct),maePct:round(x.maePct)}))}
result.topNearMisses=topNearMisses
const json=unique('2026-10-15-movers-to-october-high-precision-sr-mtf','json'),csv=unique('2026-10-15-movers-to-october-high-precision-sr-mtf-signals','csv');fs.writeFileSync(json,JSON.stringify(result,null,2)+'\n',{flag:'wx'});const fields=['date','symbol','side','family','level','signalTime','entryTime','entryPrice','targetPrice','stopPrice','managedReturnPct','mfePct','maePct'];fs.writeFileSync(csv,[fields.join(','),...result.signals.map(x=>fields.map(k=>x[k]).join(','))].join('\n')+'\n',{flag:'wx'});console.log(JSON.stringify({json,csv,rawSignals:result.rawSignals,rawWinRatePct:result.rawWinRatePct,branches:result.branches,summary:result.summary,oct15:result.oct15,chronologicalDiagnostic:result.chronologicalDiagnostic,signals:result.signals},null,2))
