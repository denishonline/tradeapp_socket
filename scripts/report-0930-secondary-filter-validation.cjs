const fs = require('fs');
const primary = JSON.parse(fs.readFileSync('reports/2026-10-19-21-22-0930-multitimeframe-filter-research.json', 'utf8'));
const secondary = JSON.parse(fs.readFileSync('reports/2026-10-19-21-22-0930-secondary-filter-research.json', 'utf8'));
const validation = JSON.parse(fs.readFileSync('reports/2026-10-12-to-2026-10-16-0930-secondary-filter-validation.json', 'utf8'));
const threshold = 68.04186;
const pct = n => `${n >= 0 ? '+' : ''}${n.toFixed(3)}%`;
const devBase = primary.rows.filter(r => r.features.atr14Pct_3m >= 0.278914);
const devMfi = secondary.rows.filter(r => r.indicators.mfi14_1m >= threshold);
const valBase = validation.observations.filter(r => r.atr14Pct_3m >= 0.278914);
const valMfi = valBase.filter(r => r.mfi14_1m >= threshold);
const pair = validation.tested.find(r => r.name.startsWith('MFI14 1m >= 68.04 AND RSI14'));
const ruleSpecs = [
  {label: 'MFI14 1m >= 68.04', testName: 'MFI14 1m >= 68.04', keep: r => r.indicators.mfi14_1m >= 68.04186},
  {label: 'RSI14 3m <= 68.50', testName: 'RSI14 3m <= 68.50', keep: r => r.indicators.rsi14_3m <= 68.498727},
  {label: '3m angle >= 6.93', testName: '3m trend angle >= 6.93', keep: r => r.indicators.trendAngle3m5 >= 6.929587},
  {label: 'Volume ratio <= 1.66', testName: 'Opening volume ratio <= 1.66', keep: r => r.indicators.volumeRatioPrior5 <= 1.658721},
  {label: 'Up candles >= 50%', testName: 'At least 50% up candles', keep: r => r.indicators.upCandleFraction >= 0.5},
  {label: 'MFI >= 68.04 and RSI1m <= 72.64', testName: 'MFI14 1m >= 68.04 AND RSI14 1m <= 72.64',
    keep: r => r.indicators.mfi14_1m >= 68.04186 && r.indicators.rsi14_1m <= 72.6404505}
];
function stats(a) {
  const n = a.length, wins = a.filter(r => r.returnPct > 0).length;
  const total = a.reduce((s, r) => s + r.returnPct, 0);
  return {trades: n, wins, losses: n - wins, winRatePct: 100 * wins / n,
    averageReturnPct: total / n, totalReturnPct: total,
    worstObservedMaePct: Math.min(...a.map(r => r.observedMaePct ?? r.maePct))};
}
const dates = [...validation.validationDates, ...primary.dates];
const alternatives = ruleSpecs.map(spec => {
  const dev = secondary.rows.filter(spec.keep), test = validation.tested.find(r => r.name === spec.testName);
  if (!test) throw new Error(`Missing validation rule: ${spec.testName}`);
  return {rule: spec.label, development: stats(dev), validation: test.summary,
    validationRemovedWinners: test.removedWinners, validationRemovedLosers: test.removedLosers};
});
const daily = dates.map(date => {
  const base = date < '2026-10-19' ? valBase : devBase;
  const mfi = date < '2026-10-19' ? valMfi : devMfi;
  const summarize = a => {const rows = a.filter(r => r.date === date);return {trades: rows.length,
    wins: rows.filter(r => r.returnPct > 0).length,
    totalReturnPct: rows.reduce((s, r) => s + r.returnPct, 0)};};
  return {date, atrOnly: summarize(base), atrAndMfi: summarize(mfi)};
});
const out = {generatedAt: new Date().toISOString(),
  developmentDates: primary.dates, validationDates: validation.validationDates,
  studiedIndicators: {existingMultiTimeframe: 30, additionalOpeningFeatures: 16},
  criteria: {base: 'top-20 100-point score, 25 <= ADX < 90, 0 <= CMF < 0.4, 3m ATR14 >= 0.278914%',
    secondary: '09:30 1m MFI14 >= 68.04186'},
  development: {atrOnly: stats(devBase), atrAndMfi: stats(devMfi)},
  validation: {atrOnly: stats(valBase), atrAndMfi: stats(valMfi),
  mfiAndRsi: pair.summary},
  combined: {atrOnly: stats([...valBase, ...devBase]), atrAndMfi: stats([...valMfi, ...devMfi])}, daily,
  alternatives,
  developmentMfiTrades: devMfi.map(r => ({date: r.date, symbol: r.symbol, mfi14: r.indicators.mfi14_1m, returnPct: r.returnPct}))};
