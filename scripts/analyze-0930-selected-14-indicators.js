import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), date = '2026-10-22'
const selected = ['BAJAJHLDNG', 'BAJFINANCE', 'KAYNES', 'INDHOTEL', 'BAJAJ-AUTO', 'UNOMINDA']
const comparison = ['ETERNAL', 'DELHIVERY', 'GLAND', 'KOTAKBANK']
const priorDates = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-21']
const round = (x, p = 3) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const ist = epoch => new Date(Number(epoch) * 1000 + 330 * 60_000)
function parts(epoch) { const d = ist(epoch); return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() } }
function candleWindows(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`), dates = [...priorDates, date], map = new Map(dates.map(d => [d, new Map()]))
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; let r; try { r = JSON.parse(line) } catch { continue }; const p = parts(r.time); if (!map.has(p.date) || p.minute < 555 || p.minute >= 570) continue; const v = ['open', 'high', 'low', 'close', 'volume'].map(k => +r[k]); if (v.every(Number.isFinite)) map.get(p.date).set(p.minute, { open: v[0], high: v[1], low: v[2], close: v[3], volume: v[4] }) }
  return new Map([...map].map(([d, m]) => [d, [...m].sort((a, b) => a[0] - b[0]).map(([, r]) => r)]))
}
function depth(symbol) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`); if (!fs.existsSync(file)) return []
  const state = {}, out = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; let e; try { e = JSON.parse(line) } catch { continue }; const p = parts(Date.parse(e.receivedAt) / 1000); if (p.date !== date || p.minute < 555 || p.minute >= 570) continue; if (e.kind === 'checkpoint') for (const k of Object.keys(state)) delete state[k]; Object.assign(state, e.data ?? {}); const b = [], a = []; for (let n = 1; n <= 5; n++) { const bp = +state[`bid_price${n}`], ap = +state[`ask_price${n}`], bs = +state[`bid_size${n}`], as = +state[`ask_size${n}`]; if (![bp, ap, bs, as].every(Number.isFinite) || ap <= bp) { b.length = 0; break }; b.push(bs); a.push(as) }; if (b.length === 5) { const bs = b.reduce((x, y) => x + y, 0), as = a.reduce((x, y) => x + y, 0); out.push({ bidShare: 100 * bs / (bs + as), spreadBps: 10000 * (+state.ask_price1 - +state.bid_price1) / ((+state.ask_price1 + +state.bid_price1) / 2) }) } }
  return out
}
function rsi(c) { let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const x = c[i] - c[i - 1]; if (x > 0) g += x; else l -= x }; return l ? 100 - 100 / (1 + g / l) : g ? 100 : 50 }
function mfi(rows) { let p = 0, n = 0; for (let i = 1; i < rows.length; i++) { const prev = (rows[i - 1].high + rows[i - 1].low + rows[i - 1].close) / 3, cur = (rows[i].high + rows[i].low + rows[i].close) / 3, flow = cur * rows[i].volume; if (cur > prev) p += flow; else if (cur < prev) n += flow }; return n ? 100 - 100 / (1 + p / n) : p ? 100 : 50 }
function angle(c) { const y = c.map(Math.log), xm = 7, ym = mean(y); let co = 0, va = 0; y.forEach((v, i) => { co += (i - xm) * (v - ym); va += (i - xm) ** 2 }); return Math.atan(100 * co / va) * 180 / Math.PI }
function features(symbol) {
  const w = candleWindows(symbol), rows = w.get(date), d = depth(symbol); if (!rows || rows.length !== 15 || priorDates.some(x => w.get(x)?.length !== 15)) return { symbol, missing: true }
  const c = rows.map(x => x.close), first = rows[0], last = rows.at(-1), hi = Math.max(...rows.map(x => x.high)), lo = Math.min(...rows.map(x => x.low)), vol = rows.reduce((s, x) => s + x.volume, 0), priorVol = mean(priorDates.map(x => w.get(x).reduce((s, r) => s + r.volume, 0)))
  let e9 = c[0], e45 = c[0]; for (let i = 1; i < c.length; i++) { e9 = .2 * c[i] + .8 * e9; e45 = 2 / 46 * c[i] + 44 / 46 * e45 }
  const vwap = rows.reduce((s, x) => s + ((x.high + x.low + x.close) / 3) * x.volume, 0) / vol, bid = d.map(x => x.bidShare)
  return { symbol, missing: false, momentumPct: 100 * (last.close / first.open - 1), rsi14: rsi(c), mfi14: mfi(rows), trendAngleDeg: angle(c), emaGapPct: 100 * (e9 / e45 - 1), vwapPositionPct: 100 * (last.close / vwap - 1), rangePct: 100 * (hi - lo) / first.open, closeLocationPct: 100 * (last.close - lo) / (hi - lo || 1), upBarsPct: 100 * rows.filter(x => x.close > x.open).length / 15, higherClosesPct: 100 * rows.slice(1).filter((x, i) => x.close > rows[i].close).length / 14, volumeRatio: vol / (priorVol || 1), depthBidSharePct: mean(bid), depthBullishPct: bid.length ? 100 * bid.filter(x => x > 50).length / bid.length : null, spreadBps: mean(d.map(x => x.spreadBps)) }
}
const rows = [...selected, ...comparison].map(features), keys = ['momentumPct', 'rsi14', 'mfi14', 'trendAngleDeg', 'emaGapPct', 'vwapPositionPct', 'rangePct', 'closeLocationPct', 'upBarsPct', 'higherClosesPct', 'volumeRatio', 'depthBidSharePct', 'depthBullishPct', 'spreadBps']
const conditions = { momentumPct: x => x > 0, rsi14: x => x > 50, mfi14: x => x > 50, trendAngleDeg: x => x > 0, emaGapPct: x => x > 0, vwapPositionPct: x => x > 0, rangePct: x => x >= 1, closeLocationPct: x => x >= 85, upBarsPct: x => x >= 60, higherClosesPct: x => x >= 60, volumeRatio: x => x > 1, depthBidSharePct: x => x > 50, depthBullishPct: x => x > 50, spreadBps: x => x <= 5 }
const group = names => Object.fromEntries(keys.map(k => [k, { average: round(mean(rows.filter(r => names.includes(r.symbol) && Number.isFinite(r[k])).map(r => r[k]))), passing: rows.filter(r => names.includes(r.symbol) && conditions[k](r[k])).map(r => r.symbol) }]))
const output = { date, selected, comparison, methodology: 'Opening 15 one-minute candles 09:15-09:29 IST; depth uses received top-five book snapshots in the same window; volume ratio compares each stock with its own five-session average.', selectedGroup: group(selected), comparisonGroup: group(comparison), stocks: rows }
let n = 1, file; do { file = path.join(root, 'reports', `${date}-selected-14-indicator-commonality${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file)); fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ file, selected: output.selectedGroup, comparison: output.comparisonGroup, stocks: rows }, null, 2))
