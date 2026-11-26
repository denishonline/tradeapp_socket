const fs=require('fs'),path=require('path');
const j=JSON.parse(fs.readFileSync('reports/2026-10-22-0930-five-factor-strength-ranking.json','utf8'));
const ist=t=>new Date(Number(t)*1000+330*60000), cache=new Map();
function rows(sym){if(!cache.has(sym)){const f=path.join('db','candles',`${sym.replace(/-EQ$/,'')}.jsonl`);cache.set(sym,fs.readFileSync(f,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(r=>{const d=ist(r.time);return {date:d.toISOString().slice(0,10),m:d.getUTCHours()*60+d.getUTCMinutes(),c:+r.close};}));}return cache.get(sym)}
function ema(a,p){const k=2/(p+1);let e=a[0];for(const x of a.slice(1))e=x*k+e*(1-k);return e}
const out=j.ranking.slice(0,20).map(t=>{const pre=rows(t.symbol).filter(x=>x.date==='2026-10-22'&&x.m<570).map(x=>x.c);const e9=ema(pre,9),e45=ema(pre,45),e200=ema(pre,200);return {rank:t.rank,symbol:t.symbol,score:t.totalScore,ema45to9Pct:+(100*(e9/e45-1)).toFixed(4),ema45to200Pct:+(100*(e45/e200-1)).toFixed(4)}});
fs.writeFileSync('csv/2026-10-22-top20-ema-gap-expansion.csv',['rank,symbol,score,ema45to9Pct,ema45to200Pct',...out.map(x=>Object.values(x).join(','))].join('\n')+'\n'); console.log(out);
