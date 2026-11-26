const fs = require('fs');
const path = require('path');

const DATE = '2026-10-22';
const rankingPath = `reports/${DATE}-0930-five-factor-strength-ranking.json`;
const outputJson = `reports/${DATE}-top20-confirmed-buy-sell-report.json`;
const outputCsv = `csv/${DATE}-top20-confirmed-buy-sell-trades.csv`;
const ranking = JSON.parse(fs.readFileSync(rankingPath, 'utf8')).ranking.slice(0, 20);
const ist = t => new Date(Number(t) * 1000 + 330 * 60000);
const round = (x, n = 4) => Number.isFinite(x) ? Number(x.toFixed(n)) : null;

function loadCandles(symbol) {
  const file = path.join('db', 'candles', `${symbol.replace(/-EQ$/, '')}.jsonl`);
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(r => {
    const d = ist(r.time);
    return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume };
  }).filter(r => r.date === DATE && r.minute >= 555 && r.minute <= 929);
}
function ema(values, period) { const k = 2 / (period + 1); let e = values[0]; for (const x of values.slice(1)) e = x * k + e * (1 - k); return e; }
function rsi(values, period = 14) { const x = values.slice(-(period + 1)); if (x.length < period + 1) return null; let g = 0, l = 0; for (let i = 1; i < x.length; i++) { const d = x[i] - x[i - 1]; if (d > 0) g += d; else l -= d; } const ag = g / period, al = l / period; return al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
function mfi(rows, period = 14) { const x = rows.slice(-(period + 1)); if (x.length < period + 1) return null; let pos = 0, neg = 0; for (let i = 1; i < x.length; i++) { const tp = (x[i].high + x[i].low + x[i].close) / 3, pp = (x[i - 1].high + x[i - 1].low + x[i - 1].close) / 3, flow = tp * x[i].volume; if (tp > pp) pos += flow; else if (tp < pp) neg += flow; } return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg); }
function hhmm(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
function features(rows, i) {
  const seen = rows.slice(0, i + 1), before = rows.slice(0, i), closes = seen.map(x => x.close), c = rows[i];
  const vol = seen.reduce((s, x) => s + x.volume, 0), vwap = seen.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / (vol || 1), range = c.high - c.low || 1;
  const priorHigh = Math.max(...before.map(x => x.high)), priorLow = Math.min(...before.map(x => x.low));
  return { ema9: ema(closes, 9), ema20: ema(closes, 20), ema45: ema(closes, 45), vwap, rsi14: rsi(closes), mfi14: mfi(seen), bullish: c.close > c.open, bearish: c.close < c.open, closeLocation: (c.close - c.low) / range, priorHigh, priorLow, brokeHigh: c.close > priorHigh, brokeLow: c.close < priorLow };
}
function confirmation(rows) {
  const opening = rows.filter(x => x.minute >= 555 && x.minute < 570), openingHigh = Math.max(...opening.map(x => x.high)), openingLow = Math.min(...opening.map(x => x.low));
  for (let i = 14; i < rows.length - 1 && rows[i].minute <= 900; i++) {
    const f = features(rows, i), c = rows[i];
    const buy = f.brokeHigh && f.ema9 > f.ema20 && f.ema20 > f.ema45 && c.close > f.vwap && f.rsi14 >= 60 && f.mfi14 >= 55 && f.bullish && f.closeLocation >= 0.65;
    const sell = f.brokeLow && f.ema9 < f.ema20 && c.close < f.ema45 && c.close < f.vwap && f.rsi14 <= 45 && f.mfi14 <= 45 && f.bearish && f.closeLocation <= 0.35;
    if (buy || sell) return { index: i, side: buy ? 'BUY' : 'SELL', openingHigh, openingLow, ...f };
  }
  return null;
}
function simulate(row, rows, sig) {
  const entryIndex = sig.index + 1, entry = rows[entryIndex], side = sig.side, dir = side === 'BUY' ? 1 : -1, stop = entry.open * (1 - dir * 0.005), target = entry.open * (1 + dir * 0.02); let exit = null, mae = 0;
  for (let i = entryIndex; i < rows.length; i++) { const c = rows[i], adverse = dir * (c.low / entry.open - 1) * 100, adverseShort = dir === -1 ? 100 * (entry.open / c.high - 1) : adverse; mae = Math.min(mae, dir === 1 ? adverse : adverseShort); const stopHit = dir === 1 ? c.low <= stop : c.high >= stop, targetHit = dir === 1 ? c.high >= target : c.low <= target; if (stopHit) { exit = { price: stop, minute: c.minute, reason: 'SL' }; break; } if (targetHit) { exit = { price: target, minute: c.minute, reason: 'TARGET' }; break; } }
  if (!exit) { const c = rows.at(-1); exit = { price: c.close, minute: c.minute, reason: 'CLOSE' }; }
  const ret = dir * 100 * (exit.price / entry.open - 1);
  return { rank: row.rank, symbol: row.symbol, score: row.totalScore, side, signalTime: hhmm(rows[sig.index].minute), entryTime: hhmm(entry.minute), entryPrice: round(entry.open), exitTime: hhmm(exit.minute), exitPrice: round(exit.price), exitReason: exit.reason, returnPct: round(ret), maePct: round(mae), rsi14: round(sig.rsi14), mfi14: round(sig.mfi14), ema9: round(sig.ema9), ema20: round(sig.ema20), ema45: round(sig.ema45), vwap: round(sig.vwap), openingHigh: round(sig.openingHigh), openingLow: round(sig.openingLow) };
}

const evaluations = ranking.map(row => { const rows = loadCandles(row.symbol), sig = confirmation(rows); return sig ? { status: 'TRADE', ...simulate(row, rows, sig) } : { status: 'NO_TRADE', rank: row.rank, symbol: row.symbol, score: row.totalScore }; });
const trades = evaluations.filter(x => x.status === 'TRADE').sort((a,b) => a.signalTime.localeCompare(b.signalTime) || a.symbol.localeCompare(b.symbol)), noTrades = evaluations.filter(x => x.status === 'NO_TRADE');
const wins = trades.filter(x => x.returnPct > 0).length, total = trades.reduce((s, x) => s + x.returnPct, 0), worstMae = trades.length ? Math.min(...trades.map(x => x.maePct)) : null;
const summary = { tradeCount: trades.length, winners: wins, losers: trades.length - wins, winRatePct: round(100 * wins / (trades.length || 1)), averageReturnPct: round(total / (trades.length || 1)), totalReturnPct: round(total), maximumAdverseExcursionPct: round(worstMae), worstDay: { date: DATE, totalReturnPct: round(total) }, buyTrades: trades.filter(x => x.side === 'BUY').length, sellTrades: trades.filter(x => x.side === 'SELL').length, noTradeCount: noTrades.length };
const methodology = { ranking: 'Top 20 from the existing 100-point 09:30 five-factor ranking.', confirmationWindow: 'Completed 1-minute candles processed strictly in order from 09:29 through 15:00 IST.', buy: 'Fresh close above every earlier session high; EMA9 > EMA20 > EMA45; close > cumulative VWAP; RSI14 >= 60; MFI14 >= 55; bullish candle closing in upper 35% of its range.', sell: 'Fresh close below every earlier session low; EMA9 < EMA20; close < EMA45 and VWAP; RSI14 <= 45; MFI14 <= 45; bearish candle closing in lower 35% of its range.', execution: 'Use only the first confirmation per stock and enter at the next one-minute candle open. Exit on 0.5% stop, 2% target, or the last available candle. Same-candle stop has priority.' };
fs.writeFileSync(outputJson, JSON.stringify({ date: DATE, methodology, summary, trades, noTrades, evaluations }, null, 2) + '\n');
const cols = ['rank','symbol','score','status','side','signalTime','entryTime','entryPrice','exitTime','exitPrice','exitReason','returnPct','maePct','rsi14','mfi14'];
fs.writeFileSync(outputCsv, [cols.join(','), ...[...trades,...noTrades].map(x => cols.map(c => x[c] ?? '').join(','))].join('\n') + '\n');
console.log(JSON.stringify({ outputJson, outputCsv, summary, trades, noTrades }, null, 2));
