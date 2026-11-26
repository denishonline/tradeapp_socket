import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = process.argv[2] ?? '2026-10-19', NEAR_PCT = 0.12, IST = 330 * 60_000
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/i, '')))]
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const local = t => { const d = new Date(t * 1000 + IST); return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() } }
function candles(symbol) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`); if (!fs.existsSync(file)) return []
  const a = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { try { const r = JSON.parse(line), t = +r.time, l = local(t); if (l.date <= date && Number.isFinite(+r.close) && Number.isFinite(+r.volume)) a.push({ time: t, date: l.date, minute: l.minute, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }) } catch {} }
  return a.sort((a, b) => a.time - b.time)
}
function emaSeries(a, period) { const alpha = 2 / (period + 1), e = [a[0].close]; for (const r of a.slice(1)) e.push(alpha * r.close + (1 - alpha) * e.at(-1)); return e }
const depthCache = new Map()
function depthMinute(symbol, candleTime) {
  const d = local(candleTime), minute = d.minute, cacheKey = `${d.date}|${symbol}`
  if (!depthCache.has(cacheKey)) {
    const file = path.join(root, 'db/cash-depth', d.date, symbol, `${symbol}.jsonl`); if (!fs.existsSync(file)) { depthCache.set(cacheKey, new Map()); return null }
    const state = {}, buckets = new Map()
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; let e; try { e = JSON.parse(line) } catch { continue }; const at = Date.parse(e.receivedAt); if (!Number.isFinite(at)) continue; const lm = local(at / 1000); if (lm.date !== d.date) continue; if (e.kind === 'checkpoint' || e.book) { for (const k of Object.keys(state)) delete state[k]; Object.assign(state, e.data ?? {}) } else if (e.kind === 'update') Object.assign(state, e.data ?? {}); else continue
      let bid = 0, ask = 0, ok = true; for (let i = 1; i <= 5; i++) { const bp = +state[`bid_price${i}`], ap = +state[`ask_price${i}`], bs = +state[`bid_size${i}`], as = +state[`ask_size${i}`]; if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) { ok = false; break }; bid += bs; ask += as }; if (!ok) continue
      const mid = (+state.bid_price1 + +state.ask_price1) / 2, key = lm.minute; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push({ bidShare: 100 * bid / (bid + ask || 1), mid, spread: 10000 * (+state.ask_price1 - +state.bid_price1) / mid })
    }
    const summaries = new Map(); for (const [m, rows] of buckets) if (rows.length >= 2) { const first = rows[0], last = rows.at(-1); summaries.set(m, { snapshots: rows.length, avgBidSharePct: rows.reduce((s, x) => s + x.bidShare, 0) / rows.length, bidDominantPct: 100 * rows.filter(x => x.bidShare > 50).length / rows.length, midpointMovePct: 100 * (last.mid / first.mid - 1), avgSpreadBps: rows.reduce((s, x) => s + x.spread, 0) / rows.length }) }; depthCache.set(cacheKey, summaries)
  }
  return depthCache.get(cacheKey).get(minute) ?? null
}
const signals = []
for (const symbol of stocks) {
  const a = candles(symbol); if (a.length < 50) continue; const e5 = emaSeries(a, 5), e45 = emaSeries(a, 45); let lastSignal = -99
  for (let i = 3; i < a.length; i++) { const r = a[i]; if (r.date !== date || r.minute < 556 || r.minute >= 900 || i - lastSignal < 5) continue; const near = 100 * Math.abs(r.close / e45[i] - 1) <= NEAR_PCT; const rising = e45[i] > e45[i - 3]; const retest = a[i - 1].close > e45[i - 1] && r.low <= e45[i] * 1.0012 && r.close >= e45[i] * 0.9988; if (!(near && rising && retest)) continue; const depth = depthMinute(symbol, r.time); if (!depth || depth.avgBidSharePct <= 50 || depth.bidDominantPct <= 50 || depth.midpointMovePct < 0) continue
    signals.push({ symbol, signalTime: `${date} ${String(Math.floor(r.minute / 60)).padStart(2, '0')}:${String(r.minute % 60).padStart(2, '0')}`, signalClose: r.close, ema45: round(e45[i], 2), ema45Rise3mPct: round(100 * (e45[i] / e45[i - 3] - 1), 4), ema5: round(e5[i], 2), depth }); lastSignal = i }
}
const output = { date, rules: { priceNearEMA45: `<=${NEAR_PCT}%`, risingEMA45: 'EMA45 higher than 3 candles earlier', bullishRetest: 'previous close above EMA45; current low touches EMA45 and closes near/above it', depthSupport: 'average bid share >50%, bid-dominant snapshots >50%, midpoint move >=0%' }, note: 'Candidate conditions only. Use replay-ema45-retest-chronological.js for next-candle entries and realized exits.', signalCount: signals.length, signals }
let n = 1, out
do { out = path.join(root, 'reports', `${date}-ema45-retest-strict-near-target-signals${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(out))
fs.writeFileSync(out, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' }); console.log(`Date: ${date} | strict-near signals: ${signals.length}`); console.log(`JSON: ${out}`)
