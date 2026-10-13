const fs=require('fs'), path=require('path');
const OFFSET=330*60000;
const dateKey=at=>new Date(at+OFFSET).toISOString().slice(0,10);
const timeKey=at=>new Date(at+OFFSET).toISOString().slice(11,16);
const [head,...lines]=fs.readFileSync('csv/2026-10-05-to-13-revised-absorption-strategy-backtest.csv','utf8').trim().split(/\r?\n/); const h=head.split(',');
const signals=lines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[h[i],v])));
const cache=new Map();
function candles(sym,date){const k=sym+'|'+date;if(cache.has(k))return cache.get(k);const rows=fs.readFileSync(path.join('db','candles',sym+'.jsonl'),'utf8').split(/\r?\n/).flatMap(x=>{if(!x)return[];try{const q=JSON.parse(x),at=Number(q.time)*1000;return dateKey(at)===date?[{at,open:+q.open,high:+q.high,low:+q.low,close:+q.close}]:[]}catch{return[]}}).sort((a,b)=>a.at-b.at);cache.set(k,rows);return rows;}
function simulate(s,{arm,trail,lock}){const entry=+s.entry, rows=candles(s.symbol,s.date), idx=rows.findIndex(x=>timeKey(x.at)===s.signalTime);let armed=false,peak=entry;for(const c of rows.slice(idx+1)){if(!armed){if(c.low<=entry*.996)return {ret:-.4,kind:'stop',exitTime:timeKey(c.at),exitPrice:entry*.996};if(c.high>=entry*(1+arm/100)){armed=true;peak=c.high;}continue;}const stop=Math.max(entry*(1+lock/100),peak*(1-trail/100));if(c.low<=stop)return {ret:(stop/entry-1)*100,kind:'trail',exitTime:timeKey(c.at),exitPrice:stop};peak=Math.max(peak,c.high);}const last=rows.at(-1);return {ret:(last.close/entry-1)*100,kind:armed?'eod-armed':'eod-unarmed',exitTime:timeKey(last.at),exitPrice:last.close};}
const tests=[];for(const arm of [1,1.5])for(const trail of [.5,.75,1])for(const lock of [.4,.75,1]){if(lock>=arm)continue;const out=signals.map(s=>simulate(s,{arm,trail,lock}));tests.push({arm,trail,lock,total:+out.reduce((a,b)=>a+b.ret,0).toFixed(3),avg:+(out.reduce((a,b)=>a+b.ret,0)/out.length).toFixed(3),positive:out.filter(x=>x.ret>0).length,stops:out.filter(x=>x.kind==='stop').length,min:+Math.min(...out.map(x=>x.ret)).toFixed(3)});}tests.sort((a,b)=>b.total-a.total);console.table(tests);
fs.writeFileSync('csv/2026-10-05-to-13-revised-absorption-exit-audit.json',JSON.stringify({fixedTarget:{targetPct:1.5,stopPct:.4,total:37.5,positive:25},trailing:tests},null,2)+'\n');
const best={arm:1.5,trail:1,lock:.4};
const detail=signals.map(s=>{const x=simulate(s,best);return {...s,trailingExit:x.kind,trailingExitTime:x.exitTime,trailingExitPrice:x.exitPrice.toFixed(4),trailingReturnPct:x.ret.toFixed(3)}});
const cols=[...h,'trailingExit','trailingExitTime','trailingExitPrice','trailingReturnPct'];
fs.writeFileSync('csv/2026-10-05-to-13-revised-absorption-trailing-results.csv',[cols.join(','),...detail.map(r=>cols.map(c=>r[c]??'').join(','))].join('\n')+'\n');
