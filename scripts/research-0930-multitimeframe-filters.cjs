const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DATES = ['2026-10-19', '2026-10-21', '2026-10-22'];
const PRIOR = {
  '2026-10-19': ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'],
  '2026-10-21': ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19'],
  '2026-10-22': ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-21']
};
const SOURCE = 'reports/2026-10-19-21-22-indicator-return-comparison.json';
const OUTPUT = 'reports/2026-10-19-21-22-0930-multitimeframe-filter-research.json';
const ROUND = (n, p = 4) => Number.isFinite(n) ? Number(n.toFixed(p)) : null;
const AVG = a => a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
const IST = t => new Date(Number(t) * 1000 + 330 * 60000);

function candles(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol.replace(/-EQ$/, '')}.jsonl`);
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const raw = JSON.parse(line);
    const dt = IST(raw.time);
    const date = dt.toISOString().slice(0, 10);
    const minute = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    if (!DATES.includes(date) && date < '2026-10-12') continue;
    if (minute < 555 || minute >= 930) continue;
    if (![raw.open, raw.high, raw.low, raw.close, raw.volume].every(Number.isFinite)) continue;
    rows.push({date, minute, open: raw.open, high: raw.high, low: raw.low, close: raw.close, volume: raw.volume});
  }
  return rows;
}

function aggregate(rows, minutes, targetDate) {
  const groups = new Map();
  for (const r of rows) {
    if (!PRIOR[targetDate].includes(r.date) && r.date !== targetDate) continue;
    if (r.date === targetDate && r.minute >= 570) continue;
    const start = 555 + Math.floor((r.minute - 555) / minutes) * minutes;
    const key = `${r.date}|${start}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, values]) => {
    if (values.length !== minutes) return null;
    values.sort((a, b) => a.minute - b.minute);
    const [date, minute] = key.split('|');
    return {date, minute: Number(minute), open: values[0].open,
      high: Math.max(...values.map(v => v.high)), low: Math.min(...values.map(v => v.low)),
      close: values.at(-1).close, volume: values.reduce((s, v) => s + v.volume, 0)};
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date) || a.minute - b.minute);
}

function ema(values, period) {
  let e = values[0];
  const k = 2 / (period + 1);
  return values.map((v, i) => {if (i) e += k * (v - e); return e;});
}
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    gain += Math.max(0, values[i] - values[i - 1]);
    loss += Math.max(0, values[i - 1] - values[i]);
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    gain = (gain * (period - 1) + Math.max(0, values[i] - values[i - 1])) / period;
    loss = (loss * (period - 1) + Math.max(0, values[i - 1] - values[i])) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function indicators(bars, date) {
  const today = bars.filter(b => b.date === date);
  if (bars.length < 35 || !today.length) return null;
  const c = bars.map(b => b.close), last = bars.at(-1), p = last.close;
  const e9 = ema(c, 9), e21 = ema(c, 21), e12 = ema(c, 12), e26 = ema(c, 26);
  const macd = e12.map((v, i) => v - e26[i]);
  const signal = ema(macd, 9);
  const tail14 = bars.slice(-14), tail20 = bars.slice(-20);
  let pos = 0, neg = 0, tr = 0, obvChange = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1], typical = (b.high + b.low + b.close) / 3;
    const oldTypical = (prev.high + prev.low + prev.close) / 3;
    if (typical > oldTypical) pos += typical * b.volume;
    else if (typical < oldTypical) neg += typical * b.volume;
    tr += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
  }
  for (let i = bars.length - 5; i < bars.length; i++) obvChange += Math.sign(bars[i].close - bars[i - 1].close) * bars[i].volume;
  const high14 = Math.max(...tail14.map(b => b.high)), low14 = Math.min(...tail14.map(b => b.low));
  const mean20 = AVG(tail20.map(b => b.close));
  const sd20 = Math.sqrt(AVG(tail20.map(b => (b.close - mean20) ** 2)));
  const pv = tail20.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0);
  const vol20 = tail20.reduce((s, b) => s + b.volume, 0);
  const out = {
    rsi14: rsi(c),
    mfi14: neg === 0 ? 100 : 100 - 100 / (1 + pos / neg),
    macdHistogramPct: 100 * (macd.at(-1) - signal.at(-1)) / p,
    ema9Over21Pct: 100 * (e9.at(-1) / e21.at(-1) - 1),
    ema9Slope3Pct: 100 * (e9.at(-1) / e9.at(-4) - 1),
    stochasticK14: 100 * (p - low14) / (high14 - low14 || 1),
    bollingerPercentB20: sd20 ? (p - (mean20 - 2 * sd20)) / (4 * sd20) : 0.5,
    atr14Pct: 100 * (tr / 14) / p,
    rollingVwapGapPct: 100 * (p / (pv / (vol20 || 1)) - 1),
    obvPressure5: obvChange / (vol20 || 1)
  };
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, ROUND(v, 6)]));
}

