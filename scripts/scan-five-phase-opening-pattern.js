import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), tradeDate = process.argv[2] ?? '2026-11-11'
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const sum = xs => xs.reduce((a, b) => a + b, 0)
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).replace(/-EQ$/i, '').toUpperCase()))]

function scan(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try {
      const x = JSON.parse(line), stamp = local(+x.time)
      return { stamp, date: stamp.slice(0, 10), minute: stamp.slice(11), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }
    } catch { return null }
  }).filter(x => x && x.date === tradeDate && x.minute >= '09:15' && x.minute <= '09:40').sort((a, b) => a.stamp.localeCompare(b.stamp))
  if (rows.length !== 26 || rows.some(x => ![x.open, x.high, x.low, x.close, x.volume].every(Number.isFinite))) return null
  let pv = 0, volume = 0
  for (const x of rows) { pv += ((x.high + x.low + x.close) / 3) * x.volume; volume += x.volume; x.vwap = pv / volume }
  const first = rows[0]
  const weakOpening = first.close < first.open * 0.999 && Math.min(rows[0].low, rows[1].low) < first.open * 0.998
  let peakIndex = -1, peakClose = -Infinity
  for (let i = 2; i <= 14; i++) if (rows[i].close > peakClose) { peakClose = rows[i].close; peakIndex = i }
  const recoveryPct = 100 * (peakClose / first.close - 1)
  const strongRecovery = recoveryPct >= 0.3 && peakIndex >= 2
  let pullbackIndex = -1, pullbackClose = Infinity
  if (strongRecovery) {
    for (let i = peakIndex + 2; i <= 22; i++) if (rows[i].close < pullbackClose) { pullbackClose = rows[i].close; pullbackIndex = i }
  }
  const pullbackPct = strongRecovery ? 100 * (pullbackClose / peakClose - 1) : 0
  const pullback = strongRecovery && pullbackIndex > peakIndex && pullbackPct <= -0.15
  const renewedRisePct = pullback ? 100 * (rows.at(-1).close / pullbackClose - 1) : 0
  const renewedRise = pullback && renewedRisePct >= 0.15
  const rangeHigh = Math.max(...rows.map(x => x.high)), rangeLow = Math.min(...rows.map(x => x.low)), last = rows.at(-1)
  const closeLocationPct = 100 * (last.close - rangeLow) / (rangeHigh - rangeLow || 1)
  const freshPush = renewedRise && last.close > rows.at(-2).close && last.close >= rows.at(-4).close && closeLocationPct >= 80
  const eligible = weakOpening && strongRecovery && pullback && renewedRise && freshPush
  return { symbol, weak_opening: weakOpening ? 'yes' : 'no', strong_recovery: strongRecovery ? 'yes' : 'no', pullback: pullback ? 'yes' : 'no', renewed_rise: renewedRise ? 'yes' : 'no', fresh_push_higher: freshPush ? 'yes' : 'no', eligible: eligible ? 'yes' : 'no', recovery_peak_time: rows[peakIndex]?.minute ?? '', recovery_pct: round(recoveryPct), pullback_time: rows[pullbackIndex]?.minute ?? '', pullback_pct: round(pullbackPct), renewed_rise_pct: round(renewedRisePct), close_0940: last.close, vwap_0940: round(last.vwap), close_vs_vwap_pct: round(100 * (last.close / last.vwap - 1)), close_location_pct: round(closeLocationPct), final_candle_pct: round(100 * (last.close / last.open - 1)) }
}

const rows = []
for (let i = 0; i < symbols.length; i++) {
  const row = scan(symbols[i]); if (row) rows.push(row)
  const width = 26, filled = Math.round(width * (i + 1) / symbols.length)
  process.stderr.write(`\r[${'='.repeat(filled)}${'-'.repeat(width - filled)}] ${i + 1}/${symbols.length}`)
}
process.stderr.write('\n')
const eligible = rows.filter(x => x.eligible === 'yes').sort((a, b) => b.recovery_pct - a.recovery_pct)
const columns = Object.keys(eligible[0] ?? rows[0] ?? { symbol: '' })
const stem = `${tradeDate}-0915-0940-five-phase-opening-pattern`
let output = path.join(root, 'reports', `${stem}.csv`), n = 2
while (fs.existsSync(output)) output = path.join(root, 'reports', `${stem}-${n++}.csv`)
fs.writeFileSync(output, [columns.join(','), ...eligible.map(row => columns.map(c => row[c] ?? '').join(','))].join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ tradeDate, universe: symbols.length, analyzed: rows.length, eligibleCount: eligible.length, eligible, definitions: { weakOpening: '09:15 close <= open -0.10% and first-two-candle low <= open -0.20%', strongRecovery: 'peak close through 09:29 >= first close +0.30%', pullback: 'later close drawdown >=0.15% from recovery peak', renewedRise: '09:40 close >= pullback low close +0.15%', freshPush: '09:40 close above prior candles, final candle green, close in top 20% of range' }, output }, null, 2))
