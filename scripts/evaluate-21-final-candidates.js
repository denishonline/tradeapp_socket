import fs from 'node:fs'
import path from 'node:path'
const root=process.cwd(), date=process.argv[2]??'2026-10-21'
const filterFile=fs.readdirSync(path.join(root,'reports')).filter(f=>f.startsWith(`${date}-top20-final-strength-filter`)&&f.endsWith('.json')).map(f=>({f,mtime:fs.statSync(path.join(root,'reports',f)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime)[0]?.f
if(!filterFile) throw new Error(`No filter report for ${date}`)
const report=JSON.parse(fs.readFileSync(path.join(root,'reports',filterFile)))
const ist=t=>new Date(Number(t)*1000+330*60_000)
const out=[]
for(const c of report.filtered){const symbol=c.symbol.replace(/-EQ$/,''),file=path.join(root,'db','candles',`${symbol}.jsonl`),rows=[];for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){if(!line.trim())continue;let r;try{r=JSON.parse(line)}catch{continue};const d=ist(r.time),day=d.toISOString().slice(0,10),m=d.getUTCHours()*60+d.getUTCMinutes();if(day===date&&m>=570&&[r.open,r.high,r.low,r.close].every(x=>Number.isFinite(+x)))rows.push({minute:m,open:+r.open,high:+r.high,low:+r.low,close:+r.close})}const entry=rows[0],last=rows.at(-1);if(!entry||!last)continue;out.push({...c,entryOpen:entry.open,exitClose:last.close,returnPct:100*(last.close/entry.open-1),maePct:100*(Math.min(...rows.map(x=>x.low))/entry.open-1),mfePct:100*(Math.max(...rows.map(x=>x.high))/entry.open-1),bars:rows.length})}
const trades=out.map(x=>({symbol:x.symbol,score:x.totalScore,entryOpen:x.entryOpen,exitClose:x.exitClose,returnPct:+x.returnPct.toFixed(3),maePct:+x.maePct.toFixed(3),mfePct:+x.mfePct.toFixed(3),bars:x.bars}))
const reportOut={date,entryRule:'09:30 open of the next completed one-minute candle after the 09:15-09:29 screen',exitRule:'session close; no SL/target assumed',tradeCount:trades.length,winRatePct:100*trades.filter(x=>x.returnPct>0).length/(trades.length||1),averageReturnPct:trades.reduce((s,x)=>s+x.returnPct,0)/(trades.length||1),totalEqualWeightReturnPct:trades.reduce((s,x)=>s+x.returnPct,0),worstMAEPct:Math.min(...trades.map(x=>x.maePct)),trades}
const outputFile=path.join(root,'reports',`${date}-final-strategy-open-to-close-evaluation.json`);fs.writeFileSync(outputFile,JSON.stringify(reportOut,null,2)+'\n',{flag:'w'});console.log(JSON.stringify({outputFile,...reportOut},null,2))
