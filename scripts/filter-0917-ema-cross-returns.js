import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null }
const root = process.cwd(), date = arg('--date') || process.argv[2] || '2026-11-04', entryHm = arg('--time') || process.argv[3] || '09:17', stopPct = Number(arg('--sl') || 0.8), minReturn = Number(arg('--min-return') || 2), side = (arg('--side') || 'BOTH').toUpperCase()
const from = arg('--from'), to = arg('--to')
const live = !process.argv.includes('--backtest'), cutoffHm = arg('--cutoff') || entryHm
if (side === 'BOTH') {
  for (const s of ['BUY', 'SELL']) execFileSync(process.execPath, [process.argv[1], '--date', date, '--time', entryHm, '--sl', String(stopPct), '--min-return', String(minReturn), '--side', s, live ? '--live' : '--backtest'], { stdio: 'inherit' })
  process.exit(0)
}
const IST = 330 * 60_000
const local = t => { const d = new Date(t * 1000 + IST); return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) } }
const ema = (prev, v, p) => prev == null ? v : prev + 2 / (p + 1) * (v - prev)
const pct = (a, b) => 100 * (a / b - 1)
const round = x => Number(x.toFixed(3))
const candleDir = path.join(root, 'db', 'candles')
const candidateRows = symbol => {
  const file = path.join(candleDir, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .map(x => ({ ...x, ...local(Number(x.time)) }))
    .filter(x => x.date === date && x.hm >= '09:15' && x.hm <= entryHm)
    .sort((a, b) => a.time - b.time).slice(-3)
}
const qualifies = rows => {
  if (rows.length !== 3 || rows[0].hm !== '09:15' || rows[2].hm !== entryHm) return false
  const [a, b, c] = rows, range = Math.max(0.01, a.high - a.low)
  if (side === 'BUY') return a.close < a.open && (a.open - a.close) / range > .25 && b.close > a.close && c.close >= b.close && c.high > b.high && c.close > b.open
  return a.close > a.open && (a.close - a.open) / range > .25 && b.close < a.close && c.close <= b.close && c.low < b.low && c.close < b.open
}
const candidates = fs.readdirSync(candleDir).filter(x => x.endsWith('.jsonl') && !/^NIFTY/i.test(x)).map(x => x.replace(/\.jsonl$/, '')).filter(symbol => qualifies(candidateRows(symbol)))
const out = []

for (const symbol of candidates) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) continue
  const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).map(x => ({ ...x, ...local(Number(x.time)) })).filter(x => x.date === date && x.hm >= '09:15' && x.hm <= (live ? cutoffHm : '15:30')).sort((a, b) => a.time - b.time)
  const i = all.findIndex(x => x.hm === entryHm)
  if (i < 0) continue
  const entry = all[i].close
  let e20, e40
  for (const x of all.slice(0, i + 1)) { e20 = ema(e20, x.close, 20); e40 = ema(e40, x.close, 40) }
  let exit
  for (const x of all.slice(i + 1)) {
    const prev20 = e20, prev40 = e40
    e20 = ema(e20, x.close, 20); e40 = ema(e40, x.close, 40)
    if (side === 'SELL' ? x.high >= entry * (1 + stopPct / 100) : x.low <= entry * (1 - stopPct / 100)) { exit = { time: x.hm, price: entry * (side === 'SELL' ? 1 + stopPct / 100 : 1 - stopPct / 100), reason: 'SL' }; break }
    if (side === 'SELL' ? (prev20 <= prev40 && e20 > e40) : (prev20 >= prev40 && e20 < e40)) { exit = { time: x.hm, price: x.close, reason: side === 'SELL' ? 'EMA20>EMA40' : 'EMA20<EMA40' }; break }
  }
  if (!exit && !live) { const x = all.at(-1); exit = { time: x.hm, price: x.close, reason: 'EOD' } }
  if (live) { out.push({ symbol, side, entryTime: entryHm, entry: round(entry), status: 'OPEN—future exit not evaluated' }); continue }
  const ret = side === 'SELL' ? pct(entry, exit.price) : pct(exit.price, entry)
  if (ret > minReturn) out.push({ symbol, side, entry: round(entry), exitTime: exit.time, exit: round(exit.price), reason: exit.reason, returnPct: round(ret) })
}

out.sort((a, b) => b.returnPct - a.returnPct)
const report = path.join(root, 'reports', `${date}-${entryHm.replace(':', '')}-${side.toLowerCase()}-ema-cross-sl${String(stopPct).replace('.', '')}-over${String(minReturn).replace('.', '')}.json`)
fs.writeFileSync(report, JSON.stringify({ date, side, entryTime: entryHm, stopLossPct: stopPct, exit: side === 'SELL' ? 'first EMA20 above EMA40 or SL' : 'first EMA20 below EMA40 or SL', minimumReturnPct: minReturn, candidates: candidates.length, qualifying: out }, null, 2) + '\n')
console.table(out)