const json = 'reports/2026-10-12-to-2026-10-22-0930-secondary-filter-findings.json';
const markdown = 'reports/2026-10-12-to-2026-10-22-0930-secondary-filter-findings.md';
fs.writeFileSync(json, JSON.stringify(out, null, 2) + '\n');
const md = ['# 09:30 secondary-filter findings', '',
  'Research base: 100-point top-20 ranking, 25 <= ADX < 90, 0 <= CMF < 0.4, and 3-minute ATR14 >= 0.278914% at 09:30 IST.',
  'Returns: 09:30 long entry, 0.5% SL or 2% target first touch, otherwise last available close. Same-minute stop has precedence. Costs and slippage are excluded.',
  'Indicators were calculated only from completed candles by 09:30. The 12–16 October sessions were held out from secondary cutoff selection.',
  'The 22 October file ended at 14:21 IST; close exits on that date are provisional.', '',
  '## Most balanced additional filter', '',
  'Keep 1-minute MFI14 >= 68.04186 after the ATR filter. This is the same 09:15–09:29 MFI metric used in the 100-point ranking.', '',
  '| Sample | Rule | Trades | Winners | Losers | Win rate | Average return | Total equal-weight return | Worst observed MAE |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const [label, section] of [['19/21/22 development', out.development], ['12–16 validation', out.validation], ['All eight dates', out.combined]]) {
  for (const [rule, s] of [['ATR only', section.atrOnly], ['ATR + MFI', section.atrAndMfi]])
    md.push(`| ${label} | ${rule} | ${s.trades} | ${s.wins} | ${s.losses} | ${s.winRatePct.toFixed(1)}% | ${pct(s.averageReturnPct)} | ${pct(s.totalReturnPct)} | ${pct(s.worstObservedMaePct)} |`);
}
md.push('', '## Date-wise returns', '',
  '| Date | ATR trades / wins / total | ATR + MFI trades / wins / total |',
  '| --- | --- | --- |',
  ...daily.map(d => `| ${d.date} | ${d.atrOnly.trades} / ${d.atrOnly.wins} / ${pct(d.atrOnly.totalReturnPct)} | ${d.atrAndMfi.trades} / ${d.atrAndMfi.wins} / ${pct(d.atrAndMfi.totalReturnPct)} |`), '',
  '## Other tested ranges', '',
  '| Rule | Development trades / wins / average | Validation trades / wins / average | Validation losers removed | Validation winners removed |',
  '| --- | --- | --- | ---: | ---: |',
  ...alternatives.map(r => `| ${r.rule} | ${r.development.trades} / ${r.development.wins} / ${pct(r.development.averageReturnPct)} | ${r.validation.trades} / ${r.validation.wins} / ${pct(r.validation.averageReturnPct)} | ${r.validationRemovedLosers} | ${r.validationRemovedWinners} |`), '',
  `The development sample had 7 winners and 0 losers with MFI >= 68.04 and RSI14 <= 72.64. On untouched 12–16 October sessions it had ${pair.summary.trades} trades, ${pair.summary.wins} winners and ${pair.summary.trades - pair.summary.wins} losers.`,
  'The 3-minute trend-angle threshold increased average return but removed 8 of 23 ATR-qualified winners in validation. The tighter opening-volume ratio removed 13 of 23 winners and reduced average return.',
  'MFI alone removed 7 of 29 validation losers and 2 of 23 validation winners. It improved average return but did not remove most losing trades.', '',
  '## 19/21/22 trades retained by ATR + MFI', '',
  '| Date | Stock | MFI14 | Return |', '| --- | --- | ---: | ---: |',
  ...out.developmentMfiTrades.map(r => `| ${r.date} | ${r.symbol} | ${r.mfi14.toFixed(2)} | ${pct(r.returnPct)} |`), '',
  'Observed MAE is the lowest candle low through the exit minute. This sample is too small to establish a reliable live trading filter.');
fs.writeFileSync(markdown, md.join('\n') + '\n');
console.log(JSON.stringify({json, markdown, development: out.development, validation: out.validation,
  combined: out.combined, daily}, null, 2));
