const fs = require('fs');
const path = require('path');

const input = path.join('csv', '2026-10-05-to-13-absorption-breakout-broad-enriched.csv');
const outCsv = path.join('csv', '2026-10-05-to-13-revised-absorption-strategy-backtest.csv');
const outJson = path.join('csv', '2026-10-05-to-13-revised-absorption-strategy-summary.json');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift();
  return rows.filter(r => r.length && r.some(x => x !== '')).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function n(row, key) { const v = Number(row[key]); return Number.isFinite(v) ? v : NaN; }
function finite(...xs) { return xs.every(Number.isFinite); }
function timeMinutes(s) { const [h,m] = String(s).split(':').map(Number); return h * 60 + m; }

const rows = parseCsv(fs.readFileSync(input, 'utf8'));
const selected = [];
for (const r of rows) {
  const matches = [];
  if (r.branch === 'opening') {
    const gap=n(r,'gapPct'), prior=n(r,'prior30ReturnPct'), delta=n(r,'deltaPct'), updates=n(r,'updates'), dp=n(r,'depthPricePct'), cr=n(r,'candleReturnPct'), bid=n(r,'avgBidPct'), bp=n(r,'breadthPositivePct'), ba=n(r,'breadthAbove05Pct'), ofi=n(r,'ofi');
    if (finite(gap,prior,delta,updates,dp,cr,bid,bp,ba) && gap>=-0.10 && prior<=0.25 && delta<=50 && updates>=12 && cr>0 && dp/cr>=0.95 && bid<=50 && bp>=70 && ba<=20) matches.push('opening_broad_participation');
    if (finite(bid,ofi,gap,prior) && bid<=40 && ofi>=0.20 && gap<=1.00 && prior<=0.50) matches.push('opening_hidden_buy_flow');
  }
  if (r.branch === 'intraday') {
    const stm=timeMinutes(r.setupTime), r3=n(r,'return3Pct'), scr=n(r,'candleReturnPct'), cab=n(r,'confirmAvgBidPct'), bp=n(r,'breadthPositivePct');
    if (finite(stm,r3,scr,cab,bp) && stm>=13*60+50 && r3>=0.13 && scr<=0.15 && cab>=51 && cab<=64 && bp>=75) matches.push('late_breadth_confirmed_absorption');

    const vr=n(r,'volumeRatio10'), cm=n(r,'confirmMidReturnPct'), br3=n(r,'breadthReturn3PositivePct');
    if (finite(vr,cm,bp,br3) && vr<=1.00 && cm>=0.20 && cm<=0.30 && bp>=40 && br3>=70) matches.push('smooth_depth_confirmation');

    const ofi=n(r,'ofi'), cvr=n(r,'confirmVolumeRatio10');
    if (finite(ofi,cm,cvr,bp) && ofi>=0.10 && cm>=0.20 && cvr<=2.00 && bp>=40) matches.push('balanced_flow_continuation');
  }
  if (matches.length) selected.push({...r, matches});
}

selected.sort((a,b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol));
const dedup = new Map();
for (const r of selected) {
  const key = `${r.date}|${r.symbol}`;
  if (!dedup.has(key)) dedup.set(key, r);
  else {
    const prior = dedup.get(key);
    prior.matches = [...new Set([...prior.matches, ...r.matches])];
  }
}
const finalRows = [...dedup.values()].sort((a,b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol));
const keep = ['date','symbol','branch','setupTime','signalTime','entry','outcome','resolvedAt','mfePct','maePct','closePct','breadthPositivePct','breadthAbove05Pct','breadthReturn3PositivePct'];
const headers = ['patterns',...keep];
const lines = [headers.join(',')];
for (const r of finalRows) lines.push(headers.map(h => csvCell(h === 'patterns' ? r.matches.join('|') : r[h])).join(','));
fs.writeFileSync(outCsv, lines.join('\n') + '\n');

const outcomeCounts = {};
const daySummary = {};
const patternSummary = {};
for (const r of finalRows) {
  const o = r.outcome || 'Unknown'; outcomeCounts[o] = (outcomeCounts[o] || 0) + 1;
  const ret = o === 'Target' ? 1.5 : o === 'Stop' ? -0.4 : n(r,'closePct') || 0;
  daySummary[r.date] ||= {signals:0,target:0,stop:0,unresolved:0,returnPct:0};
  const d=daySummary[r.date]; d.signals++; if(o==='Target')d.target++; else if(o==='Stop')d.stop++; else d.unresolved++; d.returnPct += ret;
  for (const p of r.matches) {
    patternSummary[p] ||= {signals:0,target:0,stop:0,unresolved:0,returnPct:0};
    const x=patternSummary[p]; x.signals++; if(o==='Target')x.target++; else if(o==='Stop')x.stop++; else x.unresolved++; x.returnPct += ret;
  }
}
const totalReturn = finalRows.reduce((s,r)=>s+(r.outcome==='Target'?1.5:r.outcome==='Stop'?-0.4:(n(r,'closePct')||0)),0);
const summary = {inputRows:rows.length, matchedBeforeDedup:selected.length, signals:finalRows.length, outcomes:outcomeCounts, totalSimpleReturnPct:+totalReturn.toFixed(3), averageReturnPct:finalRows.length?+(totalReturn/finalRows.length).toFixed(3):0, daySummary, patternSummary, output:outCsv};
fs.writeFileSync(outJson, JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
console.log('\nSIGNALS');
for (const r of finalRows) console.log(`${r.date} ${r.signalTime} ${r.symbol} ${r.outcome} MFE=${r.mfePct}% MAE=${r.maePct}% [${r.matches.join(', ')}]`);
