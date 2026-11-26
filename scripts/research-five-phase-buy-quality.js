import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2] ?? '2026-11-11', allMode = process.argv.includes('--all')
const selectedCases = [
  ['BANKBARODA', '09:28', 'strong'], ['FEDERALBNK', '09:25', 'strong'], ['NCC', '09:24', 'strong'],
  ['INDUSTOWER', '09:27', 'weak'], ['NATIONALUM', '09:32', 'weak'], ['COFORGE', '09:33', 'weak']
]
const sourceReport = path.join(root, 'reports', `${date}-0915-0940-rolling-five-phase-signals.csv`)
const signalRows = allMode ? fs.readFileSync(sourceReport, 'utf8').trim().split(/\r?\n/).slice(1).map(line => line.split(',')) : []
const reportHeader = allMode ? fs.readFileSync(sourceReport, 'utf8').split(/\r?\n/)[0].split(',') : []
const reportIndex = key => reportHeader.indexOf(key)
const cases = allMode ? signalRows.filter(x => x[reportIndex('side')] === 'BUY').map(x => {
  const symbol = x[reportIndex('symbol')], minute = x[reportIndex('signal_time')].slice(11)
  const selected = selectedCases.find(y => y[0] === symbol)
  return [symbol, minute, selected?.[2] ?? 'other', +(x[reportIndex('return_pct')])]
}) : selectedCases
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const sum = xs => xs.reduce((a, b) => a + b, 0), mean = xs => xs.length ? sum(xs) / xs.length : NaN
const ema = (xs, n) => { if (!xs.length) return []; const a = 2 / (n + 1), out = []; let e = xs[0]; for (const x of xs) { e = a * x + (1 - a) * e; out.push(e) } return out }
const angle = xs => {
  if (xs.length < 2 || xs.some(x => !(x > 0))) return NaN
  const ys = xs.map(Math.log), mx = (xs.length - 1) / 2, my = mean(ys), den = sum(ys.map((_, i) => (i - mx) ** 2))
  return Math.atan(100 * sum(ys.map((y, i) => (i - mx) * (y - my))) / den) * 180 / Math.PI
}

