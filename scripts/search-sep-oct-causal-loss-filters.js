#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT=process.cwd(),REPORTS=path.join(ROOT,'reports')
const periods=[['2026-09-01','2026-09-30'],['2026-10-01','2026-10-30']]
function latest(from,to){const prefix=`${from}-to-${to}-sr-mtf-high-precision`;return fs.readdirSync(REPORTS).filter(name=>name.startsWith(prefix)&&name.endsWith('.json')).map(name=>path.join(REPORTS,name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]}
const rows=periods.flatMap(([from,to])=>{const file=latest(from,to);if(!file)throw new Error(`Missing report ${from} to ${to}`);return JSON.parse(fs.readFileSync(file,'utf8')).signals})
const minute=value=>{const[h,m]=value.split(':').map(Number);return h*60+m}
const good=row=>+row.returnPct>=1
const conditions=[]
const add=(name,test,group)=>conditions.push({name,test,group})
for(const side of ['BUY','SELL'])add(`side=${side}`,row=>row.side===side,'side')
for(const family of ['OPENING_RANGE_BREAK','LEVEL_RETEST','PRIOR_LEVEL_BREAK'])add(`family=${family}`,row=>row.family===family,'family')
for(const value of [4,5])add(`mtf=${value}`,row=>+row.mtfAligned===value,'mtf')
add('tf15=true',row=>row.tf15===true,'tf15');add('tf15=false',row=>row.tf15!==true,'tf15')
for(const prefix of ['OR5','OR10','OR15','PRIOR'])add(`level=${prefix}`,row=>prefix==='PRIOR'?!String(row.level).startsWith('OR'):String(row.level).startsWith(prefix),'level')
const numeric=[
  ['move','signalMoveFromOpenPct',[1.6,1.7,2,2.2,2.5,3]],
  ['breakout','breakoutDistancePct',[.16,.18,.2,.22]],
  ['volume','volumeRatio10',[.5,.75,1,1.25,1.5,2,2.5,3]],
  ['efficiency','efficiency10',[.25,.35,.45,.55,.65,.75,.85,.95]],
  ['time','signalTime',[570,575,585,600]],
]
for(const[label,key,values]of numeric)for(const value of values){const read=row=>key==='signalTime'?minute(row[key]):+row[key];add(`${label}>=${value}`,row=>read(row)>=value,`${label}Min`);add(`${label}<=${value}`,row=>read(row)<=value,`${label}Max`)}

const candidates=[]
function consider(indexes){const selected=rows.filter(row=>indexes.every(index=>conditions[index].test(row))),bad=selected.filter(row=>!good(row)),kept=selected.filter(good);if(!bad.length||kept.length)return;candidates.push({conditions:indexes.map(index=>conditions[index].name),rejected:bad.map(row=>`${row.date}|${row.symbol}`)})}
for(let i=0;i<conditions.length;i++){consider([i]);for(let j=i+1;j<conditions.length;j++){if(conditions[i].group===conditions[j].group)continue;consider([i,j]);for(let k=j+1;k<conditions.length;k++){if(new Set([conditions[i].group,conditions[j].group,conditions[k].group]).size<3)continue;consider([i,j,k])}}}
const unique=new Map(candidates.map(candidate=>[`${candidate.rejected.sort().join(',')}|${candidate.conditions.length}`,candidate]))
const ranked=[...unique.values()].sort((a,b)=>b.rejected.length-a.rejected.length||a.conditions.length-b.conditions.length)
const badRows=rows.filter(row=>!good(row)),goodRows=rows.filter(good)
console.log(JSON.stringify({trades:rows.length,nonnegative:goodRows.length,negative:badRows.map(row=>({date:row.date,symbol:row.symbol,side:row.side,returnPct:row.returnPct})),zeroGoodRejectionRules:ranked.slice(0,50)},null,2))
