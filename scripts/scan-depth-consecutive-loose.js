import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), dates = process.argv.slice(2).length ? process.argv.slice(2) : ['2026-10-15', '2026-10-16']
const IST = 330 * 60_000, round = (x, p = 3) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const stocks = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8')).map(x => String(x).trim().toUpperCase().replace(/-EQ$/i, '')))]
const condition = x => x.avgBidSharePct > 45 && x.cumulativeVolumeIncrease > 10000 && x.avgSpreadBps > 6 && x.midpointMovePct < -0.5

function localMinute(iso) {
  const at = Date.parse(iso); if (!Number.isFinite(at)) return null
  const d = new Date(at + IST); return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() }
}
function minuteStats(file, date) {
  const state = {}, buckets = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const lm = localMinute(event.receivedAt); if (!lm || lm.date !== date) continue
    if (event.kind === 'checkpoint' || event.book) { for (const k of Object.keys(state)) delete state[k]; Object.assign(state, event.data ?? {}) }
    else if (event.kind === 'update') Object.assign(state, event.data ?? {})
    else continue
    let bid = 0, ask = 0, valid = true
    for (let i = 1; i <= 5; i++) { const bp = +state[`bid_price${i}`], ap = +state[`ask_price${i}`], bs = +state[`bid_size${i}`], as = +state[`ask_size${i}`]; if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) { valid = false; break }; bid += bs; ask += as }
    if (!valid) continue
    const mid = (+state.bid_price1 + +state.ask_price1) / 2, spreadBps = 10000 * (+state.ask_price1 - +state.bid_price1) / mid, cumulativeVolume = Number(event.marketContext?.cumulativeVolume)
    if (!buckets.has(lm.minute)) buckets.set(lm.minute, [])
    buckets.get(lm.minute).push({ bidSharePct: 100 * bid / (bid + ask || 1), mid, spreadBps, cumulativeVolume })
  }
  const out = []
  for (const [minute, a] of buckets) { if (a.length < 2) continue; const first = a[0], last = a.at(-1); out.push({ minute, snapshots: a.length, avgBidSharePct: a.reduce((s, x) => s + x.bidSharePct, 0) / a.length, cumulativeVolumeIncrease: last.cumulativeVolume - first.cumulativeVolume, avgSpreadBps: a.reduce((s, x) => s + x.spreadBps, 0) / a.length, midpointMovePct: 100 * (last.mid / first.mid - 1) }) }
  return out.sort((a, b) => a.minute - b.minute)
}

const pairs = [], qualifyingMinutes = []
for (const date of dates) for (const symbol of stocks) {
  const file = path.join(root, 'db/cash-depth', date, symbol, `${symbol}.jsonl`); if (!fs.existsSync(file)) continue
  const stats = minuteStats(file, date), good = stats.filter(condition)
  for (const row of good) qualifyingMinutes.push({ date, symbol, ...row, timeIST: `${String(Math.floor(row.minute / 60)).padStart(2, '0')}:${String(row.minute % 60).padStart(2, '0')}` })
  for (let i = 1; i < good.length; i++) if (good[i].minute === good[i - 1].minute + 1) pairs.push({ date, symbol, first: good[i - 1], second: good[i] })
}
const output = { dates, symbolsScanned: stocks.length, thresholds: { avgBidSharePct: '>45', cumulativeVolumeIncrease: '>10000', avgSpreadBps: '>6', midpointMovePct: '<-0.5' }, qualifyingMinuteCount: qualifyingMinutes.length, consecutivePairCount: pairs.length, consecutivePairs: pairs, qualifyingMinutes }
const out = path.join(root, 'reports', `depth-consecutive-conditions-loose-${dates.join('-')}.json`); fs.writeFileSync(out, JSON.stringify(output, null, 2) + '\n')
console.log(`Dates: ${dates.join(', ')} | qualifying minutes: ${qualifyingMinutes.length} | consecutive pairs: ${pairs.length}`)
for (const p of pairs) console.log(`${p.date} ${p.symbol} ${p.first.minute}→${p.second.minute}`)
console.log(`JSON: ${out}`)