function load(symbol) {
  const rows = []
  for (const line of fs.readFileSync(path.join(root, 'db', 'candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const stamp = local(+x.time), d = stamp.slice(0, 10), minute = stamp.slice(11)
    if (d > date || minute < '09:15' || minute > '15:29') continue
    rows.push({ stamp, date: d, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
  }
  return rows.sort((a, b) => a.stamp.localeCompare(b.stamp))
}

function aggregate(rows, minutes) {
  const out = []
  for (let i = 0; i + minutes <= rows.length; i += minutes) {
    const group = rows.slice(i, i + minutes)
    out.push({ open: group[0].open, high: Math.max(...group.map(x => x.high)), low: Math.min(...group.map(x => x.low)), close: group.at(-1).close, volume: sum(group.map(x => x.volume)), end: group.at(-1).minute })
  }
  return out
}

function feature(symbol, signalMinute, label, outcomeReturnPct = null) {
  const all = load(symbol), today = all.filter(x => x.date === date), opening = today.filter(x => x.minute <= signalMinute)
  const dates = [...new Set(all.filter(x => x.date < date).map(x => x.date))].slice(-20)
  const prior = dates.map(d => all.filter(x => x.date === d)), previous = prior.at(-1), previousClose = previous.at(-1).close
  const priorHigh = Math.max(...previous.map(x => x.high)), priorLow = Math.min(...previous.map(x => x.low))
  const priorVolumes = prior.map(rows => sum(rows.slice(0, opening.length).map(x => x.volume)))
  const currentVolume = sum(opening.map(x => x.volume)), closes = opening.map(x => x.close), typical = x => (x.high + x.low + x.close) / 3
  let pv = 0, vol = 0
  const vwaps = opening.map(x => { pv += typical(x) * x.volume; vol += x.volume; return pv / vol })
  const e20 = ema(closes, 20), e40 = ema(closes, 40), e50 = ema(closes, 50)
  let pvi = 1000, nvi = 1000, previousRow = null
  const indicator = new Map()
  for (const row of all) {
    if (previousRow) {
      if (row.volume > previousRow.volume) pvi *= row.close / previousRow.close
      if (row.volume < previousRow.volume) nvi *= row.close / previousRow.close
    }
    indicator.set(row.stamp, { pvi, nvi }); previousRow = row
  }
  const pvis = opening.map(x => indicator.get(x.stamp).pvi), nvis = opening.map(x => indicator.get(x.stamp).nvi)
  const greenVolume = sum(opening.filter(x => x.close > x.open).map(x => x.volume)), redVolume = sum(opening.filter(x => x.close < x.open).map(x => x.volume))
  const path = sum(opening.slice(1).map((x, i) => Math.abs(x.close - opening[i].close)))
  const mtf = {}
  for (const minutes of [3, 5, 10, 15]) {
    const bars = aggregate(opening, minutes), last = bars.at(-1)
    mtf[`${minutes}m_completed_bars`] = bars.length
    mtf[`${minutes}m_last_body_pct`] = last ? 100 * (last.close / last.open - 1) : NaN
    mtf[`${minutes}m_last_close_location_pct`] = last ? 100 * (last.close - last.low) / (last.high - last.low || 1) : NaN
  }
  const last5 = opening.slice(-5), prior5 = opening.slice(-10, -5)
  return {
    symbol, label, signal_time: `${date} ${signalMinute}`, outcome_return_pct: outcomeReturnPct, bars: opening.length,
    gap_pct: 100 * (opening[0].open / previousClose - 1),
    signal_return_pct: 100 * (opening.at(-1).close / opening[0].open - 1),
    close_vs_vwap_pct: 100 * (opening.at(-1).close / vwaps.at(-1) - 1),
    vwap_angle_deg: angle(vwaps), vwap_last5_angle_deg: angle(vwaps.slice(-5)),
    ema20_angle_deg: angle(e20), ema40_angle_deg: angle(e40), ema50_angle_deg: angle(e50),
    ema20_40_spread_pct: 100 * (e20.at(-1) / e40.at(-1) - 1),
    pvi_angle_deg: angle(pvis), nvi_angle_deg: angle(nvis),
    volume_percentile: 100 * priorVolumes.filter(x => x < currentVolume).length / priorVolumes.length,
    relative_volume: currentVolume / mean(priorVolumes),
    green_volume_share_pct: 100 * greenVolume / (greenVolume + redVolume || 1),
    last5_volume_vs_prior5: prior5.length ? sum(last5.map(x => x.volume)) / sum(prior5.map(x => x.volume)) : NaN,
    signal_volume_vs_prior5_avg: prior5.length ? opening.at(-1).volume / mean(prior5.map(x => x.volume)) : NaN,
    path_efficiency_pct: path ? 100 * (opening.at(-1).close - opening[0].close) / path : 0,
    close_vs_prior_high_pct: 100 * (opening.at(-1).close / priorHigh - 1),
    close_vs_prior_low_pct: 100 * (opening.at(-1).close / priorLow - 1),
    signal_candle_body_pct: 100 * (opening.at(-1).close / opening.at(-1).open - 1),
    signal_close_location_pct: 100 * (opening.at(-1).close - opening.at(-1).low) / (opening.at(-1).high - opening.at(-1).low || 1),
    ...mtf
  }
}

const rows = cases.map(x => feature(...x)).map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])))
const columns = Object.keys(rows[0]), output = path.join(root, 'reports', `${date}-five-phase-buy-quality-${allMode ? 'all-signals' : 'comparison'}.csv`)
if (fs.existsSync(output)) throw new Error(`Refusing to overwrite ${output}`)
fs.writeFileSync(output, [columns.join(','), ...rows.map(row => columns.map(c => row[c] ?? '').join(','))].join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ rows, output }, null, 2))