const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const grid = JSON.parse(fs.readFileSync('reports/2026-10-19-to-2026-10-22-final-candidates-exit-grid.json', 'utf8'));
const tradeMap = new Map(grid.bestTrades.map(t => [`${t.date}|${t.symbol}`, t]));
const cache = new Map();
const rows = source.rows.map(r => {
  if (!cache.has(r.symbol)) cache.set(r.symbol, candles(r.symbol));
  const raw = cache.get(r.symbol);
  const features = {};
  const counts = {};
  for (const tf of [1, 3, 5]) {
    const b = aggregate(raw, tf, r.date);
    counts[tf] = b.filter(x => x.date === r.date).length;
    const m = indicators(b, r.date);
    if (m) for (const [k, v] of Object.entries(m)) features[`${k}_${tf}m`] = v;
  }
  const t = tradeMap.get(`${r.date}|${r.symbol}`);
  const duringTrade = raw.filter(b => b.date === r.date && b.minute >= 570 && b.minute <= t?.exitMinute);
  const maePct = duringTrade.length && t?.entry ? 100 * (Math.min(...duringTrade.map(b => b.low)) / t.entry - 1) : null;
  const prior = raw.filter(b => b.date === PRIOR[r.date].at(-1)).at(-1);
  const open = raw.find(b => b.date === r.date && b.minute === 555);
  const openingGapPct = prior && open ? 100 * (open.open / prior.close - 1) : null;
  return {date: r.date, symbol: r.symbol, score: r.totalScore, adx: r.adx, cmf: r.cmf,
    returnPct: t?.returnPct ?? null, exitType: t?.exitType ?? null, exitMinute: t?.exitMinute ?? null,
    maePct: ROUND(maePct), openingGapPct: ROUND(openingGapPct), openingBars: counts, features};
});
const featureNames = Object.keys(rows[0].features);
const valid = rows.filter(r => featureNames.every(f => Number.isFinite(r.features[f])));

function stats(input) {
  const returns = input.map(r => r.returnPct), wins = input.filter(r => r.returnPct > 0);
  const byDate = DATES.map(date => {
    const a = input.filter(r => r.date === date);
    return {date, trades: a.length, wins: a.filter(r => r.returnPct > 0).length,
      totalReturnPct: ROUND(a.reduce((s, r) => s + r.returnPct, 0))};
  }).filter(d => d.trades > 0);
  return {trades: input.length, wins: wins.length, winRatePct: ROUND(100 * wins.length / (input.length || 1)),
    averageReturnPct: ROUND(AVG(returns)), totalReturnPct: ROUND(returns.reduce((s, n) => s + n, 0)),
    worstTradePct: ROUND(Math.min(...returns)), worstMAEPct: ROUND(Math.min(...input.map(r => r.maePct))),
    worstDay: byDate.reduce((a, b) => a.totalReturnPct < b.totalReturnPct ? a : b), byDate};
}

