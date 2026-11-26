import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd(), date = process.argv[2] || '2026-11-20', IST = 330 * 60_000
const start = '09:15', endExclusive = process.argv[3] || '09:26'
const sectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'db', 'stocks_sector_wise'), 'utf8'))
const symbols = [...new Set(Object.entries(sectors).filter(([key]) => key !== '_meta').flatMap(([, values]) => values))].sort()
const clock = at => new Date(at + IST).toISOString().slice(11, 16)
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function evaluate(symbol) {
  const file = path.join(ROOT, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return null
  const fields = {}, rows = []; let previous = null
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    try {
      if (!line.trim()) continue
      const event = JSON.parse(line), at = Date.parse(event.receivedAt), minute = clock(at)
      if (minute < start || minute >= endExclusive) continue
      if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
      Object.assign(fields, event.data || {})
      const bp = +fields.bid_price1, ap = +fields.ask_price1
      const bids = Array.from({ length: 5 }, (_, i) => +fields[`bid_size${i + 1}`]), asks = Array.from({ length: 5 }, (_, i) => +fields[`ask_size${i + 1}`])
      if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || bp <= 0 || ap <= bp) continue
      const bidTotal = bids.reduce((a, b) => a + b, 0), askTotal = asks.reduce((a, b) => a + b, 0)
      const ofi = previous && at - previous.at <= 90_000 ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0) : 0
      rows.push({ at, minute, bp, ap, mid: (bp + ap) / 2, bid1: bids[0], bidTotal, askTotal, spreadBps: 10_000 * (ap - bp) / ((bp + ap) / 2), ofi })
      previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
    } catch {}
  }
  if (rows.length < 2) return null
  const first = rows[0], last = rows.at(-1), mids = rows.map(x => x.mid), maxMid = Math.max(...mids)
  const grouped = Map.groupBy(rows, x => x.minute)
  const minutes = [...grouped.keys()].sort().map(minute => {
    const group = grouped.get(minute)
    return { minute, mid: group.reduce((sum, x) => sum + x.mid, 0) / group.length, bid: group.reduce((sum, x) => sum + x.bidTotal, 0) / group.length, ask: group.reduce((sum, x) => sum + x.askTotal, 0) / group.length }
  })
  const bidUp = rows.slice(1).filter((x, index) => x.bp > rows[index].bp).length, bidDown = rows.slice(1).filter((x, index) => x.bp < rows[index].bp).length
  const askUp = rows.slice(1).filter((x, index) => x.ap > rows[index].ap).length, askDown = rows.slice(1).filter((x, index) => x.ap < rows[index].ap).length
  const minBidRatio = Math.min(...minutes.map(x => x.bid)) / minutes[0].bid, maxAskRatio = Math.max(...minutes.map(x => x.ask)) / minutes[0].ask
  const sortedSpreads = rows.map(x => x.spreadBps).sort((a, b) => a - b), p90 = sortedSpreads[Math.floor((sortedSpreads.length - 1) * .9)]
  const cumulativeOfi = rows.reduce((sum, x) => sum + x.ofi, 0)
  const checks = {
    midpointStairStepHigher: last.mid > first.mid && minutes.every((x, index) => !index || x.mid >= minutes[index - 1].mid),
    bestBidStepsHigher: last.bp > first.bp && bidUp > bidDown,
    bidRefillsAtHigherLevels: last.bid1 >= first.bid1 * .7 && minBidRatio >= .7,
    offersAbsorbed: rows.filter(x => x.ofi > 0).length > rows.filter(x => x.ofi < 0).length,
    noPersistentAskWall: maxAskRatio <= 1.5,
    asksRetreatUpward: last.ap >= first.ap && askUp >= askDown,
    topFiveBidSupportStable: minBidRatio >= .7,
    positiveOrderFlowImbalance: cumulativeOfi > 0,
    spreadOrderly: last.spreadBps <= first.spreadBps * 1.25 && p90 <= first.spreadBps * 1.5,
    noAdverseDepthReversal: 10_000 * (last.mid / maxMid - 1) >= -5,
  }
  const passed = Object.entries(checks).filter(([, value]) => value).map(([key]) => key)
  return { Stock: symbol, 'Passed /10': passed.length, 'Midpoint %': round(100 * (last.mid / first.mid - 1)), OFI: Math.round(cumulativeOfi), 'Best bid %': round(100 * (last.bp / first.bp - 1)), Passed: passed.join(', '), Failed: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key).join(', ') }
}

const results = []
for (let index = 0; index < symbols.length; index++) {
  process.stdout.write(`\rScanning ${index + 1}/${symbols.length} ${symbols[index]}`.padEnd(52))
  const result = evaluate(symbols[index]); if (result) results.push(result)
}
process.stdout.write('\n')
results.sort((a, b) => b['Passed /10'] - a['Passed /10'] || b['Midpoint %'] - a['Midpoint %'] || b.OFI - a.OFI || a.Stock.localeCompare(b.Stock))
let suffix = 1, file
do { file = path.join(ROOT, 'reports', `${date}-0915-0925-depth-core-signatures${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify({ date, window: '09:15 through completed 09:25 IST minute', signatureCount: 10, stocksWithDepth: results.length, top10: results.slice(0, 10), all: results }, null, 2)}\n`, { flag: 'wx' })
console.table(results.slice(0, 10).map(({ Passed, Failed, ...summary }) => summary))
console.log(`Stocks with usable depth: ${results.length}; report: ${file}`)
