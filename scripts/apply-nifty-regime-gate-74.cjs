const fs = require('fs');

const reportPath = 'reports/2026-10-12-to-2026-10-16-top20-adx-cmf-atr-report.json';
const outJson = 'reports/2026-10-12-to-2026-10-16-top20-adx-cmf-atr-nifty-gate-report.json';
const outCsv = 'csv/2026-10-12-to-2026-10-16-top20-adx-cmf-atr-nifty-gate-trades.csv';

const trades = JSON.parse(fs.readFileSync(reportPath, 'utf8')).trades;
const rows = fs.readFileSync('db/candles/NIFTY50.jsonl', 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const ist = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function parts(t) { const p = Object.fromEntries(ist.formatToParts(new Date(t * 1000)).filter(x => x.type !== 'literal').map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` }; }
const byDay = new Map();
for (const r of rows) { const x = parts(r.time); if (!byDay.has(x.date)) byDay.set(x.date, []); byDay.get(x.date).push(r); }
function vwap(rs) { const v = rs.reduce((a, r) => a + r.volume, 0); return rs.reduce((a, r) => a + ((r.high + r.low + r.close) / 3) * r.volume, 0) / (v || 1); }
function ema(rs, n = 20) { let e = rs[0]?.close; const k = 2 / (n + 1); for (const r of rs.slice(1)) e = r.close * k + e * (1 - k); return e; }
const regime = {};
for (const [date, all] of byDay) {
  const pre = all.filter(r => { const x = parts(r.time); return x.hm >= '09:15' && x.hm <= '09:29'; });
  if (!pre.length) continue;
  const first = pre[0], last = pre.at(-1), ret = 100 * (last.close / first.open - 1), vw = vwap(pre), e20 = ema(pre);
  regime[date] = { niftyOpen: first.open, niftyClose0929: last.close, niftyReturn15mPct: ret, niftyVwap: vw, niftyEma20: e20, niftyCloseVsVwapPct: 100 * (last.close / vw - 1), niftyCloseVsEma20Pct: 100 * (last.close / e20 - 1), preBars: pre.length };
}
function gate(t) {
  const n = regime[t.date]; if (!n) return { pass: false, reason: 'missing NIFTY pre-entry data' };
  const bullish = t.side === 'BUY';
  const direction = bullish ? n.niftyReturn15mPct >= 0 : n.niftyReturn15mPct <= 0;
  const location = bullish ? (n.niftyClose0929 >= n.niftyVwap && n.niftyClose0929 >= n.niftyEma20) : (n.niftyClose0929 <= n.niftyVwap && n.niftyClose0929 <= n.niftyEma20);
  return { pass: direction && location, reason: `${direction ? 'direction_ok' : 'direction_mismatch'};${location ? 'location_ok' : 'location_mismatch'}` };
}
const enriched = trades.map(t => ({ ...t, ...regime[t.date], niftyGate: gate(t).pass, niftyGateReason: gate(t).reason }));
const kept = enriched.filter(t => t.niftyGate);
const rejected = enriched.filter(t => !t.niftyGate);
function stats(rs) { const wins = rs.filter(t => t.returnPct > 0); const losers = rs.filter(t => t.returnPct <= 0); const total = rs.reduce((a, t) => a + t.returnPct, 0); return { trades: rs.length, winners: wins.length, losers: losers.length, winRatePct: rs.length ? 100 * wins.length / rs.length : 0, averageReturnPct: rs.length ? total / rs.length : 0, totalReturnPct: total }; }
const result = { generatedAt: new Date().toISOString(), method: 'Existing top20 + ADX/CMF/ATR trades; accept BUY only when NIFTY 09:15-09:29 return >= 0 and 09:29 close is at/above session VWAP and EMA20; reverse for SELL. All NIFTY inputs precede 09:30 entry.', baseline: stats(enriched), accepted: stats(kept), rejected: stats(rejected), regimeByDate: regime, trades: enriched };
fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
const cols = ['date','symbol','side','score','returnPct','exitType','niftyReturn15mPct','niftyCloseVsVwapPct','niftyCloseVsEma20Pct','niftyGate','niftyGateReason'];
fs.writeFileSync(outCsv, [cols.join(','), ...enriched.map(t => cols.map(c => JSON.stringify(t[c] ?? '')).join(','))].join('\n') + '\n');
console.log(JSON.stringify({ baseline: result.baseline, accepted: result.accepted, rejected: result.rejected, regimeByDate: regime, files: { json: outJson, csv: outCsv } }, null, 2));
