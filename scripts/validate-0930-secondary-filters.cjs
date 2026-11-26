const fs = require('fs');
const path = require('path');
const dates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
const atrCutoff = 0.278914;
const rules = [
  {name: 'MFI14 1m >= 68.04', key: 'mfi14_1m', op: '>=', threshold: 68.04186},
  {name: 'RSI14 3m <= 68.50', key: 'rsi14_3m', op: '<=', threshold: 68.498727},
  {name: '3m trend angle >= 6.93', key: 'trendAngle3m5', op: '>=', threshold: 6.929587},
  {name: 'Opening volume ratio <= 1.66', key: 'volumeRatioPrior5', op: '<=', threshold: 1.658721},
  {name: 'At least 50% up candles', key: 'upCandleFraction', op: '>=', threshold: 0.5},
  {name: 'MFI14 1m >= 68.04 AND RSI14 1m <= 72.64', key: 'rsi14_1m', op: '<=', threshold: 72.6404505,
    extra: {key: 'mfi14_1m', op: '>=', threshold: 68.04186}},
  {name: 'MFI14 1m >= 68.04 AND opening volume ratio <= 2.56', key: 'volumeRatioPrior5', op: '<=', threshold: 2.5622385,
    extra: {key: 'mfi14_1m', op: '>=', threshold: 68.04186}}
];
const cache = new Map();
function candleFile(symbol) {
  if (cache.has(symbol)) return cache.get(symbol);
  const f = path.join('db', 'candles', `${symbol.replace(/-EQ$/, '')}.jsonl`);
  const rows = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(r => {
    const d = new Date(r.time * 1000 + 330 * 60000);
    return {date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume};
  });
  cache.set(symbol, rows);
  return rows;
}
function resample(rows, n) {
  const groups = new Map();
  for (const r of rows) {
    const start = 555 + Math.floor((r.minute - 555) / n) * n;
    const key = `${r.date}|${start}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].filter(a => a.length === n).map(a => ({date: a[0].date,
    open: a[0].open, high: Math.max(...a.map(r => r.high)), low: Math.min(...a.map(r => r.low)),
    close: a.at(-1).close, volume: a.reduce((s, r) => s + r.volume, 0)}));
}
function atrPct(bars) {
  let tr = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const r = bars[i], p = bars[i - 1];
    tr += Math.max(r.high - r.low, Math.abs(r.high - p.close), Math.abs(r.low - p.close));
  }
  return 100 * (tr / 14) / bars.at(-1).close;
}
function mfi14(bars) {
  let positive = 0, negative = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const r = bars[i], p = bars[i - 1];
    const current = (r.high + r.low + r.close) / 3, previous = (p.high + p.low + p.close) / 3;
    if (current > previous) positive += current * r.volume;
    else if (current < previous) negative += current * r.volume;
  }
  return negative === 0 ? 100 : 100 - 100 / (1 + positive / negative);
}
function rsi14(closes) {
  let gain = 0, loss = 0;
  for (let i = 1; i <= 14; i++) {
    gain += Math.max(0, closes[i] - closes[i - 1]);
    loss += Math.max(0, closes[i - 1] - closes[i]);
  }
  gain /= 14; loss /= 14;
  for (let i = 15; i < closes.length; i++) {
    gain = (gain * 13 + Math.max(0, closes[i] - closes[i - 1])) / 14;
    loss = (loss * 13 + Math.max(0, closes[i - 1] - closes[i])) / 14;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function angle(bars) {
  const y = bars.map(b => Math.log(b.close)), mx = (bars.length - 1) / 2;
  const my = y.reduce((s, v) => s + v, 0) / bars.length;
  const slope = y.reduce((s, v, i) => s + (i - mx) * (v - my), 0) /
    y.reduce((s, _, i) => s + (i - mx) ** 2, 0);
  return Math.atan(slope * 100) * 180 / Math.PI;
}
function simulate(rows, date) {
  const later = rows.filter(r => r.date === date && r.minute >= 570);
  if (!later.length) return null;
  const entry = later[0].open, stop = entry * 0.995, target = entry * 1.02;
  let mae = Infinity;
  for (const r of later) {
    mae = Math.min(mae, 100 * (r.low / entry - 1));
    if (r.low <= stop) return {returnPct: -0.5, exitType: 'SL', observedMaePct: mae};
    if (r.high >= target) return {returnPct: 2, exitType: 'TARGET', observedMaePct: mae};
  }
  return {returnPct: 100 * (later.at(-1).close / entry - 1), exitType: 'CLOSE', observedMaePct: mae};
}
const observations = [];
for (const date of dates) {
  const rank = JSON.parse(fs.readFileSync(`reports/${date}-0930-five-factor-strength-ranking.json`, 'utf8'));
  const filtered = JSON.parse(fs.readFileSync(`reports/${date}-top20-final-strength-filter.json`, 'utf8'));
  for (const c of filtered.filtered) {
    const rows = candleFile(c.symbol);
    const relevant = rows.filter(r => rank.priorDates.includes(r.date) || (r.date === date && r.minute < 570));
    const opening = relevant.filter(r => r.date === date);
    const tf3 = resample(relevant, 3);
    if (opening.length !== 15 || tf3.length < 35) continue;
    const priorVolumes = rank.priorDates.map(d => rows.filter(r => r.date === d && r.minute >= 555 && r.minute < 570)
      .reduce((s, r) => s + r.volume, 0));
    const todayVolume = opening.reduce((s, r) => s + r.volume, 0);
    const values = {atr14Pct_3m: atrPct(tf3), mfi14_1m: mfi14(relevant), rsi14_1m: rsi14(relevant.map(r => r.close)),
      rsi14_3m: rsi14(tf3.map(r => r.close)), trendAngle3m5: angle(tf3.slice(-5)),
      volumeRatioPrior5: todayVolume / (priorVolumes.reduce((s, v) => s + v, 0) / 5),
      upCandleFraction: opening.filter(r => r.close > r.open).length / 15};
    const outcome = simulate(rows, date);
    if (!outcome) continue;
    observations.push({date, symbol: c.symbol, score: c.totalScore, ...values, ...outcome});
  }
}
const atrRows = observations.filter(r => r.atr14Pct_3m >= atrCutoff);
function stats(rows) {
  const n = rows.length, wins = rows.filter(r => r.returnPct > 0).length;
  const total = rows.reduce((s, r) => s + r.returnPct, 0);
  const byDate = dates.map(date => {
    const a = rows.filter(r => r.date === date);
    return {date, trades: a.length, wins: a.filter(r => r.returnPct > 0).length,
      totalReturnPct: Number(a.reduce((s, r) => s + r.returnPct, 0).toFixed(4))};
  });
  return {trades: n, wins, winRatePct: n ? Number((100 * wins / n).toFixed(4)) : null,
    averageReturnPct: n ? Number((total / n).toFixed(4)) : null,
    totalReturnPct: Number(total.toFixed(4)),
    worstObservedMaePct: n ? Number(Math.min(...rows.map(r => r.observedMaePct)).toFixed(4)) : null,
    worstDay: byDate.reduce((a, b) => a.totalReturnPct < b.totalReturnPct ? a : b), byDate};
}
const tested = rules.map(rule => {
  const kept = atrRows.filter(r => {
    const first = rule.op === '>=' ? r[rule.key] >= rule.threshold : r[rule.key] <= rule.threshold;
    if (!first || !rule.extra) return first;
    return rule.extra.op === '>=' ? r[rule.extra.key] >= rule.extra.threshold : r[rule.extra.key] <= rule.extra.threshold;
  });
  return {...rule, summary: stats(kept), removedLosers: atrRows.filter(r => !kept.includes(r) && r.returnPct <= 0).length,
    removedWinners: atrRows.filter(r => !kept.includes(r) && r.returnPct > 0).length};
});
const out = {generatedAt: new Date().toISOString(), validationDates: dates,
  note: 'Secondary thresholds selected on 19/21/22, tested once on earlier 12-16 sessions.',
  method: '100-point top-20 score, ADX/CMF filters, 09:30 entry, 0.5% SL/2% target, same-bar stop precedence',
  base: stats(observations), atr: stats(atrRows), tested, observations};
const output = 'reports/2026-10-12-to-2026-10-16-0930-secondary-filter-validation.json';
fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({output, base: out.base, atr: out.atr,
  tested: tested.map(r => ({name: r.name, summary: r.summary, removedLosers: r.removedLosers, removedWinners: r.removedWinners}))}, null, 2));
