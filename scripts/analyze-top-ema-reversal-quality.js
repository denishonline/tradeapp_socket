import fs from 'node:fs'
import path from 'node:path'
const root=process.cwd(), date=process.argv[2]??'2026-10-19'
const latest=pattern=>fs.readdirSync(path.join(root,'reports')).filter(n=>pattern.test(n)).map(n=>path.join(root,'reports',n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0]
const reversalFile=latest(new RegExp(`^${date}-0930-top-ema-gap-depth-reversals.*\\.json$`)), gapFile=latest(new RegExp(`^${date}-0930-ema9-ema45-vs-prior5.*\\.json$`))
if(!reversalFile||!gapFile)throw new Error('Missing reversal or EMA-gap report')
const reversals=JSON.parse(fs.readFileSync(reversalFile,'utf8')).eligible, gaps=new Map(JSON.parse(fs.readFileSync(gapFile,'utf8')).rows.map(x=>[x.symbol,x]))
const stamp=e=>new Date(e*1000+330*60_000).toISOString().slice(0,16).replace('T',' '),round=(x,p=4)=>Number(x.toFixed(p)),pct=(a,b)=>100*(a/b-1)
function rows(symbol){const file=path.join(root,'db','candles',`${symbol}.jsonl`),m=new Map();for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line.trim())continue;let r;try{r=JSON.parse(line)}catch{continue};const t=stamp(+r.time);if(t.slice(0,10)===date)m.set(t,{time:t,close:+r.close,high:+r.high,low:+r.low})}return [...m.values()].sort((a,b)=>a.time.localeCompare(b.time))}
const output=[]
for(const signal of reversals){const candles=rows(signal.symbol),i=candles.findIndex(x=>x.time===signal.entryTime),d=signal.reverseDirection==='BUY'?1:-1,entry=candles[i]?.close;if(i<0)continue;const at=n=>candles[Math.min(i+n,candles.length-1)],ret=n=>round(d*pct(at(n).close,entry)),path=candles.slice(i+1),mfe=round(Math.max(0,...path.map(x=>d*(d===1?pct(x.high,entry):-pct(x.low,entry))))),mae=round(Math.min(0,...path.map(x=>d*(d===1?pct(x.low,entry):-pct(x.high,entry))))),gap=gaps.get(signal.symbol);output.push({symbol:signal.symbol,side:signal.reverseDirection,signalTime:signal.signalTime,entryTime:signal.entryTime,gapExpansionPct:gap?.gapExpansionPct,absoluteGapPct:gap?.absoluteGapPct,depthShare:signal.depthDirectionalSharePct,depthMidpointMovePct:signal.depthMidpointMovePct,return5mPct:ret(5),return15mPct:ret(15),endOfDayReturnPct:ret(candles.length-1-i),maximumFavorablePct:mfe,maximumAdversePct:mae})}
console.table(output);console.log(JSON.stringify({reversalFile,gapFile,output},null,2))
