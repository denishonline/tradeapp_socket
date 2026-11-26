import fs from 'node:fs'
import path from 'node:path'
const root = process.cwd(), date = '2026-10-22'
const groups = { selected: ['BAJAJHLDNG','BAJFINANCE','KAYNES','INDHOTEL','BAJAJ-AUTO','UNOMINDA'], comparison: ['ETERNAL','DELHIVERY','GLAND','KOTAKBANK'] }
const pairs = [[5,10],[7,15],[9,20],[10,20],[20,45],[9,45]]
const ist = t => new Date(Number(t)*1000+330*60_000)
function rows(symbol){const f=path.join(root,'db','candles',`${symbol}.jsonl`), out=[];for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){if(!line.trim())continue;let r;try{r=JSON.parse(line)}catch{continue};const d=ist(r.time),day=d.toISOString().slice(0,10),m=d.getUTCHours()*60+d.getUTCMinutes();if(day===date&&m>=555&&m<570&&Number.isFinite(+r.close))out.push(+r.close)}return out}
function ema(values,n){let x=values[0];for(let i=1;i<values.length;i++)x=2/(n+1)*values[i]+(n-1)/(n+1)*x;return x}
const stockRows=[]
for(const group of Object.keys(groups))for(const symbol of groups[group]){const c=rows(symbol), metrics={};for(const [fast,slow] of pairs){const gap=100*(ema(c,fast)/ema(c,slow)-1);metrics[`${fast}/${slow}`]={gapPct:gap, bullish:gap>0}}const score=Object.values(metrics).filter(x=>x.bullish).length*10;stockRows.push({group,symbol,score,metrics})}
const summary={};for(const group of Object.keys(groups)){const rs=stockRows.filter(r=>r.group===group);summary[group]={total:rs.reduce((s,r)=>s+r.score,0),average:rs.reduce((s,r)=>s+r.score,0)/rs.length,passing:Object.fromEntries(pairs.map(([f,s])=>{const key=`${f}/${s}`;return [key,rs.filter(r=>r.metrics[key].bullish).map(r=>r.symbol)]}))}}
let n=1,file;do{file=path.join(root,'reports',`${date}-ema-pair-selected-vs-top10${n===1?'':`-${n}`}.json`);n++}while(fs.existsSync(file));fs.writeFileSync(file,JSON.stringify({date,windowIST:'09:15-09:29',pairs,scoring:'10 points per EMA pair when fast EMA > slow EMA at 09:29; six pairs = 60 points.',summary,stocks:stockRows},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file,summary,stocks:stockRows},null,2))
