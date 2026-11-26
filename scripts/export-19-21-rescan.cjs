const fs=require('fs');
const dates=['2026-10-19','2026-10-21'];
const grid=JSON.parse(fs.readFileSync('reports/2026-10-19-to-2026-10-22-final-candidates-exit-grid.json','utf8'));
const gridMap=new Map(grid.bestTrades.map(t=>[`${t.date}|${t.symbol}`,t]));
const rows=[];
for(const date of dates){const f=`reports/${date}-top20-final-strength-filter-2.json`,e=JSON.parse(fs.readFileSync(`reports/${date}-final-strategy-open-to-close-evaluation.json`,'utf8')),em=new Map(e.trades.map(t=>[t.symbol,t]));const x=JSON.parse(fs.readFileSync(f,'utf8'));for(const c of x.filtered){const a=em.get(c.symbol),g=gridMap.get(`${date}|${c.symbol}`);rows.push({date,rank:c.rank,symbol:c.symbol,totalScore:c.totalScore,adx:c.adx,cmf:c.cmf,sessionCloseReturnPct:a?.returnPct??null,slTargetReturnPct:g?.returnPct??null,exitType:g?.exitType??null});}}
const fields=Object.keys(rows[0]);const esc=v=>v==null?'':/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:String(v);fs.writeFileSync('csv/2026-10-19-21-rescan-final-filter-stocks.csv',[fields.join(','),...rows.map(r=>fields.map(f=>esc(r[f])).join(','))].join('\n'));console.log(JSON.stringify({rows:rows.length,file:'csv/2026-10-19-21-rescan-final-filter-stocks.csv'},null,2));
