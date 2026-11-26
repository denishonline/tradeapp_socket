const fs=require('fs');
const x=JSON.parse(fs.readFileSync('reports/2026-10-19-21-22-indicator-return-comparison.json','utf8'));
const metrics=[['rsi14','RSI'],['trendAngleDeg','Trend angle'],['momentumPct','Momentum %'],['mfi14','MFI'],['emaGapExpansionPct','EMA-gap expansion %']];
let out=['# 19, 21 and 22 October — filtered stocks with indicator values','', 'Filters: top-20 score, `25 <= ADX < 90`, `0 <= CMF < 0.4`. Returns use the tested 0.5% stop / 2% target model.',''];
for(const date of x.dates){out.push(`## ${date}`,'');for(const r of x.rows.filter(z=>z.date===date)){out.push(`### ${r.symbol} — rank ${r.rank}, score ${r.totalScore}, return ${r.slTargetReturnPct==null?'n/a':r.slTargetReturnPct.toFixed(3)+'%'} (${r.exitType||'n/a'})`,'',`ADX ${r.adx} · CMF ${r.cmf} · VWAP slope ${r.vwapSlope} · EMA slope ${r.emaSlope} · price efficiency ${r.priceEfficiency}`,'', '**Current 09:15–09:29 values**');for(const [key,label] of metrics)out.push(`- ${label}: ${r[`${key}_current`]}`);out.push('','**Previous five sessions**');for(const [key,label] of metrics){const vals=Object.entries(r).filter(([k])=>k.startsWith(`${key}_2026-`)).map(([k,v])=>`${k.slice(-10)}=${v}`).join(' · ');out.push(`- ${label}: ${vals}`);}out.push('');}}
fs.writeFileSync('reports/2026-10-19-21-22-indicator-values-by-stock.md',out.join('\n'));
console.log('wrote',out.length,'lines');
