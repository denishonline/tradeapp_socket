import fs from 'node:fs'
import path from 'node:path'

const symbols = ['AMBER', 'BANDHANBNK', 'GODFRYPHLP', 'IDFCFIRSTB', 'PGEL', 'TATACONSUM']
const date = '2026-10-26'
const root = path.join('db', 'cash-depth', date)
const results = []
const candleRows = symbol => fs.readFileSync(path.join('db', 'candles', `${symbol}.jsonl`), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).sort((a, b) => a.time - b.time)
const stamp = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const day = seconds => stamp(seconds).slice(0, 10), clock = seconds => stamp(seconds).slice(11)
for (const symbol of symbols) {
  const file = path.join(root, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) { results.push({ symbol, missing: true }); continue }
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const row = rows.at(-1), data = row?.data ?? {}, depthTime = Date.parse(row?.receivedAt)
  const bid = [1, 2, 3, 4, 5].reduce((sum, n) => sum + Number(data[`bid_size${n}`] || 0), 0)
  const ask = [1, 2, 3, 4, 5].reduce((sum, n) => sum + Number(data[`ask_size${n}`] || 0), 0)
  const bidOrders = [1, 2, 3, 4, 5].reduce((sum, n) => sum + Number(data[`bid_order${n}`] || 0), 0)
  const askOrders = [1, 2, 3, 4, 5].reduce((sum, n) => sum + Number(data[`ask_order${n}`] || 0), 0)
  const candles = candleRows(symbol), currentDate = day(depthTime / 1000), cutoffClock = clock(depthTime / 1000)
  const sessions = new Map()
  for (const candle of candles) { const d = day(candle.time); if (!sessions.has(d)) sessions.set(d, []); sessions.get(d).push(candle) }
  const priorDates = [...sessions.keys()].filter(d => d < currentDate && sessions.get(d).length >= 300).sort().slice(-2)
  const cumulative = (list, d, until) => list.filter(c => day(c.time) === d && clock(c.time) >= '09:15' && clock(c.time) <= until).reduce((sum, c) => sum + Number(c.volume || 0), 0)
  const currentVolume = cumulative(candles, currentDate, cutoffClock), priorVolumes = priorDates.map(d => cumulative(sessions.get(d), d, cutoffClock)), priorAverageVolume = priorVolumes.length === 2 ? priorVolumes.reduce((a, b) => a + b, 0) / 2 : null
  results.push({ symbol, receivedAt: row.receivedAt, bidPrice1: data.bid_price1, askPrice1: data.ask_price1, spread: Number(data.ask_price1) - Number(data.bid_price1), bidSize5: bid, askSize5: ask, bidSharePct: 100 * bid / (bid + ask || 1), bidOrders5: bidOrders, askOrders5: askOrders, bidOrderSharePct: 100 * bidOrders / (bidOrders + askOrders || 1), currentVolume, priorAverageVolume, volumeVsPrior2SameTimePct: priorAverageVolume ? 100 * (currentVolume / priorAverageVolume - 1) : null })
}
console.log(JSON.stringify(results.sort((a, b) => (b.bidSharePct ?? -1) - (a.bidSharePct ?? -1)), null, 2))
