import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2] ?? '2026-11-12'
const start = '09:15'
const cutoff = '09:20'
const group1 = ['PRESTIGE', 'MFSL', 'HDFCLIFE', 'CDSL']
const group2 = ['BAJAJFINSV', 'LICI', 'WAAREEENER', 'BAJFINANCE', 'SHRIRAMFIN', 'PNBHOUSING', '360ONE', 'ASTRAL', 'BANDHANBNK', 'SOLARINDS', 'IDFCFIRSTB', 'ADANIENSOL', 'FORCEMOT', 'IRCTC', 'PFC', 'BAJAJ-AUTO']
const symbols = [...group1, ...group2]
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const sum = xs => xs.reduce((a, b) => a + b, 0)
const mean = xs => xs.length ? sum(xs) / xs.length : NaN
const median = xs => { const a = [...xs].filter(Number.isFinite).sort((x, y) => x - y); return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : NaN }
const round = (x, p = 4) => Number.isFinite(x) ? +x.toFixed(p) : null
const pct = (a, b) => b ? 100 * (a / b - 1) : NaN
const slopeAngle = values => {
  if (values.length < 2 || values.some(x => !(x > 0))) return NaN
  const ys = values.map(Math.log), mx = (values.length - 1) / 2, my = mean(ys)
  const den = sum(ys.map((_, i) => (i - mx) ** 2))
  const slope = sum(ys.map((y, i) => (i - mx) * (y - my))) / den
  return Math.atan(100 * slope) * 180 / Math.PI
}
const emaSeries = (values, period) => {
  const k = 2 / (period + 1), out = []; let e = values[0]
  for (const x of values) { e = e == null ? x : x * k + e * (1 - k); out.push(e) }
  return out
}
const percentile = (history, x) => history.length ? 100 * history.filter(v => v <= x).length / history.length : NaN

