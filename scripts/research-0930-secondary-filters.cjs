const fs = require('fs');
const path = require('path');
const first = JSON.parse(fs.readFileSync('reports/2026-10-19-21-22-0930-multitimeframe-filter-research.json', 'utf8'));
const cutoff = first.bestByFeature.find(x => x.feature === 'atr14Pct_3m').threshold;
const prior = {
  '2026-10-19': ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'],
  '2026-10-21': ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19'],
  '2026-10-22': ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-21']
};
const round = n => Number.isFinite(n) ? Number(n.toFixed(6)) : null;
function candles(symbol) {
  const file = path.join('db', 'candles', `${symbol.replace(/-EQ$/, '')}.jsonl`);
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(r => {
    const d = new Date(r.time * 1000 + 330 * 60000);
    return {date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume};
  });
}
const cache = new Map();
function get(symbol) {if (!cache.has(symbol)) cache.set(symbol, candles(symbol));return cache.get(symbol);}
function angle(bars) {
  const n = bars.length, y = bars.map(b => Math.log(b.close));
  const mx = (n - 1) / 2, my = y.reduce((s, v) => s + v, 0) / n;
  const slope = y.reduce((s, v, i) => s + (i - mx) * (v - my), 0) /
    Array.from({length: n}, (_, i) => (i - mx) ** 2).reduce((s, v) => s + v, 0);
  return Math.atan(slope * 100) * 180 / Math.PI;
}
function resample(opening, width) {
  const out = [];
  for (let i = 0; i < opening.length; i += width) {
    const b = opening.slice(i, i + width);
    if (b.length !== width) continue;
    out.push({open: b[0].open, close: b.at(-1).close, high: Math.max(...b.map(x => x.high)),
      low: Math.min(...b.map(x => x.low)), volume: b.reduce((s, x) => s + x.volume, 0)});
  }
  return out;
}
function features(symbol, date) {
  const rows = get(symbol), opening = rows.filter(r => r.date === date && r.minute >= 555 && r.minute < 570);
  if (opening.length !== 15) throw new Error(`Missing opening candles: ${symbol} ${date}`);
  const tf3 = resample(opening, 3), tf5 = resample(opening, 5);
  const sum = a => a.reduce((s, v) => s + v, 0);
  const todayVolume = sum(opening.map(r => r.volume));
  const priorVolumes = prior[date].map(d => sum(rows.filter(r => r.date === d && r.minute >= 555 && r.minute < 570).map(r => r.volume)));
  const priorAvg = sum(priorVolumes) / priorVolumes.length;
  const firstFive = sum(opening.slice(0, 5).map(r => r.volume));
  const lastFive = sum(opening.slice(-5).map(r => r.volume));
  const high = Math.max(...opening.map(r => r.high)), low = Math.min(...opening.map(r => r.low));
  const path = sum(opening.slice(1).map((r, i) => Math.abs(r.close - opening[i].close)));
  const signedVolume = sum(opening.map(r => Math.sign(r.close - r.open) * r.volume));
  const market = get('NIFTY50').filter(r => r.date === date && r.minute >= 555 && r.minute < 570);
  const stockReturn = 100 * (opening.at(-1).close / opening[0].open - 1);
  const marketReturn = 100 * (market.at(-1).close / market[0].open - 1);
  const values = {
    trendAngle1m15: angle(opening), trendAngle1m10: angle(opening.slice(-10)),
    trendAngle1m5: angle(opening.slice(-5)), trendAngle3m5: angle(tf3),
    trendAngle3m3: angle(tf3.slice(-3)), trendAngle5m3: angle(tf5),
    volumeRatioPrior5: todayVolume / priorAvg,
    volumeLateEarlyRatio: lastFive / (firstFive || 1),
    signedVolumePressure: signedVolume / (todayVolume || 1),
    upCandleFraction: opening.filter(r => r.close > r.open).length / 15,
    higherCloseFraction: opening.slice(1).filter((r, i) => r.close > opening[i].close).length / 14,
    pricePathEfficiency: Math.abs(opening.at(-1).close - opening[0].close) / (path || 1),
    openingRangeCloseLocation: (opening.at(-1).close - low) / (high - low || 1),
    relativeStrengthVsNiftyPct: stockReturn - marketReturn,
    last5mVolumeShare: lastFive / (todayVolume || 1),
    last5mReturnPct: 100 * (opening.at(-1).close / opening[10].open - 1)
  };
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round(v)]));
}
const rows = first.rows.filter(r => r.features.atr14Pct_3m >= cutoff).map(r => ({
  date: r.date, symbol: r.symbol, returnPct: r.returnPct, observedMaePct: r.maePct,
  indicators: {...r.features, ...features(r.symbol, r.date)}
}));
const names = Object.keys(rows[0].indicators);
const baseline = {trades: rows.length, wins: rows.filter(r => r.returnPct > 0).length,
  totalReturnPct: round(rows.reduce((s, r) => s + r.returnPct, 0))};
const rules = [];
for (const name of names) {
  const values = [...new Set(rows.map(r => r.indicators[name]))].sort((a, b) => a - b);
  for (let i = 0; i < values.length - 1; i++) {
    const cutoff2 = (values[i] + values[i + 1]) / 2;
    for (const op of ['>=', '<=']) {
      const kept = rows.filter(r => op === '>=' ? r.indicators[name] >= cutoff2 : r.indicators[name] <= cutoff2);
      if (kept.length < 9 || kept.length > 16) continue;
      const wins = kept.filter(r => r.returnPct > 0).length;
      const removedWinners = baseline.wins - wins;
      const removedLosers = baseline.trades - baseline.wins - (kept.length - wins);
      const total = kept.reduce((s, r) => s + r.returnPct, 0);
      rules.push({indicator: name, op, threshold: round(cutoff2), trades: kept.length,
        wins, losers: kept.length - wins, removedWinners, removedLosers,
        winRatePct: round(100 * wins / kept.length), averageReturnPct: round(total / kept.length),
        totalReturnPct: round(total), byDate: first.dates.map(date => {
          const a = kept.filter(r => r.date === date);
          return {date, trades: a.length, wins: a.filter(r => r.returnPct > 0).length,
            totalReturnPct: round(a.reduce((s, r) => s + r.returnPct, 0))};
        })});
    }
  }
}
rules.sort((a, b) => b.averageReturnPct - a.averageReturnPct || b.wins - a.wins);
const byIndicator = names.map(n => rules.find(r => r.indicator === n)).filter(Boolean);
const out = {generatedAt: new Date().toISOString(), cutoffIST: '09:30',
  priorFilter: `3-minute ATR14 >= ${cutoff}%`, baseline, featureCount: names.length,
  bestInSample: rules.slice(0, 20), bestByIndicator: byIndicator, rows};
const output = 'reports/2026-10-19-21-22-0930-secondary-filter-research.json';
fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({output, baseline, bestInSample: out.bestInSample.slice(0, 10)}, null, 2));
