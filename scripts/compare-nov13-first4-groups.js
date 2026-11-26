import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2] ?? '2026-11-13'
const start = '09:15', cutoff = '09:18'
const option = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null }
const parseSymbols = value => value.split(',').map(x => x.trim().replace(/^NSE:/i, '').replace(/-EQ$/i, '')).filter(Boolean)
const group1 = option('--group1') ? parseSymbols(option('--group1')) : ['POWERINDIA', 'MCX', 'POLICYBZR']
const group2 = option('--group2') ? parseSymbols(option('--group2')) : ['MFSL', 'PATANJALI', 'BDL', 'FORTIS', 'ADANIGREEN', 'APOLLOHOSP', 'LICI', 'SUNPHARMA', 'GLENMARK', 'NATIONALUM', 'IIFL', 'OIL', 'EICHERMOT', 'HINDALCO', 'MOTILALOFS', 'PNBHOUSING', 'UNOMINDA']
const symbols = [...group1, ...group2]
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const sum = xs => xs.reduce((a, b) => a + b, 0)
const mean = xs => xs.length ? sum(xs) / xs.length : NaN
const median = xs => { const a = [...xs].filter(Number.isFinite).sort((x, y) => x - y); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : NaN }
const round = (x, p = 4) => Number.isFinite(x) ? +x.toFixed(p) : null
const pct = (a, b) => b ? 100 * (a / b - 1) : NaN
const angle = values => {
  if (values.length < 2 || values.some(x => !(x > 0))) return NaN
  const ys = values.map(Math.log), mx = (values.length - 1) / 2, my = mean(ys)
  const den = sum(ys.map((_, i) => (i - mx) ** 2))
  return Math.atan(100 * sum(ys.map((y, i) => (i - mx) * (y - my))) / den) * 180 / Math.PI
}
const ema = (values, period) => { const k = 2 / (period + 1), out = []; let e; for (const x of values) { e = e == null ? x : x * k + e * (1 - k); out.push(e) } return out }
const rsi = (values, period = 14) => {
  const out = Array(values.length).fill(NaN); if (values.length <= period) return out
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0) }
  gain /= period; loss /= period; out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; gain = (gain * (period - 1) + Math.max(d, 0)) / period; loss = (loss * (period - 1) + Math.max(-d, 0)) / period; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss) }
  return out
}