function load(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const stamp = local(+x.time), d = stamp.slice(0, 10), minute = stamp.slice(11)
    if (d > date || minute < '09:15' || minute > '15:29') continue
    unique.set(stamp, { stamp, date: d, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
  }
  return [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
}

function analyze(symbol) {
  const all = load(symbol)
  const dates = [...new Set(all.map(x => x.date))].sort()
  const ix = dates.indexOf(date)
  if (ix < 5) throw new Error(`${symbol}: insufficient prior sessions`)
  const priorDates = dates.slice(ix - 5, ix)
  const today = all.filter(x => x.date === date && x.minute >= start && x.minute <= cutoff)
  if (today.length !== 6) throw new Error(`${symbol}: expected 6 candles, found ${today.length}`)
  const prev = all.filter(x => x.date === priorDates.at(-1))
  const prevClose = prev.at(-1).close, prevHigh = Math.max(...prev.map(x => x.high)), prevLow = Math.min(...prev.map(x => x.low))
  const five = all.filter(x => priorDates.includes(x.date))
  const fiveHigh = Math.max(...five.map(x => x.high)), fiveLow = Math.min(...five.map(x => x.low))

  let cumPv = 0, cumVol = 0, pvi = 1000, nvi = 1000, previous = null
  const fullThroughCutoff = all.filter(x => x.date < date || (x.date === date && x.minute <= cutoff))
  for (const x of fullThroughCutoff) {
    if (previous) {
      if (x.volume > previous.volume) pvi *= x.close / previous.close
      if (x.volume < previous.volume) nvi *= x.close / previous.close
    }
    if (x.date === date) { cumPv += ((x.high + x.low + x.close) / 3) * x.volume; cumVol += x.volume; x.vwap = cumPv / cumVol }
    x.pvi = pvi; x.nvi = nvi; previous = x
  }
  const closes = fullThroughCutoff.map(x => x.close)
  const ema20 = emaSeries(closes, 20), ema50 = emaSeries(closes, 50)
  const end = fullThroughCutoff.length
  const ema20Today = ema20.slice(end - today.length), ema50Today = ema50.slice(end - today.length)
  const volume = sum(today.map(x => x.volume))
  const turnover = sum(today.map(x => ((x.high + x.low + x.close) / 3) * x.volume))
  const priorWindows = priorDates.map(d => {
    const w = all.filter(x => x.date === d && x.minute >= start && x.minute <= cutoff)
    return { volume: sum(w.map(x => x.volume)), turnover: sum(w.map(x => ((x.high + x.low + x.close) / 3) * x.volume)), rangePct: pct(Math.max(...w.map(x => x.high)), Math.min(...w.map(x => x.low))), returnPct: pct(w.at(-1).close, w[0].open) }
  })
  const priorDays = priorDates.map(d => {
    const w = all.filter(x => x.date === d)
    return { open: w[0].open, high: Math.max(...w.map(x => x.high)), low: Math.min(...w.map(x => x.low)), close: w.at(-1).close, returnPct: pct(w.at(-1).close, w[0].open) }
  })
  const dayHigh = Math.max(...today.map(x => x.high)), dayLow = Math.min(...today.map(x => x.low))
  const range = dayHigh - dayLow, close = today.at(-1).close, open = today[0].open
  const prior3 = priorWindows.slice(-3), prior5 = priorWindows
  const higherLows = today.slice(1).filter((x, i) => x.low > today[i].low).length
  const green = today.filter(x => x.close > x.open).length
  const closeAboveVwap = today.filter(x => x.close > x.vwap).length
  const firstVolShare = 100 * today[0].volume / volume
  const maxDrawdown = Math.min(...today.map(x => pct(x.low, open)))
  const maxRunup = Math.max(...today.map(x => pct(x.high, open)))
  return {
    group: group1.includes(symbol) ? 'Group1' : 'Group2', symbol,
    gap_pct: round(pct(open, prevClose)), return_pct: round(pct(close, open)), range_pct: round(100 * range / open),
    close_location_pct: round(range ? 100 * (close - dayLow) / range : 50), body_to_range_pct: round(range ? 100 * (close - open) / range : 0),
    max_drawdown_pct: round(maxDrawdown), max_runup_pct: round(maxRunup), green_bars: green, higher_lows: higherLows,
    close_above_vwap_bars: closeAboveVwap, close_vs_vwap_pct: round(pct(close, today.at(-1).vwap)),
    volume, turnover_cr: round(turnover / 1e7), first_min_volume_share_pct: round(firstVolShare),
    volume_ratio_prior3: round(volume / mean(prior3.map(x => x.volume))), volume_ratio_prior5: round(volume / mean(prior5.map(x => x.volume))),
    volume_percentile_prior5: round(percentile(prior5.map(x => x.volume), volume)),
    turnover_ratio_prior5: round(turnover / mean(prior5.map(x => x.turnover))), range_ratio_prior5: round((100 * range / open) / mean(prior5.map(x => x.rangePct))),
    return_vs_prior5_avg_pp: round(pct(close, open) - mean(prior5.map(x => x.returnPct))),
    prior_day_return_pct: round(priorDays.at(-1).returnPct), prior3_close_return_pct: round(pct(priorDays.at(-1).close, priorDays.at(-3).close)),
    prior5_close_return_pct: round(pct(priorDays.at(-1).close, priorDays[0].close)), prior3_green_days: priorDays.slice(-3).filter(x => x.returnPct > 0).length,
    prior_day_close_location_pct: round(100 * (priorDays.at(-1).close - priorDays.at(-1).low) / (priorDays.at(-1).high - priorDays.at(-1).low)),
    pvi_change_pct: round(pct(today.at(-1).pvi, today[0].pvi)), pvi_angle_deg: round(slopeAngle(today.map(x => x.pvi))),
    nvi_change_pct: round(pct(today.at(-1).nvi, today[0].nvi)), nvi_angle_deg: round(slopeAngle(today.map(x => x.nvi))),
    ema20_angle_deg: round(slopeAngle(ema20Today)), ema50_angle_deg: round(slopeAngle(ema50Today)),
    close_vs_prev_high_pct: round(pct(close, prevHigh)), open_vs_prev_high_pct: round(pct(open, prevHigh)),
    close_vs_5d_high_pct: round(pct(close, fiveHigh)), close_position_prev_range_pct: round(100 * (close - prevLow) / (prevHigh - prevLow)),
    opening_low_hold: dayLow >= open * 0.999, broke_prev_high: dayHigh > prevHigh, broke_5d_high: dayHigh > fiveHigh
  }
}

const rows = symbols.map(analyze)
const numeric = Object.keys(rows[0]).filter(k => rows.every(r => typeof r[k] === 'number' && Number.isFinite(r[k])))
const summaries = numeric.map(feature => {
  const a = rows.filter(x => x.group === 'Group1').map(x => x[feature]), b = rows.filter(x => x.group === 'Group2').map(x => x[feature])
  const minA = Math.min(...a), maxA = Math.max(...a), minB = Math.min(...b), maxB = Math.max(...b)
  let perfect = '', threshold = null
  if (minA > maxB) { perfect = '> Group2 max'; threshold = (minA + maxB) / 2 }
  if (maxA < minB) { perfect = '< Group2 min'; threshold = (maxA + minB) / 2 }
  const pooled = Math.sqrt(((a.length - 1) * mean(a.map(x => (x - mean(a)) ** 2)) + (b.length - 1) * mean(b.map(x => (x - mean(b)) ** 2))) / (a.length + b.length - 2))
  return { feature, group1_median: round(median(a)), group2_median: round(median(b)), group1_min: round(minA), group1_max: round(maxA), group2_min: round(minB), group2_max: round(maxB), effect_size: round(pooled ? (mean(a) - mean(b)) / pooled : 0), perfect, threshold: round(threshold) }
}).sort((a, b) => Math.abs(b.effect_size) - Math.abs(a.effect_size))

const positives = rows.filter(x => x.group === 'Group1'), negatives = rows.filter(x => x.group === 'Group2')
const atomic = []
for (const feature of numeric) {
  const vals = positives.map(x => x[feature])
  const lower = Math.min(...vals), upper = Math.max(...vals)
  atomic.push({ label: `${feature} >= ${round(lower)}`, test: r => r[feature] >= lower })
  atomic.push({ label: `${feature} <= ${round(upper)}`, test: r => r[feature] <= upper })
}
const candidates = []
for (let i = 0; i < atomic.length; i++) {
  for (let j = i; j < atomic.length; j++) {
    const rules2 = [atomic[i], atomic[j]]
    const pass2 = negatives.filter(r => rules2.every(x => x.test(r))).map(x => x.symbol)
    candidates.push({ rule_count: 2, rules: rules2.map(x => x.label).join(' AND '), group1_pass: 4, group2_pass: pass2.length, group2_names: pass2.join('|') })
    for (let k = j; k < atomic.length; k++) {
      const rules3 = [atomic[i], atomic[j], atomic[k]]
      const pass3 = negatives.filter(r => rules3.every(x => x.test(r))).map(x => x.symbol)
      candidates.push({ rule_count: 3, rules: rules3.map(x => x.label).join(' AND '), group1_pass: 4, group2_pass: pass3.length, group2_names: pass3.join('|') })
    }
  }
}
const bestRules = candidates.sort((a, b) => a.group2_pass - b.group2_pass || a.rule_count - b.rule_count || a.rules.localeCompare(b.rules)).slice(0, 30)

const csvEscape = x => typeof x === 'string' && x.includes(',') ? `"${x.replaceAll('"', '""')}"` : x
const toCsv = data => { const cols = Object.keys(data[0]); return [cols.join(','), ...data.map(r => cols.map(c => csvEscape(r[c] ?? '')).join(','))].join('\n') + '\n' }
let stamp = `${date}-0915-0920-group1-vs-group2-opening-comparison`, version = 2
while (fs.existsSync(path.join(root, 'reports', `${stamp}.csv`))) stamp = `${date}-0915-0920-group1-vs-group2-opening-comparison-${version++}`
const detailFile = path.join(root, 'reports', `${stamp}.csv`)
const summaryFile = path.join(root, 'reports', `${stamp}-feature-summary.csv`)
const ruleFile = path.join(root, 'reports', `${stamp}-candidate-rules.csv`)
fs.writeFileSync(detailFile, toCsv(rows), { flag: 'wx' })
fs.writeFileSync(summaryFile, toCsv(summaries), { flag: 'wx' })
fs.writeFileSync(ruleFile, toCsv(bestRules), { flag: 'wx' })
console.table(rows.map(r => ({ group: r.group, symbol: r.symbol, ret: r.return_pct, vol3x: r.volume_ratio_prior3, vol5x: r.volume_ratio_prior5, vwap: r.close_vs_vwap_pct, closeLoc: r.close_location_pct, PVI: r.pvi_change_pct, PVIangle: r.pvi_angle_deg, EMA20angle: r.ema20_angle_deg, prevHigh: r.close_vs_prev_high_pct })))
console.log('\nLargest standardized differences:')
console.table(summaries.slice(0, 15))
console.log('\nPerfect single-feature separators:')
console.table(summaries.filter(x => x.perfect))
console.log('\nBest conjunctions retaining all four Group 1 stocks:')
console.table(bestRules.slice(0, 15))
console.log(`\nDetails: ${detailFile}\nFeature summary: ${summaryFile}\nCandidate rules: ${ruleFile}`)
