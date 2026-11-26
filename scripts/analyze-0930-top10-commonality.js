import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2] ?? '2026-10-22'
const selected = ['BAJAJHLDNG', 'BAJFINANCE', 'KAYNES', 'INDHOTEL', 'BAJAJ-AUTO', 'UNOMINDA']
const top10 = ['BAJAJHLDNG', 'ETERNAL', 'DELHIVERY', 'KAYNES', 'GLAND', 'BAJFINANCE', 'KOTAKBANK', 'INDHOTEL', 'BAJAJ-AUTO', 'UNOMINDA']
const comparison = top10.filter(symbol => !selected.includes(symbol))
const ist = epoch => new Date(Number(epoch) * 1000 + 330 * 60_000)
const parts = epoch => { const d = ist(epoch); return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() } }
const round = (x, p = 3) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const median = xs => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null }

function candles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    const p = parts(r.time)
    if (p.date !== date || p.minute < 555 || ![r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite)) continue
    rows.push({ ...p, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume })
  }
  return rows.sort((a, b) => a.minute - b.minute)
}

function depth(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const state = {}, out = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    const p = parts(Date.parse(e.receivedAt) / 1000)
    if (p.date !== date || p.minute < 555 || p.minute >= 930) continue
    if (e.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, e.data ?? {})
    const bid = [], ask = []
    for (let n = 1; n <= 5; n++) {
      const bp = +state[`bid_price${n}`], ap = +state[`ask_price${n}`], bs = +state[`bid_size${n}`], as = +state[`ask_size${n}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { bid.length = 0; break }
      bid.push(bs); ask.push(as)
    }
    if (bid.length !== 5) continue
    const bidTotal = bid.reduce((a, b) => a + b, 0), askTotal = ask.reduce((a, b) => a + b, 0)
    out.push({ minute: p.minute, bidShare: 100 * bidTotal / (bidTotal + askTotal), spreadBps: 10000 * (+state.ask_price1 - +state.bid_price1) / ((+state.ask_price1 + +state.bid_price1) / 2), bidTotal, askTotal })
  }
  return out
}

function features(symbol) {
  const rows = candles(symbol), opening = rows.filter(r => r.minute < 570), after = rows.filter(r => r.minute >= 570)
  const d = depth(symbol)
  if (opening.length < 15) return { symbol, missing: true, candleCount: rows.length, depthCount: d.length }
  const first = opening[0], last = opening.at(-1), sessionClose = rows.at(-1)
  const upBars = opening.filter(r => r.close > r.open).length
  const directionalBars = opening.slice(1).filter((r, i) => r.close > opening[i].close).length
  const openingRange = 100 * (Math.max(...opening.map(r => r.high)) - Math.min(...opening.map(r => r.low))) / first.open
  const depthShare = d.map(x => x.bidShare)
  const depthBullPct = depthShare.length ? 100 * depthShare.filter(x => x > 50).length / depthShare.length : null
  const openingVol = opening.reduce((s, r) => s + r.volume, 0)
  const laterVol = after.reduce((s, r) => s + r.volume, 0)
  return {
    symbol, missing: false, candleCount: rows.length, depthCount: d.length,
    openingReturnPct: 100 * (last.close / first.open - 1), fullSessionReturnPct: 100 * (sessionClose.close / first.open - 1),
    post0930ReturnPct: after.length ? 100 * (sessionClose.close / after[0].open - 1) : null,
    openingRangePct: openingRange, openingCloseLocationPct: 100 * (last.close - Math.min(...opening.map(r => r.low))) / (Math.max(...opening.map(r => r.high)) - Math.min(...opening.map(r => r.low)) || 1),
    openingUpBarPct: 100 * upBars / opening.length, openingHigherClosePct: 100 * directionalBars / 14,
    openingVolume: openingVol, laterVolume: laterVol, laterToOpeningVolume: laterVol / (openingVol || 1),
    depthMeanBidSharePct: mean(depthShare), depthMedianBidSharePct: median(depthShare), depthBullishPersistencePct: depthBullPct,
    depthMeanSpreadBps: mean(d.map(x => x.spreadBps))
  }
}

const rows = top10.map(features)
const numericKeys = Object.keys(rows.find(r => !r.missing) ?? {}).filter(k => k !== 'symbol' && k !== 'missing' && k !== 'candleCount' && k !== 'depthCount')
const group = symbols => Object.fromEntries(numericKeys.map(key => [key, round(mean(rows.filter(r => symbols.includes(r.symbol) && Number.isFinite(r[key])).map(r => r[key])))]))
const output = { date, selected, comparison, note: 'Selected names are compared with the other five names in the 09:30 top-10 ranking.', groupMeans: { selected: group(selected), comparison: group(comparison) }, stocks: rows, interpretation: {
  selectedGroup: 'BAJAJHLDNG, BAJFINANCE, KAYNES, INDHOTEL, BAJAJ-AUTO and UNOMINDA',
  depthWindowIST: '09:15-09:29; top-five cash-book bid/ask sizes from received snapshots.',
  candleWindowIST: '09:15-09:29; full-session fields use all available candles after 09:15.',
  caution: 'This identifies group-level commonality, not causal predictors. Depth snapshots are asynchronous and can be noisy.'
} }
let n = 1, jsonFile
do { jsonFile = path.join(root, 'reports', `${date}-top10-selected-commonality${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(jsonFile))
fs.writeFileSync(jsonFile, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ jsonFile, groupMeans: output.groupMeans, stocks: rows }, null, 2))