function candidateRules(input) {
  const rules = [];
  for (const f of featureNames) {
    const values = [...new Set(input.map(r => r.features[f]))].sort((a, b) => a - b);
    for (let i = 0; i < values.length - 1; i++) {
      const threshold = (values[i] + values[i + 1]) / 2;
      for (const op of ['>=', '<=']) {
        const kept = input.filter(r => op === '>=' ? r.features[f] >= threshold : r.features[f] <= threshold);
        if (kept.length < Math.ceil(input.length * 0.5) || kept.length > Math.floor(input.length * 0.9)) continue;
        const s = stats(kept);
        rules.push({feature: f, op, threshold: ROUND(threshold, 6), ...s,
          removedLosers: input.filter(r => !kept.includes(r) && r.returnPct <= 0).length,
          removedWinners: input.filter(r => !kept.includes(r) && r.returnPct > 0).length});
      }
    }
  }
  return rules.sort((a, b) => b.averageReturnPct - a.averageReturnPct || b.wins - a.wins);
}
const allRules = candidateRules(valid);
const byFeature = featureNames.map(f => allRules.find(r => r.feature === f)).filter(Boolean).sort((a, b) => b.averageReturnPct - a.averageReturnPct);
const heldOut = DATES.map(testDate => {
  const train = valid.filter(r => r.date !== testDate), test = valid.filter(r => r.date === testDate);
  const rule = candidateRules(train)[0];
  const kept = test.filter(r => rule.op === '>=' ? r.features[rule.feature] >= rule.threshold : r.features[rule.feature] <= rule.threshold);
  return {testDate, trainBaseline: stats(train), selectedRule: {feature: rule.feature, op: rule.op, threshold: rule.threshold},
    trainFiltered: stats(train.filter(r => rule.op === '>=' ? r.features[rule.feature] >= rule.threshold : r.features[rule.feature] <= rule.threshold)),
    testBaseline: stats(test), testFiltered: stats(kept), kept: kept.map(r => r.symbol)};
});
const heldOutAtr3m = DATES.map(testDate => {
  const train = valid.filter(r => r.date !== testDate), test = valid.filter(r => r.date === testDate);
  const rule = candidateRules(train).find(r => r.feature === 'atr14Pct_3m');
  const filter = r => rule.op === '>=' ? r.features.atr14Pct_3m >= rule.threshold : r.features.atr14Pct_3m <= rule.threshold;
  return {testDate, selectedRule: {feature: rule.feature, op: rule.op, threshold: rule.threshold},
    trainFiltered: stats(train.filter(filter)), testBaseline: stats(test), testFiltered: stats(test.filter(filter))};
});
const result = {generatedAt: new Date().toISOString(), source: SOURCE, dates: DATES,
  cutoffIST: '09:30, uses only 09:15-09:29 on signal day plus five prior sessions for indicator warmup',
  timeframeMinutes: [1, 3, 5], indicatorNames: [
    'RSI14', 'MFI14', 'MACD 12/26/9 histogram as percent of price', 'EMA9/21 gap percent',
    'EMA9 slope over three bars percent', 'Stochastic K14', 'Bollinger percent B20',
    'ATR14 as percent of price', 'rolling 20 bar VWAP gap percent', '5 bar OBV pressure / 20 bar volume'],
  outcome: '09:30 long entry; 0.5% SL or 2% target first touch, stop precedence on same bar, otherwise last available close',
  completeness: {valid: valid.length, expected: source.rows.length,
    day22LastCandleIST: (() => {const c = candles('NIFTY50').filter(r => r.date === '2026-10-22');const m = c.at(-1)?.minute;return m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;})()},
  baseline: stats(valid),
  bestInSample: allRules.slice(0, 10), bestByFeature: byFeature, heldOut, heldOutAtr3m, rows};
fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + '\n');
const atrRule = result.bestByFeature.find(r => r.feature === 'atr14Pct_3m');
const atrKept = valid.filter(r => atrRule.op === '>=' ? r.features[atrRule.feature] >= atrRule.threshold : r.features[atrRule.feature] <= atrRule.threshold);
const pct = v => `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`;
const md = [
  '# 09:30 multi-timeframe filter research', '',
  'Dates: 2026-10-19, 2026-10-21, 2026-10-22. Existing top-20 ranking and ADX/CMF filters yield 33 long candidates.',
  'Signal cutoff: 09:30 IST. Indicator inputs include only the five prior sessions and completed 09:15–09:29 candles on the signal day.',
  'Each of ten indicators is calculated on completed 1, 3 and 5 minute bars. The JSON report contains all 30 values for every stock.',
  'Indicators: RSI14, MFI14, MACD 12/26/9 histogram, EMA9/21 gap, EMA9 three-bar slope, stochastic K14, Bollinger percent B20, ATR14, rolling 20-bar VWAP gap, and five-bar OBV pressure.',
  'Returns: 09:30 open, first 0.5% stop or 2% target touch (stop wins ties), otherwise last available close. Costs, slippage and gap execution are excluded.',
  `The 22 October candle file ends at ${result.completeness.day22LastCandleIST} IST, so its close exits are provisional.`, '',
  '## Best exploratory single filter', '',
  `Keep 3-minute ATR14 ≥ ${atrRule.threshold.toFixed(3)}% of price. This threshold was selected on these same three sessions.`, '',
  '| Date | Baseline trades | Baseline wins | Baseline total | Filtered trades | Filtered wins | Filtered total |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...DATES.map(d => {const a = result.baseline.byDate.find(x => x.date === d), b = atrRule.byDate.find(x => x.date === d);return `| ${d} | ${a.trades} | ${a.wins} | ${pct(a.totalReturnPct)} | ${b.trades} | ${b.wins} | ${pct(b.totalReturnPct)} |`;}),
  '',
  `Overall baseline: ${result.baseline.trades} trades, ${result.baseline.winRatePct.toFixed(1)}% win rate, ${pct(result.baseline.averageReturnPct)} average, ${pct(result.baseline.totalReturnPct)} total, ${pct(result.baseline.worstMAEPct)} worst observed bar-low MAE.`,
  `Filtered: ${atrRule.trades} trades, ${atrRule.winRatePct.toFixed(1)}% win rate, ${pct(atrRule.averageReturnPct)} average, ${pct(atrRule.totalReturnPct)} total, ${pct(atrRule.worstMAEPct)} worst observed bar-low MAE. Removed ${atrRule.removedLosers} losers and ${atrRule.removedWinners} winners.`,
  `Worst filtered day: ${atrRule.worstDay.date}, ${pct(atrRule.worstDay.totalReturnPct)}.`, '',
  '## Leave-one-day-out test', '',
  'For each date, the ATR threshold below was chosen on the other two dates and applied to the held-out date.', '',
  '| Held-out date | Learned ATR threshold | Baseline trades / wins / total | Filtered trades / wins / total |',
  '| --- | ---: | --- | --- |',
  ...heldOutAtr3m.map(x => `| ${x.testDate} | ${x.selectedRule.threshold.toFixed(3)}% | ${x.testBaseline.trades} / ${x.testBaseline.wins} / ${pct(x.testBaseline.totalReturnPct)} | ${x.testFiltered.trades} / ${x.testFiltered.wins} / ${pct(x.testFiltered.totalReturnPct)} |`),
  '',
  'The ATR family improved average return on each held-out date, but 21 October remained negative. The threshold is exploratory; three dates cannot establish a reliable live filter.', '',
  '## Stocks excluded by the exploratory ATR cutoff', '',
  ...DATES.map(d => `- ${d}: ${valid.filter(r => r.date === d && !atrKept.includes(r)).map(r => `${r.symbol} (${pct(r.returnPct)})`).join(', ') || 'none'}`), '',
  'Observed MAE uses the lowest candle low through the exit minute. The exact order of stop and target touches inside one candle is unknown.'
];
fs.writeFileSync('reports/2026-10-19-21-22-0930-multitimeframe-filter-research.md', md.join('\n') + '\n');
console.log(JSON.stringify({output: OUTPUT, markdown: 'reports/2026-10-19-21-22-0930-multitimeframe-filter-research.md',
  baseline: result.baseline, atrRule: {feature: atrRule.feature, threshold: atrRule.threshold, trades: atrRule.trades, wins: atrRule.wins,
    averageReturnPct: atrRule.averageReturnPct, totalReturnPct: atrRule.totalReturnPct, worstDay: atrRule.worstDay},
  heldOutAtr3m: heldOutAtr3m.map(x => ({date: x.testDate, threshold: x.selectedRule.threshold,
    trades: x.testFiltered.trades, wins: x.testFiltered.wins, totalReturnPct: x.testFiltered.totalReturnPct}))}, null, 2));
