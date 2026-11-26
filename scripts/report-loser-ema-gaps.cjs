const fs=require('fs'),path=require('path');
const report=JSON.parse(fs.readFileSync('reports/2026-10-12-to-2026-10-16-top20-adx-cmf-atr-report.json','utf8'));
const ist=t=>new Date(Number(t)*1000+330*60000),cache=new Map();
function rows(sym){if(!cache.has(sym)){const f=path.join('db','candles',`${sym.replace(/-EQ$/,'')}.jsonl`);cache.set(sym,fs.readFileSync(f,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(r=>{const d=ist(r.time);return {date:d.toISOString().slice(0,10),m:d.getUTCHours()*60+d.getUTCMinutes(),close:+r.close};}));}return cache.get(sym)}
function ema(a,p){const k=2/(p+1);let e=a[0];for(const x of a.slice(1))e=x*k+e*(1-k);return e}
function calc(sym,date){const all=rows(sym), pre=all.filter(x=>x.date<date||(x.date===date&&x.m<570));if(!pre.length)return null;const c=pre.map(x=>x.close),e9=ema(c,9),e45=ema(c,45),e200=ema(c,200);return {ema9:e9,ema45:e45,ema200:e200,gap45to9Pct:100*(e9/e45-1),gap45to200Pct:100*(e45/e200-1)};}
const allTrades=report.trades.map(t=>({...t,...calc(t.symbol,t.date)})).filter(t=>t.ema9);
const losers=allTrades.filter(t=>t.returnPct<=0);
const cols=['date','symbol','returnPct','exitType','ema9','ema45','ema200','gap45to9Pct','gap45to200Pct'];
const rnd=x=>Number(x.toFixed(4));
fs.writeFileSync('csv/2026-10-12-to-2026-10-16-losers-ema45-gap-expansion.csv',[cols.join(','),...losers.map(t=>[t.date,t.symbol,t.returnPct,t.exitType,rnd(t.ema9),rnd(t.ema45),rnd(t.ema200),rnd(t.gap45to9Pct),rnd(t.gap45to200Pct)].join(','))].join('\n')+'\n');
const kept=allTrades.filter(t=>t.gap45to200Pct>=0), removed=allTrades.filter(t=>t.gap45to200Pct<0), stats=a=>{const s=a.reduce((x,t)=>x+t.returnPct,0),w=a.filter(t=>t.returnPct>0).length;return {trades:a.length,winners:w,losers:a.length-w,winRatePct:rnd(100*w/(a.length||1)),averageReturnPct:rnd(s/(a.length||1)),totalReturnPct:rnd(s)}};
const summary={all:stats(allTrades),kept:stats(kept),removed:stats(removed),removedSymbols:removed.map(t=>({date:t.date,symbol:t.symbol,returnPct:t.returnPct,gap45to200Pct:rnd(t.gap45to200Pct)}))};
fs.writeFileSync('reports/2026-10-12-to-2026-10-16-ema45-200-negative-gap-test.json',JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
