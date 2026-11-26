const fs = require('fs');

const source = 'reports/2026-10-19-21-22-0930-multitimeframe-filter-research.json';
const jsonOutput = 'reports/2026-10-19-21-22-0930-atr3m-filtered-trades.json';
const markdownOutput = 'reports/2026-10-19-21-22-0930-atr3m-filtered-trades.md';
const data = JSON.parse(fs.readFileSync(source, 'utf8'));
const selected = data.bestByFeature.find(r => r.feature === 'atr14Pct_3m');
if (!selected || selected.op !== '>=') throw new Error('Missing expected 3-minute ATR rule');
const cutoff = selected.threshold;
const trades = data.rows.filter(r => r.features.atr14Pct_3m >= cutoff).map(r => ({
  date: r.date, symbol: r.symbol, score: r.score, adx: r.adx, cmf: r.cmf,
  atr14Pct3m: r.features.atr14Pct_3m, returnPct: r.returnPct,
  exitType: r.exitType, exitMinuteIST: `${String(Math.floor(r.exitMinute / 60)).padStart(2, '0')}:${String(r.exitMinute % 60).padStart(2, '0')}`,
  observedMaePct: r.maePct
}));
function summary(rows) {
  const total = rows.reduce((s, r) => s + r.returnPct, 0);
  const wins = rows.filter(r => r.returnPct > 0).length;
  return {tradeCount: rows.length, wins, losses: rows.length - wins,
    winRatePct: 100 * wins / rows.length, averageReturnPct: total / rows.length,
    totalEqualWeightReturnPct: total, worstObservedMaePct: Math.min(...rows.map(r => r.observedMaePct))};
}
const byDate = data.dates.map(date => {
  const daily = trades.filter(r => r.date === date);
  return {date, summary: summary(daily), trades: daily};
});
const out = {generatedAt: new Date().toISOString(), source, cutoff: {feature: 'atr14Pct_3m', op: '>=', valuePct: cutoff},
  baseFilters: 'top-20 100-point score; 25 <= ADX < 90; 0 <= CMF < 0.4',
  entry: '09:30 open', exit: '0.5% SL or 2% target first touch; same-bar stop precedence; otherwise last available close',
  overall: summary(trades), worstDay: byDate.reduce((a, b) => a.summary.totalEqualWeightReturnPct < b.summary.totalEqualWeightReturnPct ? a : b).date,
  byDate};
fs.writeFileSync(jsonOutput, JSON.stringify(out, null, 2) + '\n');
const pct = n => `${n >= 0 ? '+' : ''}${n.toFixed(3)}%`;
const md = ['# 09:30 strategy with 3-minute ATR filter', '',
  `After the top-20 ranking and ADX/CMF filters, retain stocks with 3-minute ATR14 >= ${cutoff.toFixed(6)}% at 09:30 IST.`,
  'Returns use a 0.5% stop, 2% target, and otherwise the last available close. Stop has precedence if both levels touch within one minute. Costs and slippage are excluded.',
  '22 October data ended at 14:21 IST; any close exit that day is provisional.', '',
  '| Date | Trades | Winners | Losers | Win rate | Average return | Total equal-weight return | Worst observed MAE |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...byDate.map(d => `| ${d.date} | ${d.summary.tradeCount} | ${d.summary.wins} | ${d.summary.losses} | ${d.summary.winRatePct.toFixed(1)}% | ${pct(d.summary.averageReturnPct)} | ${pct(d.summary.totalEqualWeightReturnPct)} | ${pct(d.summary.worstObservedMaePct)} |`),
  `| **All** | **${out.overall.tradeCount}** | **${out.overall.wins}** | **${out.overall.losses}** | **${out.overall.winRatePct.toFixed(1)}%** | **${pct(out.overall.averageReturnPct)}** | **${pct(out.overall.totalEqualWeightReturnPct)}** | **${pct(out.overall.worstObservedMaePct)}** |`, '',
  `Worst day: ${out.worstDay}.`, ''];
for (const day of byDate) {
  md.push(`## ${day.date}`, '', '| Stock | Score | 3m ATR14 | Return | Exit | Time IST |',
    '| --- | ---: | ---: | ---: | --- | --- |',
    ...day.trades.map(r => `| ${r.symbol} | ${r.score.toFixed(2)} | ${r.atr14Pct3m.toFixed(3)}% | ${pct(r.returnPct)} | ${r.exitType} | ${r.exitMinuteIST} |`), '');
}
md.push('Observed MAE is the lowest candle low through the exit minute. This cutoff was selected from these three dates and requires validation on other sessions.');
fs.writeFileSync(markdownOutput, md.join('\n') + '\n');
console.log(JSON.stringify({jsonOutput, markdownOutput, overall: out.overall, byDate: byDate.map(x => ({date: x.date, ...x.summary}))}, null, 2));
