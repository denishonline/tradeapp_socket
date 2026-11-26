import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const dates = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']
const named = new Set([
  '2026-11-19|VOLTAS', '2026-11-19|AMBER', '2026-11-19|IREDA', '2026-11-19|EICHERMOT',
  '2026-11-19|M&M', '2026-11-19|MARUTI', '2026-11-19|TVSMOTOR', '2026-11-19|TATATECH',
  '2026-11-20|INDUSINDBK', '2026-11-20|APOLLOHOSP', '2026-11-20|UNIONBANK', '2026-11-20|AXISBANK',
  '2026-11-20|PERSISTENT', '2026-11-20|BAJFINANCE', '2026-11-20|INDHOTEL'
])
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const pct = (to, from) => from ? 100 * (to / from - 1) : null
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const escapeCsv = value => value == null ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value)

const candleCache = new Map()
function loadCandles(symbol) {
  if (candleCache.has(symbol)) return candleCache.get(symbol)
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const stamp = local(+x.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
    if (date > dates.at(-1) || minute < '09:15' || minute > '15:29') continue
    unique.set(stamp, { date, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume || 0 })
  }
  const rows = [...unique.values()].sort((a, b) => `${a.date} ${a.minute}`.localeCompare(`${b.date} ${b.minute}`))
  candleCache.set(symbol, rows)
  return rows
}

function metrics(rows, cutoffMinute) {
  const window = rows.filter(x => x.minute <= cutoffMinute)
  if (!window.length) return null
  const high = Math.max(...window.map(x => x.high)), low = Math.min(...window.map(x => x.low)), last = window.at(-1)
  const volume = window.reduce((sum, x) => sum + x.volume, 0)
  const turnover = window.reduce((sum, x) => sum + ((x.high + x.low + x.close) / 3) * x.volume, 0)
  const vwap = volume ? turnover / volume : last.close
  const path = window.slice(1).reduce((sum, x, i) => sum + Math.abs(x.close - window[i].close), 0)
  return {
    returnPct: pct(last.close, window[0].open), volume, turnover, rangePct: pct(high, low),
    closeLocationPct: 100 * (last.close - low) / (high - low || 1), greenPct: 100 * window.filter(x => x.close > x.open).length / window.length,
    efficiency: Math.abs(last.close - window[0].open) / (path || Math.abs(last.close - window[0].open) || 1), closeVsVwapPct: pct(last.close, vwap)
  }
}

const rows = []
for (const date of dates) {
  const reportFile = path.join(root, 'reports', `${date}-0930-opening-confirmations-cutoff.json`)
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  for (const signal of report.results.filter(x => x.status === 'ENTRY_READY' || (named.has(`${date}|${x.symbol}`) && x.entryCandle))) {
    const all = loadCandles(signal.symbol), grouped = Map.groupBy(all, x => x.date), today = grouped.get(date) ?? []
    const signalMinute = signal.signalCandle, current = metrics(today, signalMinute)
    const sessionDates = [...grouped.keys()].filter(x => x < date).sort(), priorDates = sessionDates.slice(-10)
    const prior = priorDates.map(day => ({ date: day, metrics: metrics(grouped.get(day), signalMinute) })).filter(x => x.metrics)
    const entryIndex = today.findIndex(x => x.minute === signal.entryCandle), entry = today[entryIndex], later = today.slice(entryIndex + 1), eod = today.at(-1)
    if (!current || prior.length < 10 || !entry || !eod) continue
    const out = {
      date, symbol: signal.symbol, named: named.has(`${date}|${signal.symbol}`), signalTime: signal.signalKnownAt.slice(11, 16), entryTime: signal.entryKnownAt.slice(11, 16),
      score: signal.score, entryPrice: signal.entryPrice, openingReturnPct: round(current.returnPct), openingVolume: current.volume,
      openingRangePct: round(current.rangePct), closeLocationPct: round(current.closeLocationPct), greenPct: round(current.greenPct),
      efficiency: round(current.efficiency), closeVsVwapPct: round(current.closeVsVwapPct), depthMovePct: signal.depthMidpointMovePct,
      depthBidSharePct: signal.meanBidSharePct, depthImbalancePct: signal.depthLast2ImbalancePct,
      eodReturnPct: round(pct(eod.close, entry.close)), mfePct: round(Math.max(0, ...later.map(x => pct(x.high, entry.close)))),
      maePct: round(Math.min(0, ...later.map(x => pct(x.low, entry.close))))
    }
    for (const n of [1, 3, 5, 10]) {
      const sample = prior.slice(-n).map(x => x.metrics)
      out[`returnVsMax${n}Pct`] = round(current.returnPct - Math.max(...sample.map(x => x.returnPct)))
      out[`returnVsAvg${n}Pct`] = round(current.returnPct - mean(sample.map(x => x.returnPct)))
      out[`volumeRatio${n}`] = round(current.volume / mean(sample.map(x => x.volume)))
      out[`turnoverRatio${n}`] = round(current.turnover / mean(sample.map(x => x.turnover)))
      out[`rangeRatio${n}`] = round(current.rangePct / mean(sample.map(x => x.rangePct)))
      out[`beatReturnCount${n}`] = sample.filter(x => current.returnPct > x.returnPct).length
    }
    rows.push(out)
  }
}

for (const date of dates) {
  const sameDay = rows.filter(x => x.date === date)
  for (const row of sameDay) {
    row.returnRank = 1 + sameDay.filter(x => x.openingReturnPct > row.openingReturnPct).length
    row.volumeRatio10Rank = 1 + sameDay.filter(x => x.volumeRatio10 > row.volumeRatio10).length
    row.turnoverRatio10Rank = 1 + sameDay.filter(x => x.turnoverRatio10 > row.turnoverRatio10).length
    row.rangeRatio10Rank = 1 + sameDay.filter(x => x.rangeRatio10 > row.rangeRatio10).length
  }
}

const columns = Object.keys(rows[0] ?? {})
let suffix = 1, jsonFile, csvFile
do {
  const tail = suffix === 1 ? '' : `-${suffix}`
  jsonFile = path.join(root, 'reports', `2026-11-17-to-20-opening-prior-session-features${tail}.json`)
  csvFile = path.join(root, 'csv', `2026-11-17-to-20-opening-prior-session-features${tail}.csv`)
  suffix++
} while (fs.existsSync(jsonFile) || fs.existsSync(csvFile))
fs.writeFileSync(jsonFile, `${JSON.stringify({ dates, outcome: 'BUY return from next completed candle close to EOD; outcome fields are evaluation only', rows }, null, 2)}\n`, { flag: 'wx' })
fs.writeFileSync(csvFile, `${columns.join(',')}\n${rows.map(row => columns.map(key => escapeCsv(row[key])).join(',')).join('\n')}\n`, { flag: 'wx' })
console.log(JSON.stringify({ candidates: rows.length, namedAvailable: rows.filter(x => x.named).length, winnersOver2Pct: rows.filter(x => x.eodReturnPct > 2).length, jsonFile, csvFile }, null, 2))
