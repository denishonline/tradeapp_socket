import fs from 'node:fs'
import path from 'node:path'

const [symbolArg, date, startText, endText] = process.argv.slice(2)
const symbol = String(symbolArg ?? '').toUpperCase().replace(/-EQ$/, '')
if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(startText ?? '') || !/^\d{2}:\d{2}$/.test(endText ?? '') || startText >= endText) throw new Error('Usage: node scripts/analyze-depth-window.js SYMBOL YYYY-MM-DD HH:MM HH:MM')
const root = process.cwd(), start = Date.parse(`${date}T${startText}:00+05:30`), end = Date.parse(`${date}T${endText}:00+05:30`)
const depthFile = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`), candleFile = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
const clock = at => new Date(at + 330 * 60_000).toISOString().slice(11, 16), round = (value, digits = 3) => Number(value.toFixed(digits)), mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
if (!fs.existsSync(depthFile) || !fs.existsSync(candleFile)) throw new Error('Candle or depth file is missing.')
const state = {}, snapshots = [], minuteRows = new Map()
for (const line of fs.readFileSync(depthFile, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let event; try { event = JSON.parse(line) } catch { continue }
  const at = Date.parse(event.receivedAt); if (!Number.isFinite(at) || at >= end) break
  if (event.kind === 'checkpoint' || event.book) { for (const key of Object.keys(state)) delete state[key] }
  Object.assign(state, event.data ?? {})
  if (at < start) continue
  let bid = 0, ask = 0, valid = true
  for (let level = 1; level <= 5; level++) { const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]; if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break } bid += bs; ask += as }
  if (!valid) continue
  const row = { at, minute: clock(at), bidSharePct: 100 * bid / (bid + ask || 1), mid: (+state.bid_price1 + +state.ask_price1) / 2, bid, ask }
  snapshots.push(row); if (!minuteRows.has(row.minute)) minuteRows.set(row.minute, []); minuteRows.get(row.minute).push(row)
}
const candles = fs.readFileSync(candleFile, 'utf8').split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line), at = +row.time * 1000; return at >= start && at < end ? [{ at, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume }] : [] } catch { return [] } }).sort((a, b) => a.at - b.at)
const minuteSummary = [...minuteRows.entries()].map(([minute, rows]) => ({ minute, snapshots: rows.length, meanBidSharePct: round(mean(rows.map(row => row.bidSharePct)), 1), bidDominantSnapshotPct: round(100 * rows.filter(row => row.bidSharePct > 50).length / rows.length, 1), firstMid: round(rows[0].mid, 2), lastMid: round(rows.at(-1).mid, 2), midpointMovePct: round(100 * (rows.at(-1).mid / rows[0].mid - 1), 3) }))
const report = { symbol, date, window: `${startText}:00–${endText}:00 IST`,
  candles: { count: candles.length, open: candles[0]?.open, close: candles.at(-1)?.close, high: candles.length ? Math.max(...candles.map(row => row.high)) : null, low: candles.length ? Math.min(...candles.map(row => row.low)) : null, returnPct: candles.length ? round(100 * (candles.at(-1).close / candles[0].open - 1), 3) : null, volume: candles.reduce((sum, row) => sum + row.volume, 0) },
  depth: { snapshots: snapshots.length, observedMinutes: minuteSummary.length, meanBidSharePct: round(mean(snapshots.map(row => row.bidSharePct)), 2), bidDominantSnapshotPct: round(100 * snapshots.filter(row => row.bidSharePct > 50).length / snapshots.length, 1), bidDominantMinutePct: round(100 * minuteSummary.filter(row => row.meanBidSharePct > 50).length / minuteSummary.length, 1), midpointMovePct: round(100 * (snapshots.at(-1).mid / snapshots[0].mid - 1), 3), firstMid: round(snapshots[0].mid, 2), lastMid: round(snapshots.at(-1).mid, 2) }, minuteSummary }
const output = path.join(root, 'reports', `${date}-${symbol}-${startText.replace(':', '')}-to-${endText.replace(':', '')}-depth-window.json`)
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report, output }, null, 2))
