import fs from 'fs';
import path from 'path';

const DATE = '2026-11-23';
const signals = [
  ['RVNL', '09:20'], ['CHOLAFIN', '09:20'], ['ADANIPORTS', '09:21'],
  ['ADANIENSOL', '09:21'], ['ADANIENT', '09:21'], ['ADANIGREEN', '09:21'],
  ['FEDERALBNK', '09:22'], ['AUBANK', '09:23'], ['NTPC', '09:25'], ['INDUSINDBK', '09:25'],
];
const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const minute = c => fmt.format(new Date(c.time * 1000)).replace(' ', 'T').slice(11);
const round = x => Number(x.toFixed(2));

function candles(symbol) {
  return fs.readFileSync(path.join('db', 'candles', `${symbol}.jsonl`), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    .filter(c => fmt.format(new Date(c.time * 1000)).startsWith(DATE));
}

function replay(symbol, entryTime) {
  const bars = candles(symbol);
  const entryIndex = bars.findIndex(c => minute(c) === entryTime);
  const entry = bars[entryIndex].close; // Signal minute is complete: entry is its close.
  let stop = bars[entryIndex].high + 0.05; // Active confirmation/retest high + one tick.
  const initialStop = stop;
  let trailActive = false;
  const events = [];
  for (let i = entryIndex + 1; i < bars.length; i++) {
    const c = bars[i];
    if (c.high >= stop) {
      return finish(symbol, entryTime, entry, initialStop, minute(c), stop, events.concat(`${minute(c)} stop`));
    }
    // A completed 1-minute bar makes a fresh five-minute low.  From the next bar onward,
    // protect above the preceding two completed highs; the stop can only move downward.
    if (i >= 5 && c.low < Math.min(...bars.slice(i - 5, i).map(x => x.low))) {
      const lowerHigh = Math.max(...bars.slice(i - 2, i).map(x => x.high)) + 0.05;
      if (lowerHigh < stop) {
        stop = lowerHigh;
        trailActive = true;
        events.push(`${minute(c)} trail ${round(stop)}`);
      }
    }
    // Confirmed buyer reversal: close above the active trailing level exits at this completed close.
    if (trailActive && c.close > stop) {
      return finish(symbol, entryTime, entry, initialStop, minute(c), c.close, events.concat(`${minute(c)} close-trail`));
    }
  }
  const last = bars.at(-1);
  return finish(symbol, entryTime, entry, initialStop, minute(last), last.close, events.concat(`${minute(last)} time exit`));
}

function finish(symbol, entryTime, entry, initialStop, exitTime, exit, events) {
  return {
    symbol, entryTime, entry: round(entry), initialSL: round(initialStop), initialRiskPct: Number(((initialStop / entry - 1) * 100).toFixed(3)),
    exitTime, exit: round(exit), returnPct: Number(((entry / exit - 1) * 100).toFixed(3)), events: events.join('; '),
  };
}

const results = signals.map(x => replay(...x));
const columns = ['symbol', 'entryTime', 'entry', 'initialSL', 'initialRiskPct', 'exitTime', 'exit', 'returnPct', 'events'];
const quote = v => /[,\"]/.test(String(v)) ? `\"${String(v).replaceAll('\"', '\"\"')}\"` : String(v);
fs.writeFileSync(path.join('reports', '2026-11-23-opening-sell-runner-replay.csv'), [columns.join(','), ...results.map(r => columns.map(k => quote(r[k])).join(','))].join('\n') + '\n');
for (const r of results) console.log([r.symbol, r.entry, r.initialSL, r.exitTime, r.exit, r.returnPct, r.events].join(' | '));
const returns = results.map(r => r.returnPct);
console.log(JSON.stringify({ trades: results.length, wins: returns.filter(r => r > 0).length, winRatePct: Number((returns.filter(r => r > 0).length / results.length * 100).toFixed(1)), averageReturnPct: Number((returns.reduce((a,b) => a+b, 0) / results.length).toFixed(3)), totalReturnPct: Number(returns.reduce((a,b) => a+b, 0).toFixed(3)), worstTradePct: Math.min(...returns) }));
