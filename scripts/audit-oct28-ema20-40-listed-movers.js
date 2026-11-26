import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const DATE = '2026-10-28'
const IST = 330 * 60_000
const SYMBOLS = ['TITAGARH','VOLTAS','PATANJALI','BIOCON','KPITTECH','CHOLAFIN','PGEL','UPL','SYNGENE','BLUESTARCO','KAYNES','PIDILITIND','SAIL','UNITDSPR','RELIANCE','PRESTIGE','BAJAJHLDNG','PETRONET','APLAPOLLO','SWIGGY']
const round = (n, p = 3) => Number.isFinite(n) ? +n.toFixed(p) : null
const day = t => new Date(t + IST).toISOString().slice(0, 10)
const time = t => new Date(t + IST).toISOString().slice(11, 16)
const pct = (x, base) => 100 * (x / base - 1)
const csv = x => /[",\n]/.test(String(x ?? '')) ? `"${String(x ?? '').replaceAll('"', '""')}"` : String(x ?? '')
const outputPath = (() => { let n = 1, file; do { file = path.join(ROOT, 'reports', `${DATE}-ema20-ema40-listed-movers-cross-audit${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file)); return file })()
const csvPath = outputPath.replace(/\.json$/, '.csv')

function load(symbol) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
    try {
      const x = JSON.parse(line), t = Number(x.time) * 1000
      const row = { t, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume }
      return Object.values(row).every(Number.isFinite) && day(t) <= DATE ? [row] : []
    } catch { return [] }
  }).sort((a, b) => a.t - b.t)
  let e20, e40
  for (const row of all) {
    e20 = e20 == null ? row.c : e20 + 2 / 21 * (row.c - e20)
    e40 = e40 == null ? row.c : e40 + 2 / 41 * (row.c - e40)
    row.e20 = e20; row.e40 = e40; row.sign = Math.sign(e20 - e40)
  }
  return all.filter(row => day(row.t) === DATE)
}

const allTrades = []
for (const symbol of SYMBOLS) {
  const rows = load(symbol)
  for (let i = 1; i < rows.length - 1; i++) {
    const prior = rows[i - 1], signal = rows[i]
    if (!prior.sign || !signal.sign || prior.sign === signal.sign) continue
    const side = signal.sign > 0 ? 'BUY' : 'SELL'
    const entry = rows[i + 1]
    let exitIndex = rows.length - 1, exitReason = 'EOD'
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j - 1].sign && rows[j].sign && rows[j - 1].sign !== rows[j].sign) { exitIndex = j; exitReason = 'OPPOSITE_CROSS_CLOSE'; break }
    }
    const exit = rows[exitIndex]
    const direction = side === 'BUY' ? 1 : -1
    const returnPct = direction * pct(exit.c, entry.o)
    const window = rows.slice(i + 1, exitIndex + 1)
    const mae = direction === 1 ? Math.min(...window.map(x => pct(x.l, entry.o))) : Math.min(...window.map(x => pct(entry.o, x.h)))
    const mfe = direction === 1 ? Math.max(...window.map(x => pct(x.h, entry.o))) : Math.max(...window.map(x => pct(entry.o, x.l)))
    const prior20 = rows.slice(Math.max(0, i - 20), i)
    const avgVol20 = prior20.length ? prior20.reduce((s, x) => s + x.v, 0) / prior20.length : null
    allTrades.push({ symbol, side, signalTime: time(signal.t), entryTime: time(entry.t), entryPrice: round(entry.o), exitTime: time(exit.t), exitPrice: round(exit.c), exitReason, holdMinutes: exitIndex - i, returnPct: round(returnPct), maximumFavorableExcursionPct: round(mfe), maximumAdverseExcursionPct: round(mae), signalEmaGapBps: round(10000 * Math.abs(signal.e20 / signal.e40 - 1), 2), signalCloseVsEma20Pct: round(pct(signal.c, signal.e20)), signalVolumeVsPrior20: round(avgVol20 ? signal.v / avgVol20 : null, 2), signalCandleDirectional: side === 'BUY' ? signal.c > signal.o : signal.c < signal.o })
  }
}

const winners = allTrades.filter(x => x.returnPct > 1)
// This is deliberately a tiny, descriptive in-sample screen.  Every input below
// is known on the crossover candle; the later return is used only for evaluation.
const selectedRule = {
  name: 'EMA20/40 cross with decisive price separation and volume expansion',
  conditions: [
    'Absolute signal-close distance from EMA20 >= 0.40%',
    'Signal-candle volume >= 10.00 times the preceding 20 completed candles\' average volume',
  ],
}
const selected = allTrades.filter(x => Math.abs(x.signalCloseVsEma20Pct) >= 0.40 && x.signalVolumeVsPrior20 >= 10)
const selectedReturns = selected.map(x => x.returnPct)
const selectedSummary = {
  tradeCount: selected.length,
  winnersOver1Pct: selected.filter(x => x.returnPct > 1).length,
  winRatePct: round(100 * selected.filter(x => x.returnPct > 0).length / (selected.length || 1)),
  averageReturnPct: round(selectedReturns.reduce((sum, value) => sum + value, 0) / (selected.length || 1)),
  totalReturnPct: round(selectedReturns.reduce((sum, value) => sum + value, 0)),
  maximumAdverseExcursionPct: round(Math.min(...selected.map(x => x.maximumAdverseExcursionPct))),
  worstDay: { date: DATE, summedReturnPct: round(selectedReturns.reduce((sum, value) => sum + value, 0)) },
}
const report = {
  date: DATE,
  universe: 'The 10 intraday gainers and 10 intraday losers previously listed for 28 October; overnight gaps excluded only in forming that stock list.',
  methodology: 'EMA20 and EMA40 are continuous one-minute EMAs, seeded at each symbol\'s first locally available candle and updated only with completed candles through the signal candle. A cross is confirmed when EMA20 changes side of EMA40. Entry is the open of the next one-minute candle. Exit is the close of the first completed opposite-cross candle, otherwise the final session close. No post-signal candles are used to create a signal.',
  caveat: 'The winners-only subset is retrospective and cannot be known when the signal occurs. It is a pattern audit, not a live-selectable rule or validated strategy.',
  signalsFound: allTrades.length,
  winnersOver1Pct: winners.length,
  selectedRule,
  selectedSummary,
  selectedSignals: selected,
  winners,
  allSignals: allTrades
}
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
const fields = Object.keys(allTrades[0] ?? {})
fs.writeFileSync(csvPath, [fields.join(','), ...allTrades.map(row => fields.map(k => csv(row[k])).join(','))].join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ outputPath, csvPath, signalsFound: allTrades.length, winnersOver1Pct: winners.length, selectedRule, selectedSummary, selectedSignals: selected }, null, 2))
