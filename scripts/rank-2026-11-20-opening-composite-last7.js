import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd(), DATE = process.argv[2] || '2026-11-20', IST = 330 * 60_000
const stamp = time => new Date(Number(time) * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const round = (value, places = 2) => Number.isFinite(value) ? Number(value.toFixed(places)) : null
const sectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(sectors).filter(([key]) => key !== '_meta').flatMap(([, values]) => values))].sort()

const candleFeature = (all, day) => {
  const bars = all.filter(x => x.day === day && x.minute >= '09:15' && x.minute <= '09:18')
  if (bars.length !== 4) return null
  const volume = bars.reduce((sum, x) => sum + x.volume, 0)
  return { day, volume, returnPct: 100 * (bars.at(-1).close / bars[0].open - 1) }
}

function depthScore(symbol) {
  const file = path.join(ROOT, 'db', 'cash-depth', DATE, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { score: null, snapshots: 0 }
  const fields = {}, rows = []; let previous = null
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    try {
      if (!line.trim()) continue
      const event = JSON.parse(line), at = Date.parse(event.receivedAt), minute = new Date(at + IST).toISOString().slice(11, 16)
      if (minute < '09:15' || minute > '09:18') continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, event.data || {})
      const bp = +fields.bid_price1, ap = +fields.ask_price1
      const bids = Array.from({ length: 5 }, (_, i) => +fields[`bid_size${i + 1}`]), asks = Array.from({ length: 5 }, (_, i) => +fields[`ask_size${i + 1}`])
      if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || ap <= bp) continue
      const bidTotal = bids.reduce((a, b) => a + b, 0), askTotal = asks.reduce((a, b) => a + b, 0)
      const ofi = previous && at - previous.at <= 90_000 ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0) : 0
      rows.push({ at, minute, bp, ap, mid: (bp + ap) / 2, bid1: bids[0], bidTotal, askTotal, spread: 10_000 * (ap - bp) / ((bp + ap) / 2), ofi })
      previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
    } catch {}
  }
  if (rows.length < 2) return { score: null, snapshots: rows.length }
  const first = rows[0], last = rows.at(-1), byMinute = Map.groupBy(rows, x => x.minute)
  const minutes = [...byMinute.values()].map(group => ({ mid: group.reduce((s, x) => s + x.mid, 0) / group.length, bid: group.reduce((s, x) => s + x.bidTotal, 0) / group.length, ask: group.reduce((s, x) => s + x.askTotal, 0) / group.length }))
  const minBidRatio = Math.min(...minutes.map(x => x.bid)) / minutes[0].bid, maxAskRatio = Math.max(...minutes.map(x => x.ask)) / minutes[0].ask
  const ofi = rows.reduce((sum, x) => sum + x.ofi, 0), p90 = [...rows.map(x => x.spread)].sort((a, b) => a - b)[Math.floor((rows.length - 1) * .9)]
  const checks = [last.mid > first.mid, last.bp > first.bp, last.bid1 >= first.bid1 * .7 && minBidRatio >= .7, rows.filter(x => x.ofi > 0).length > rows.filter(x => x.ofi < 0).length, maxAskRatio <= 1.5, last.ap >= first.ap, minBidRatio >= .7, ofi > 0, last.spread <= first.spread * 1.25 && p90 <= first.spread * 1.5, last.mid >= Math.max(...rows.map(x => x.mid)) * .9995]
  return { score: checks.filter(Boolean).length, snapshots: rows.length, midpointPct: 100 * (last.mid / first.mid - 1), ofi }
}

const out = []
for (let index = 0; index < symbols.length; index++) {
  const symbol = symbols[index]
  process.stdout.write(`\rScoring ${index + 1}/${symbols.length} ${symbol}`.padEnd(52))
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`); if (!fs.existsSync(file)) continue
  const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { const x = JSON.parse(line), local = stamp(x.time); return [{ day: local.slice(0, 10), minute: local.slice(11), close: +x.close, open: +x.open, volume: +x.volume || 0 }] } catch { return [] } })
  const days = [...new Set(all.map(x => x.day))].filter(day => day <= DATE).sort().slice(-7)
  const features = days.map(day => candleFeature(all, day)).filter(Boolean), current = features.find(x => x.day === DATE)
  if (!current || features.length < 7) continue
  const volumeRank = 1 + features.filter(x => x.volume > current.volume).length, returnRank = 1 + features.filter(x => x.returnPct > current.returnPct).length
  const volumePoints = Math.max(0, 2 - .5 * (volumeRank - 1)), returnPoints = Math.max(0, 3 - .75 * (returnRank - 1)), depth = depthScore(symbol), depthPoints = depth.score === null ? null : depth.score / 2
  out.push({ Symbol: symbol, 'Volume rank /7': volumeRank, 'Return rank /7': returnRank, 'Volume pts /2': round(volumePoints, 1), 'Return pts /3': round(returnPoints, 2), 'Depth /10': depth.score ?? '-', 'Depth pts /5': depthPoints === null ? '-' : round(depthPoints, 1), 'Composite /10': depthPoints === null ? '-' : round(volumePoints + returnPoints + depthPoints, 2), 'Opening return %': round(current.returnPct, 3), 'Opening volume': current.volume, 'Depth midpoint %': round(depth.midpointPct, 3), OFI: depth.ofi == null ? '-' : Math.round(depth.ofi) })
}
process.stdout.write('\n')
const ranked = out.filter(x => typeof x['Composite /10'] === 'number').sort((a, b) => b['Composite /10'] - a['Composite /10'] || a.Symbol.localeCompare(b.Symbol))
let suffix = 1, report
do { report = path.join(ROOT, 'reports', `${DATE}-0915-0918-composite-last7-depth${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(report))
fs.writeFileSync(report, `${JSON.stringify({ date: DATE, window: 'Completed 09:15–09:18 IST candles and depth snapshots', scoring: { volume: 'rank among seven sessions: 2,1.5,1,0.5,0…', return: 'rank among seven sessions: 3,2.25,1.5,0.75,0…', depth: 'current 10-behaviour displayed-depth score / 2', missingDepth: 'excluded from composite, not scored as zero' }, rankedCount: ranked.length, signals: ranked }, null, 2)}\n`, { flag: 'wx' })
console.table(ranked.slice(0, 30))
console.log(`Ranked stocks with usable depth: ${ranked.length}; report: ${report}`)