function load(symbol) {
  const unique = new Map()
  for (const line of fs.readFileSync(path.join(root, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const stamp = local(+x.time), d = stamp.slice(0, 10), minute = stamp.slice(11)
    if (d > date || minute < '09:15' || minute > '15:29') continue
    unique.set(stamp, { stamp, date: d, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
  }
  return [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
}

function summarizeWindow(w) {
  const high = Math.max(...w.map(x => x.high)), low = Math.min(...w.map(x => x.low)), volume = sum(w.map(x => x.volume))
  return { open: w[0].open, high, low, close: w.at(-1).close, volume, turnover: sum(w.map(x => ((x.high + x.low + x.close) / 3) * x.volume)), returnPct: pct(w.at(-1).close, w[0].open), rangePct: 100 * (high - low) / w[0].open }
}

function analyze(symbol) {
  const all = load(symbol), dates = [...new Set(all.map(x => x.date))].sort(), di = dates.indexOf(date)
  if (di < 3) throw new Error(`${symbol}: insufficient prior sessions`)
  const priorDates = dates.slice(di - 3, di)
  const today = all.filter(x => x.date === date && x.minute >= start && x.minute <= cutoff)
  if (today.length !== 4) throw new Error(`${symbol}: expected four opening candles, got ${today.length}`)
  const priorSessions = priorDates.map(d => all.filter(x => x.date === d))
  const priorDays = priorSessions.map(w => ({ ...summarizeWindow(w), closeLocation: 100 * (w.at(-1).close - Math.min(...w.map(x => x.low))) / (Math.max(...w.map(x => x.high)) - Math.min(...w.map(x => x.low))) }))
  const priorOpenings = priorDates.map(d => summarizeWindow(all.filter(x => x.date === d && x.minute >= start && x.minute <= cutoff)))
  const prev = priorSessions.at(-1), prevDay = priorDays.at(-1), three = priorSessions.flat()
  const prevHigh = Math.max(...prev.map(x => x.high)), prevLow = Math.min(...prev.map(x => x.low)), threeHigh = Math.max(...three.map(x => x.high)), threeLow = Math.min(...three.map(x => x.low))

  const through = all.filter(x => x.date < date || (x.date === date && x.minute <= cutoff))
  let pvi = 1000, nvi = 1000, previous, pv = 0, vv = 0
  for (const x of through) {
    if (previous) { if (x.volume > previous.volume) pvi *= x.close / previous.close; if (x.volume < previous.volume) nvi *= x.close / previous.close }
    if (x.date === date) { pv += ((x.high + x.low + x.close) / 3) * x.volume; vv += x.volume; x.vwap = pv / vv }
    x.pvi = pvi; x.nvi = nvi; previous = x
  }
  const closes = through.map(x => x.close), ema20 = ema(closes, 20).slice(-4), ema50 = ema(closes, 50).slice(-4), rsis = rsi(closes).slice(-4)
  const w = summarizeWindow(today), range = w.high - w.low
  const green = today.filter(x => x.close > x.open).length
  const higherHighs = today.slice(1).filter((x, i) => x.high > today[i].high).length
  const higherLows = today.slice(1).filter((x, i) => x.low > today[i].low).length
  const higherCloses = today.slice(1).filter((x, i) => x.close > today[i].close).length
  const volumeUpBars = today.slice(1).filter((x, i) => x.volume > today[i].volume).length
  const openingVols = priorOpenings.map(x => x.volume), openingRanges = priorOpenings.map(x => x.rangePct), openingReturns = priorOpenings.map(x => x.returnPct)
  return {
    group: group1.includes(symbol) ? 'Group1' : 'Group2', symbol,
    gap_pct: round(pct(w.open, prev.at(-1).close)), return_pct: round(w.returnPct), range_pct: round(w.rangePct),
    close_location_pct: round(range ? 100 * (w.close - w.low) / range : 50), body_to_range_pct: round(range ? 100 * (w.close - w.open) / range : 0),
    max_drawdown_pct: round(Math.min(...today.map(x => pct(x.low, w.open)))), max_runup_pct: round(Math.max(...today.map(x => pct(x.high, w.open)))),
    first_candle_return_pct: round(pct(today[0].close, today[0].open)), last3_return_pct: round(pct(today.at(-1).close, today[1].open)),
    green_bars: green, higher_highs: higherHighs, higher_lows: higherLows, higher_closes: higherCloses, volume_up_bars: volumeUpBars,
    all_green: green === 4, all_higher_closes: higherCloses === 3, all_higher_lows: higherLows === 3,
    close_above_vwap_bars: today.filter(x => x.close > x.vwap).length, close_vs_vwap_pct: round(pct(w.close, today.at(-1).vwap)),
    volume: w.volume, turnover_cr: round(w.turnover / 1e7), first_min_volume_share_pct: round(100 * today[0].volume / w.volume), last_first_volume_ratio: round(today.at(-1).volume / today[0].volume),
    volume_ratio_prior1: round(w.volume / openingVols.at(-1)), volume_ratio_prior2: round(w.volume / mean(openingVols.slice(-2))), volume_ratio_prior3: round(w.volume / mean(openingVols)),
    turnover_ratio_prior3: round(w.turnover / mean(priorOpenings.map(x => x.turnover))), range_ratio_prior1: round(w.rangePct / openingRanges.at(-1)), range_ratio_prior3: round(w.rangePct / mean(openingRanges)),
    return_vs_prior1_pp: round(w.returnPct - openingReturns.at(-1)), return_vs_prior3_avg_pp: round(w.returnPct - mean(openingReturns)),
    pvi_change_pct: round(pct(today.at(-1).pvi, today[0].pvi)), pvi_angle_deg: round(angle(today.map(x => x.pvi))), nvi_change_pct: round(pct(today.at(-1).nvi, today[0].nvi)), nvi_angle_deg: round(angle(today.map(x => x.nvi))),
    ema20_angle_deg: round(angle(ema20)), ema50_angle_deg: round(angle(ema50)), rsi14_at_close: round(rsis.at(-1)), rsi14_change: round(rsis.at(-1) - rsis[0]),
    prior1_return_pct: round(prevDay.returnPct), prior1_close_location_pct: round(prevDay.closeLocation), prior2_avg_return_pct: round(mean(priorDays.slice(-2).map(x => x.returnPct))), prior3_avg_return_pct: round(mean(priorDays.map(x => x.returnPct))),
    prior2_close_return_pct: round(pct(priorDays.at(-1).close, priorDays.at(-2).close)), prior3_close_return_pct: round(pct(priorDays.at(-1).close, priorDays[0].close)), prior3_green_days: priorDays.filter(x => x.returnPct > 0).length,
    close_vs_prev_high_pct: round(pct(w.close, prevHigh)), close_position_prev_range_pct: round(100 * (w.close - prevLow) / (prevHigh - prevLow)), close_vs_3d_high_pct: round(pct(w.close, threeHigh)), close_position_3d_range_pct: round(100 * (w.close - threeLow) / (threeHigh - threeLow))
  }
}

const rows = symbols.map(analyze)
const finalFilterRows = rows.filter(x => x.higher_closes === 3 && x.close_vs_3d_high_pct >= -1.71)
const numeric = Object.keys(rows[0]).filter(k => rows.every(r => typeof r[k] === 'number' && Number.isFinite(r[k])))
const positives = rows.filter(x => x.group === 'Group1'), negatives = rows.filter(x => x.group === 'Group2')
const summaries = numeric.map(feature => {
  const a = positives.map(x => x[feature]), b = negatives.map(x => x[feature]), ma = mean(a), mb = mean(b)
  const pooled = Math.sqrt((sum(a.map(x => (x - ma) ** 2)) + sum(b.map(x => (x - mb) ** 2))) / (a.length + b.length - 2))
  const minA = Math.min(...a), maxA = Math.max(...a)
  const gePass = b.filter(x => x >= minA).length, lePass = b.filter(x => x <= maxA).length
  return { feature, group1_median: round(median(a)), group2_median: round(median(b)), group1_min: round(minA), group1_max: round(maxA), effect_size: round(pooled ? (ma - mb) / pooled : 0), best_direction: gePass <= lePass ? '>=' : '<=', threshold: round(gePass <= lePass ? minA : maxA), group2_pass: Math.min(gePass, lePass) }
}).sort((a, b) => a.group2_pass - b.group2_pass || Math.abs(b.effect_size) - Math.abs(a.effect_size))

const atoms = summaries.map(x => ({ label: `${x.feature} ${x.best_direction} ${x.threshold}`, test: r => x.best_direction === '>=' ? r[x.feature] >= x.threshold : r[x.feature] <= x.threshold }))
const pairs = []
for (let i = 0; i < atoms.length; i++) for (let j = i + 1; j < atoms.length; j++) {
  const pass = negatives.filter(r => atoms[i].test(r) && atoms[j].test(r)).map(r => r.symbol)
  pairs.push({ rules: `${atoms[i].label} AND ${atoms[j].label}`, group2_pass: pass.length, group2_names: pass.join('|') })
}
pairs.sort((a, b) => a.group2_pass - b.group2_pass || a.rules.localeCompare(b.rules))

const boolKeys = ['all_green', 'all_higher_closes', 'all_higher_lows']
const booleanSummary = boolKeys.map(feature => ({ feature, group1_values: positives.map(x => x[feature]).join('|'), group2_true: negatives.filter(x => x[feature]).length }))
const toCsv = data => { const cols = Object.keys(data[0]); return [cols.join(','), ...data.map(r => cols.map(c => r[c] ?? '').join(','))].join('\n') + '\n' }
const stem = `${date}-0915-0918-first4-group-comparison`
let detail = path.join(root, 'reports', `${stem}.csv`), version = 2
while (fs.existsSync(detail)) detail = path.join(root, 'reports', `${stem}-${version++}.csv`)
const summary = detail.replace(/\.csv$/, '-feature-summary.csv'), rules = detail.replace(/\.csv$/, '-candidate-rules.csv')
fs.writeFileSync(detail, toCsv(rows), { flag: 'wx' }); fs.writeFileSync(summary, toCsv(summaries), { flag: 'wx' }); fs.writeFileSync(rules, toCsv(pairs.slice(0, 50)), { flag: 'wx' })
console.table(rows.map(x => ({ group: x.group, symbol: x.symbol, ret: x.return_pct, closeLoc: x.close_location_pct, green: x.green_bars, HH: x.higher_highs, HL: x.higher_lows, vwap: x.close_vs_vwap_pct, vol1x: x.volume_ratio_prior1, vol3x: x.volume_ratio_prior3, PVI: x.pvi_change_pct, NVI: x.nvi_change_pct, prior1: x.prior1_return_pct, prevHigh: x.close_vs_prev_high_pct })))
console.log('\nFinal filter: four consecutively rising closes AND 09:18 close within 1.71% of the prior three-session high:')
console.table(finalFilterRows.map(x => ({
  Group: x.group,
  Stock: `NSE:${x.symbol}-EQ`,
  'Rising close transitions': `${x.higher_closes}/3`,
  'Close vs 3-session high %': x.close_vs_3d_high_pct,
  '3-session range position %': x.close_position_3d_range_pct,
  'NVI change %': x.nvi_change_pct,
  'EMA50 angle': x.ema50_angle_deg
})))
const group1Pass = finalFilterRows.filter(x => x.group === 'Group1').length
const group2Pass = finalFilterRows.filter(x => x.group === 'Group2').length
console.log(`Result: Group 1 ${group1Pass}/${group1.length} | Group 2 ${group2Pass}/${group2.length}`)
console.log(`Stocks: ${finalFilterRows.map(x => `NSE:${x.symbol}-EQ`).join(', ')}`)
console.log('\nBest single features retaining every Group 1 stock:'); console.table(summaries.slice(0, 20))
console.log('\nBoolean patterns:'); console.table(booleanSummary)
console.log('\nBest two-condition rules retaining every Group 1 stock:'); console.table(pairs.slice(0, 20))
console.log(`\nDetails: ${detail}\nFeature summary: ${summary}\nCandidate rules: ${rules}`)
