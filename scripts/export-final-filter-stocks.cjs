const fs=require('fs');
const x=JSON.parse(fs.readFileSync('reports/2026-10-19-21-22-indicator-return-comparison.json','utf8'));
const rows=x.rows.filter(r=>r.adx>=25&&r.adx<90&&r.cmf>=0&&r.cmf<0.4);
const fields=['date','rank','symbol','totalScore','todayScore','ownFiveSessionScore','adx','cmf','vwapSlope','emaSlope','priceEfficiency','slTargetReturnPct','exitType','exitMinuteIST','rsi14_current','trendAngleDeg_current','momentumPct_current','mfi14_current','emaGapExpansionPct_current'];
const esc=v=>v==null?'':/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:String(v);
const out=[fields.join(','),...rows.map(r=>fields.map(f=>esc(r[f])).join(','))].join('\n');
fs.writeFileSync('csv/2026-10-19-21-22-final-filter-stocks.csv',out);
console.log(JSON.stringify({rows:rows.length,filters:'ADX >=25 and <90; CMF >=0 and <0.4',file:'csv/2026-10-19-21-22-final-filter-stocks.csv'},null,2));
