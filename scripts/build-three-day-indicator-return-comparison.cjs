const fs = require('fs');
const dates = ['2026-10-19', '2026-10-21', '2026-10-22'];
const filterFiles = {'2026-10-19':'reports/2026-10-19-top20-final-strength-filter.json','2026-10-21':'reports/2026-10-21-top20-final-strength-filter-2.json','2026-10-22':'reports/2026-10-22-top20-final-strength-filter-2.json'};
const grid = JSON.parse(fs.readFileSync('reports/2026-10-19-to-2026-10-22-final-candidates-exit-grid.json','utf8'));
const best = new Map(grid.bestTrades.map(t=>[`${t.date}|${t.symbol}`,t]));
const rows=[];
for(const date of dates){const report=JSON.parse(fs.readFileSync(filterFiles[date],'utf8'));for(const c of report.filtered){const row={date,rank:c.rank,symbol:c.symbol,totalScore:c.totalScore,todayScore:c.todayScore,ownFiveSessionScore:c.ownFiveSessionScore,adx:c.adx,cmf:c.cmf,vwapSlope:c.vwapSlope,emaSlope:c.emaSlope,priceEfficiency:c.priceEfficiency};for(const [name,metric] of Object.entries(c.metrics)){row[`${name}_current`]=metric.value;for(const [priorDate,value] of Object.entries(metric.priorValues||{}))row[`${name}_${priorDate}`]=value;}const t=best.get(`${date}|${c.symbol}`);row.slTargetReturnPct=t?.returnPct??null;row.exitType=t?.exitType??null;row.exitMinuteIST=t?.exitMinute==null?null:`${String(Math.floor(t.exitMinute/60)).padStart(2,'0')}:${String(t.exitMinute%60).padStart(2,'0')}`;rows.push(row);}}
const out={generatedAt:new Date().toISOString(),dates,filters:grid.methodology,rowCount:rows.length,rows};
fs.writeFileSync('reports/2026-10-19-21-22-indicator-return-comparison.json',JSON.stringify(out,null,2));
const columns=Object.keys(rows.reduce((a,r)=>{for(const k of Object.keys(r))a[k]=1;return a;},{}));const esc=v=>v==null?'':/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:String(v);fs.writeFileSync('csv/2026-10-19-21-22-indicator-return-comparison.csv',[columns.join(','),...rows.map(r=>columns.map(c=>esc(r[c])).join(','))].join('\n'));console.log(JSON.stringify({rowCount:rows.length,columns:columns.length},null,2));
