import fs from 'fs';
import path from 'path';

const DATE = '2026-11-23';
const signals = [['RVNL','09:20'],['CHOLAFIN','09:20'],['ADANIPORTS','09:21'],['ADANIENSOL','09:21'],['ADANIENT','09:21'],['ADANIGREEN','09:21'],['FEDERALBNK','09:22'],['AUBANK','09:23'],['NTPC','09:25'],['INDUSINDBK','09:25']];
const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
const minute = c => formatter.format(new Date(c.time * 1000)).replace(' ','T').slice(11);
const round = n => Number(n.toFixed(2));
function load(symbol) {
  return fs.readFileSync(path.join('db','candles',`${symbol}.jsonl`),'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(c => formatter.format(new Date(c.time * 1000)).startsWith(DATE));
}
function ema(values, period) {
  const alpha = 2 / (period + 1); let value = values[0];
  return values.map((x, i) => value = i === 0 ? x : x * alpha + value * (1 - alpha));
}
function replay(symbol, entryTime) {
  const bars = load(symbol); const index = bars.findIndex(c => minute(c) === entryTime);
  const entry = bars[index].close; const stop = entry * 1.007;
  const closes = bars.map(c => c.close), e30 = ema(closes, 30), e50 = ema(closes, 50);
  let maxAdverse = 0;
  for (let i = index + 1; i < bars.length; i++) {
    maxAdverse = Math.max(maxAdverse, (bars[i].high / entry - 1) * 100);
    if (bars[i].high >= stop) return result(symbol, entryTime, entry, stop, minute(bars[i]), stop, 'STOP', maxAdverse);
    if (e30[i - 1] <= e50[i - 1] && e30[i] > e50[i]) return result(symbol, entryTime, entry, stop, minute(bars[i]), bars[i].close, 'EMA30>EMA50', maxAdverse);
  }
  const last = bars.at(-1);
  return result(symbol, entryTime, entry, stop, minute(last), last.close, 'EOD', maxAdverse);
}
function result(symbol, entryTime, entry, stop, exitTime, exit, reason, mae) {
  return { symbol, entryTime, entry:round(entry), stop:round(stop), exitTime, exit:round(exit), reason, returnPct:Number(((entry / exit - 1) * 100).toFixed(3)), maxAdversePct:Number(mae.toFixed(3)) };
}
const rows = signals.map(x => replay(...x));
const fields = Object.keys(rows[0]);
fs.writeFileSync(path.join('reports','2026-11-23-opening-sell-ema30-50-sl0p7-replay.csv'), [fields.join(','), ...rows.map(r => fields.map(k => r[k]).join(',')).join('\n')].join('\n')+'\n');
for (const row of rows) console.log(Object.values(row).join(' | '));
const returns = rows.map(r=>r.returnPct), wins=returns.filter(r=>r>0).length;
console.log(JSON.stringify({trades:rows.length,wins,winRatePct:Number((wins/rows.length*100).toFixed(1)),averageReturnPct:Number((returns.reduce((a,b)=>a+b,0)/rows.length).toFixed(3)),totalReturnPct:Number(returns.reduce((a,b)=>a+b,0).toFixed(3)),maxAdverseExcursionPct:Number(Math.max(...rows.map(r=>r.maxAdversePct)).toFixed(3)),worstTradePct:Math.min(...returns)}));
