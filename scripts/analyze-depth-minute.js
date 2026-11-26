import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), symbol = (process.argv[2] ?? 'ULTRACEMCO').replace(/-EQ$/i, '').toUpperCase(), date = process.argv[3] ?? '2026-10-19', minuteText = process.argv[4] ?? '09:31'
const start = Date.parse(`${date}T${minuteText}:00+05:30`), end = start + 60_000
const previousStart = start - 60_000
const file = path.join(root, 'db/cash-depth', date, symbol, `${symbol}.jsonl`)
if (!fs.existsSync(file)) throw new Error(`Missing depth file: ${file}`)
const round = (x, p = 3) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const localTime = at => new Date(at + 330 * 60_000).toISOString().slice(11, 19)
function book(state, at, event) {
  const bids = [], asks = []
  for (let i = 1; i <= 5; i++) {
    const bp = +state[`bid_price${i}`], ap = +state[`ask_price${i}`], bs = +state[`bid_size${i}`], as = +state[`ask_size${i}`]
    if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) return null
    bids.push({ price: bp, size: bs }); asks.push({ price: ap, size: as })
  }
  const bidSize = bids.reduce((s, x) => s + x.size, 0), askSize = asks.reduce((s, x) => s + x.size, 0)
  const mid = (bids[0].price + asks[0].price) / 2
  return { at, timeIST: localTime(at), bidSize, askSize, bidSharePct: 100 * bidSize / (bidSize + askSize || 1), spreadBps: 10000 * (asks[0].price - bids[0].price) / mid, mid,
    bid1: bids[0].price, ask1: asks[0].price, bid5: bids[4].price, ask5: asks[4].price,
    marketPrice: Number(event.marketContext?.price), cumulativeVolume: Number(event.marketContext?.cumulativeVolume) }
}
const state = {}, byMinute = new Map(), all = []
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let event
  try { event = JSON.parse(line) } catch { continue }
  const at = Date.parse(event.receivedAt)
  if (!Number.isFinite(at)) continue
  if (at >= end) break
  if (event.kind === 'checkpoint' || event.book) { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, event.data ?? {}) }
  else if (event.kind === 'update') Object.assign(state, event.data ?? {})
  else continue
  const snapshot = book(state, at, event)
  if (!snapshot || at < previousStart) continue
  all.push(snapshot)
  const key = Math.floor((at - previousStart) / 60_000)
  if (!byMinute.has(key)) byMinute.set(key, [])
  byMinute.get(key).push(snapshot)
}
const previous = byMinute.get(0) ?? [], current = byMinute.get(1) ?? []
if (!current.length) throw new Error(`No valid depth snapshots received during ${date} ${minuteText}`)
const first = current[0], last = current.at(-1), prior = previous.at(-1)
const summary = { symbol, date, minuteIST: minuteText, depthFile: file, snapshots: current.length, previousMinuteSnapshots: previous.length,
  firstSnapshot: first, lastSnapshot: last,
  previousMinuteLast: prior ?? null,
  changesDuringMinute: { midpointMovePct: round(100 * (last.mid / first.mid - 1), 4), bidShareChangePctPoints: round(last.bidSharePct - first.bidSharePct, 3), spreadChangeBps: round(last.spreadBps - first.spreadBps, 3), bid1MovePct: round(100 * (last.bid1 / first.bid1 - 1), 4), ask1MovePct: round(100 * (last.ask1 / first.ask1 - 1), 4) },
  changesFromPreviousMinute: prior ? { midpointMovePct: round(100 * (first.mid / prior.mid - 1), 4), bidShareChangePctPoints: round(first.bidSharePct - prior.bidSharePct, 3), spreadChangeBps: round(first.spreadBps - prior.spreadBps, 3), bid1MovePct: round(100 * (first.bid1 / prior.bid1 - 1), 4), ask1MovePct: round(100 * (first.ask1 / prior.ask1 - 1), 4) } : null,
  behavior: { bidDominantSnapshots: current.filter(x => x.bidSharePct > 50).length, bidDominantPct: round(100 * current.filter(x => x.bidSharePct > 50).length / current.length, 1), meanBidSharePct: round(current.reduce((s, x) => s + x.bidSharePct, 0) / current.length, 2), meanSpreadBps: round(current.reduce((s, x) => s + x.spreadBps, 0) / current.length, 3), midpointDirection: last.mid > first.mid ? 'up' : last.mid < first.mid ? 'down' : 'flat', bidAskPressure: last.bidSharePct > first.bidSharePct ? 'bid pressure increased' : last.bidSharePct < first.bidSharePct ? 'bid pressure decreased' : 'unchanged' } }
let n = 1, out
do { out = path.join(root, 'reports', `${date}-${symbol}-${minuteText.replace(':', '')}-depth-analysis${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(out))
fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(summary, null, 2)); console.log(`JSON: ${out}`)
