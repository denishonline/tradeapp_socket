import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2] ?? '2026-11-11'
const baseFile = path.join(root, 'reports', `${date}-0915-0925-gap-volume-pvi-vwap-screen.csv`)
const wanted = new Set(['IIFL', 'BANKBARODA', 'FEDERALBNK', 'NCC', 'IRFC', 'IDFCFIRSTB', 'IRCTC', 'SBIN', 'RVNL', 'BANKINDIA', 'INDIGO', 'WAAREEENER', 'NAM-INDIA'])
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const sum = xs => xs.reduce((a, b) => a + b, 0)
const angle = xs => {
  if (xs.length < 2 || xs.some(x => !(x > 0))) return NaN
  const logs = xs.map(Math.log), mx = (xs.length - 1) / 2, my = mean(logs)
  const slope = sum(logs.map((y, i) => (i - mx) * (y - my))) / sum(logs.map((_, i) => (i - mx) ** 2))
  return Math.atan(100 * slope) * 180 / Math.PI
}
const ema = (xs, n) => {
  const a = 2 / (n + 1), out = []; let value = xs[0]
  for (const x of xs) { value = a * x + (1 - a) * value; out.push(value) }
  return out
}
const parseCsv = text => {
  const [head, ...lines] = text.trim().split(/\r?\n/), keys = head.split(',')
  return lines.map(line => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v])))
}
const base = parseCsv(fs.readFileSync(baseFile, 'utf8'))

function load(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`), rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    const x = JSON.parse(line), stamp = local(+x.time)
    if (stamp.slice(0, 10) > date || stamp.slice(11) < '09:15' || stamp.slice(11) > '15:29') continue
    rows.push({ stamp, date: stamp.slice(0, 10), minute: stamp.slice(11), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
  }
  return rows.sort((a, b) => a.stamp.localeCompare(b.stamp))
}

function features(baseRow) {
  const symbol = baseRow.symbol, all = load(symbol), today = all.filter(x => x.date === date)
  const opening = today.filter(x => x.minute >= '09:15' && x.minute <= '09:25')
  const priorDates = [...new Set(all.filter(x => x.date < date).map(x => x.date))].slice(-20)
  const prior = priorDates.map(d => all.filter(x => x.date === d)), c0 = opening[0], cN = opening.at(-1)
  const typical = x => (x.high + x.low + x.close) / 3
  let cumPV = 0, cumV = 0
  const vwaps = opening.map(x => { cumPV += typical(x) * x.volume; cumV += x.volume; return cumPV / cumV })
  const closes = opening.map(x => x.close), volumes = opening.map(x => x.volume), e20 = ema(closes, 20), e50 = ema(closes, 50)
  const greens = opening.filter(x => x.close > x.open), reds = opening.filter(x => x.close < x.open)
  const greenVol = sum(greens.map(x => x.volume)), redVol = sum(reds.map(x => x.volume))
  const totalRange = Math.max(...opening.map(x => x.high)) - Math.min(...opening.map(x => x.low))
  const priorLast = prior.at(-1), prevHigh = Math.max(...priorLast.map(x => x.high)), prevLow = Math.min(...priorLast.map(x => x.low))
  const priorOpeningVolumes = prior.map(rows => sum(rows.slice(0, 11).map(x => x.volume)))
  const priorRanges = prior.map(rows => Math.max(...rows.map(x => x.high)) - Math.min(...rows.map(x => x.low)))
  const first5 = opening.slice(0, 5), second5 = opening.slice(5, 10)
  return {
    symbol, wanted: wanted.has(symbol) ? 'yes' : 'no',
    gap_pct: +baseRow.gap_pct, pvi_angle: +baseRow.pvi_angle_deg, pviema_angle: +baseRow.pviema255_angle_deg,
    close_vwap_pct: +baseRow.close_vs_vwap_pct,
    return_0915_0925_pct: 100 * (cN.close / c0.open - 1),
    first5_return_pct: 100 * (first5.at(-1).close / first5[0].open - 1),
    second5_return_pct: 100 * (second5.at(-1).close / second5[0].open - 1),
    last2_return_pct: 100 * (cN.close / opening.at(-3).close - 1),
    vwap_angle: angle(vwaps), ema20_angle: angle(e20), ema50_angle: angle(e50),
    green_count: greens.length, above_vwap_count: opening.filter((x, i) => x.close > vwaps[i]).length,
    close_location_pct: totalRange ? 100 * (cN.close - Math.min(...opening.map(x => x.low))) / totalRange : 50,
    path_efficiency_pct: sum(opening.slice(1).map((x, i) => Math.abs(x.close - opening[i].close))) ? 100 * (cN.close - c0.close) / sum(opening.slice(1).map((x, i) => Math.abs(x.close - opening[i].close))) : 0,
    green_volume_share_pct: 100 * greenVol / (greenVol + redVol || 1),
    first_bar_volume_share_pct: 100 * volumes[0] / sum(volumes), first5_volume_share_pct: 100 * sum(volumes.slice(0, 5)) / sum(volumes),
    rel_opening_volume: sum(volumes) / mean(priorOpeningVolumes),
    range_vs_prior_daily_pct: 100 * totalRange / mean(priorRanges),
    close_vs_prev_high_pct: 100 * (cN.close / prevHigh - 1), close_vs_prev_low_pct: 100 * (cN.close / prevLow - 1),
    first_candle_body_pct: 100 * (c0.close / c0.open - 1),
    first_candle_close_location_pct: 100 * (c0.close - c0.low) / (c0.high - c0.low || 1),
  }
}

const rows = base.map(features)
const numeric = Object.keys(rows[0]).filter(k => !['symbol', 'wanted'].includes(k))
const predicates = []
for (const key of numeric) {
  const values = [...new Set(rows.map(r => r[key]).filter(Number.isFinite))].sort((a, b) => a - b)
  for (let i = 0; i < values.length - 1; i++) {
    const t = (values[i] + values[i + 1]) / 2
    predicates.push({ text: `${key} <= ${round(t)}`, test: r => r[key] <= t, key, op: '<=', threshold: t })
    predicates.push({ text: `${key} > ${round(t)}`, test: r => r[key] > t, key, op: '>', threshold: t })
  }
}
const score = test => {
  const selected = rows.filter(test), tp = selected.filter(r => r.wanted === 'yes').length, fp = selected.length - tp
  const fn = rows.filter(r => r.wanted === 'yes' && !test(r)).length
  return { tp, fp, fn, selected: selected.map(r => r.symbol) }
}
const exact = []
for (let i = 0; i < predicates.length; i++) for (let j = i + 1; j < predicates.length; j++) {
  const a = predicates[i], b = predicates[j]
  for (const [join, test] of [['AND', r => a.test(r) && b.test(r)], ['OR', r => a.test(r) || b.test(r)]]) {
    const s = score(test)
    if (s.tp === wanted.size && s.fp === 0 && s.fn === 0) exact.push({ rule: `${a.text} ${join} ${b.text}`, ...s })
  }
}
const csvKeys = Object.keys(rows[0])
const output = path.join(root, 'reports', `${date}-0915-0925-refinement-feature-study.csv`)
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite ${output}`)
fs.writeFileSync(output, [csvKeys.join(','), ...rows.map(r => csvKeys.map(k => round(r[k]) ?? r[k]).join(','))].join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ rows: rows.length, exactTwoPredicateRules: exact.length, simplestExactRules: exact.slice(0, 30).map(x => x.rule), output }, null, 2))
