import fs from 'fs';
import path from 'path';

const DATE = '2026-11-23';
const PROFIT_GATE = 0.02;
const signals = [['RVNL','09:20'],['CHOLAFIN','09:20'],['ADANIPORTS','09:21'],['ADANIENSOL','09:21'],['ADANIENT','09:21'],['ADANIGREEN','09:21'],['FEDERALBNK','09:22'],['AUBANK','09:23'],['NTPC','09:25'],['INDUSINDBK','09:25']];
const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
const minute = c => formatter.format(new Date(c.time * 1000)).replace(' ','T').slice(11);
const round = n => Number(n.toFixed(2));
function bars(symbol) { return fs.readFileSync(path.join('db','candles',`${symbol}.jsonl`),'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(c => formatter.format(new Date(c.time * 1000)).startsWith(DATE)); }
function ema(values, period) { const a=2/(period+1); let e=values[0]; return values.map((v,i)=>e=i===0?v:v*a+e*(1-a)); }
function result(symbol,entryTime,entry,stop,exitTime,exit,reason,gateTime,mae) { return {symbol,entryTime,entry:round(entry),stop:round(stop),profitGateTime:gateTime||'',exitTime,exit:round(exit),reason,returnPct:Number(((entry/exit-1)*100).toFixed(3)),maxAdversePct:Number(mae.toFixed(3))}; }
function replay(symbol, entryTime) {
  const c=bars(symbol), i0=c.findIndex(x=>minute(x)===entryTime), entry=c[i0].close, stop=entry*1.007, closes=c.map(x=>x.close), e30=ema(closes,30), e50=ema(closes,50);
  let armed=false, gateTime='', mae=0;
  for(let i=i0+1;i<c.length;i++) {
    mae=Math.max(mae,(c[i].high/entry-1)*100);
    if(c[i].high>=stop) return result(symbol,entryTime,entry,stop,minute(c[i]),stop,'STOP',gateTime,mae);
    if(!armed && c[i].low < entry*(1-PROFIT_GATE)) { armed=true; gateTime=minute(c[i]); }
    if(armed && e30[i-1]<=e50[i-1] && e30[i]>e50[i]) return result(symbol,entryTime,entry,stop,minute(c[i]),c[i].close,'EMA30>EMA50 after +2%',gateTime,mae);
  }
  const last=c.at(-1); return result(symbol,entryTime,entry,stop,minute(last),last.close,armed?'EOD after gate':'EOD; +2% gate never reached',gateTime,mae);
}
const rows=signals.map(x=>replay(...x)), keys=Object.keys(rows[0]);
fs.writeFileSync(path.join('reports','2026-11-23-opening-sell-ema30-50-after-2pct-replay.csv'),[keys.join(','),...rows.map(r=>keys.map(k=>r[k]).join(',')).join('\n')].join('\n')+'\n');
for(const r of rows) console.log(Object.values(r).join(' | '));
const rets=rows.map(r=>r.returnPct), wins=rets.filter(x=>x>0).length;
console.log(JSON.stringify({trades:rows.length,wins,winRatePct:Number((wins/rows.length*100).toFixed(1)),averageReturnPct:Number((rets.reduce((a,b)=>a+b,0)/rows.length).toFixed(3)),totalReturnPct:Number(rets.reduce((a,b)=>a+b,0).toFixed(3)),maxAdverseExcursionPct:Number(Math.max(...rows.map(r=>r.maxAdversePct)).toFixed(3)),worstTradePct:Math.min(...rets)}));
