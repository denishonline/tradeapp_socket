import fs from 'fs';
import path from 'path';

const DATE = '2026-11-23';
const signals = [
  ['RVNL', '09:15', '09:19', '09:20'],
  ['CHOLAFIN', '09:15', '09:19', '09:20'],
  ['ADANIPORTS', '09:16', '09:20', '09:21'],
  ['ADANIENSOL', '09:16', '09:20', '09:21'],
  ['ADANIENT', '09:16', '09:20', '09:21'],
  ['ADANIGREEN', '09:16', '09:20', '09:21'],
  ['FEDERALBNK', '09:17', '09:21', '09:22'],
  ['AUBANK', '09:18', '09:22', '09:23'],
  ['NTPC', '09:20', '09:24', '09:25'],
  ['INDUSINDBK', '09:20', '09:24', '09:25'],
];
const timeFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const istTime = (unixSeconds) => timeFormatter.format(new Date(unixSeconds * 1000)).replace(' ', 'T').slice(11);
const round = (n) => Number(n.toFixed(2));
const snapshotTime = (timestamp) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(timestamp));

function loadCandles(symbol) {
  return fs.readFileSync(path.join('db', 'candles', `${symbol}.jsonl`), 'utf8').trim()
    .split(/\r?\n/).map(JSON.parse)
    .filter(c => timeFormatter.format(new Date(c.time * 1000)).startsWith(DATE));
}

function loadDepthByMinute(symbol) {
  const rows = fs.readFileSync(path.join('db', 'cash-depth', DATE, symbol, `${symbol}.jsonl`), 'utf8').trim()
    .split(/\r?\n/).map(JSON.parse);
  const grouped = new Map();
  for (const row of rows) {
    const data = row.data;
    if (!data?.bid_price1) continue;
    const minute = snapshotTime(row.receivedAt);
    let bids = 0; let asks = 0;
    for (let level = 1; level <= 5; level++) {
      bids += data[`bid_size${level}`];
      asks += data[`ask_size${level}`];
    }
    if (!grouped.has(minute)) grouped.set(minute, []);
    grouped.get(minute).push({ bid: data.bid_price1, imbalance: (bids - asks) / (bids + asks) });
  }
  return grouped;
}

function depthBuyerReversal(samples) {
  if (!samples?.length) return false;
  const imbalance = samples.reduce((sum, x) => sum + x.imbalance, 0) / samples.length;
  let upwardBidSteps = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].bid > samples[i - 1].bid) upwardBidSteps++;
  return imbalance > 0.25 && upwardBidSteps >= 2;
}

function replay(symbol, start, end, entryTime) {
  const candles = loadCandles(symbol);
  const depthByMinute = loadDepthByMinute(symbol);
  const entryIndex = candles.findIndex(c => istTime(c.time) === entryTime);
  const entry = candles[entryIndex].open;
  const structure = candles.filter(c => istTime(c.time) >= start && istTime(c.time) <= end);
  const recent = candles.slice(Math.max(0, entryIndex - 3), entryIndex);
  const structuralStop = Math.max(...recent.map(c => c.high)) + 0.05;
  const structuralRiskPct = (structuralStop / entry - 1) * 100;
  if (structuralRiskPct > 0.70) {
    return { symbol, entryTime, entry: round(entry), status: 'SKIP', reason: `structural SL ${structuralRiskPct.toFixed(2)}% > 0.70%`, structuralStop: round(structuralStop) };
  }
  const risk = Math.max(structuralStop - entry, entry * 0.0025);
  let stop = entry + risk;
  const oneR = entry - risk;
  const onePointFiveR = entry - 1.5 * risk;
  let targetHit = false;
  let lockHit = false;
  let remaining = 1;
  let pnl = 0;
  const events = [];
  let exitTime = null;
  let exitPrice = null;
  let ema9 = null;
  for (let i = entryIndex; i < candles.length; i++) {
    const c = candles[i];
    const t = istTime(c.time);
    const allPrior = candles.slice(0, i + 1);
    ema9 = allPrior.reduce((ema, bar, index) => index === 0 ? bar.close : (bar.close * 0.2 + ema * 0.8), null);
    // Conservative OHLC ordering: an adverse stop has priority if both prices occur in one candle.
    if (c.high >= stop) {
      pnl += remaining * (entry - stop) / entry * 100;
      events.push(`${t} stop ${round(stop)}`);
      exitTime = t; exitPrice = stop; remaining = 0; break;
    }
    if (!targetHit && c.low <= oneR) {
      pnl += 0.5 * (entry - oneR) / entry * 100;
      remaining = 0.5; targetHit = true;
      stop = Math.min(stop, entry); // remaining shares cannot lose after +1R.
      events.push(`${t} half +1R ${round(oneR)}`);
    }
    if (targetHit && !lockHit && c.low <= onePointFiveR) {
      stop = Math.min(stop, entry - 0.75 * risk);
      lockHit = true;
      events.push(`${t} lock +0.75R`);
    }
    // The stop for the next candle is based only on three candles that have completed now.
    if (targetHit && i >= entryIndex + 2) {
      const high3 = Math.max(...candles.slice(i - 2, i + 1).map(x => x.high)) + 0.05;
      stop = Math.min(stop, high3);
    }
    // All inputs are available only after this candle completes; exit then, before the next candle.
    if (targetHit && c.close > ema9 && depthBuyerReversal(depthByMinute.get(t))) {
      pnl += remaining * (entry - c.close) / entry * 100;
      events.push(`${t} depth reversal ${round(c.close)}`);
      exitTime = t; exitPrice = c.close; remaining = 0; break;
    }
  }
  if (remaining > 0) {
    const last = candles.at(-1);
    pnl += remaining * (entry - last.close) / entry * 100;
    exitTime = istTime(last.time); exitPrice = last.close;
    events.push(`${exitTime} close ${round(exitPrice)}`);
  }
  return {
    symbol, entryTime, entry: round(entry), status: 'TRADED', structuralStop: round(structuralStop), riskPct: round(risk / entry * 100),
    oneR: round(oneR), exitTime, exitPrice: round(exitPrice), returnPct: Number(pnl.toFixed(3)), events: events.join('; '),
  };
}

const results = signals.map(args => replay(...args));
const columns = ['symbol', 'entryTime', 'entry', 'status', 'structuralStop', 'riskPct', 'oneR', 'exitTime', 'exitPrice', 'returnPct', 'reason', 'events'];
const quote = v => /[,\"]/.test(String(v ?? '')) ? `\"${String(v ?? '').replaceAll('\"', '\"\"')}\"` : String(v ?? '');
const csv = [columns.join(','), ...results.map(r => columns.map(c => quote(r[c])).join(','))].join('\n') + '\n';
const output = path.join('reports', '2026-11-23-opening-sell-dynamic-sl-exit-replay.csv');
fs.writeFileSync(output, csv);
for (const r of results) console.log([r.symbol, r.status, r.entry, r.structuralStop, r.riskPct, r.exitTime, r.returnPct, r.reason || r.events].join(' | '));
const trades = results.filter(r => r.status === 'TRADED');
const returns = trades.map(r => r.returnPct);
console.log(JSON.stringify({ trades: trades.length, skipped: results.length - trades.length, wins: returns.filter(x => x > 0).length, winRatePct: Number((100 * returns.filter(x => x > 0).length / trades.length).toFixed(1)), averageReturnPct: Number((returns.reduce((a,b)=>a+b,0)/trades.length).toFixed(3)), totalReturnPct: Number(returns.reduce((a,b)=>a+b,0).toFixed(3)), worstTradePct: Math.min(...returns) }));
