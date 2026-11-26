import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), minuteMs = 60_000
const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) => value.startsWith('--') ? [[value.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] == null ? true : all[index + 1]]] : []))
const date = args.date ?? '2026-11-20', until = args.until ?? '09:30'
const requireNegativeDayReturn = args['negative-day-return'] === true || args['negative-day-return'] === 'true'
const [endHour, endMinute] = until.split(':').map(Number)
if (!/^\d{2}:\d{2}$/.test(until) || !Number.isInteger(endHour) || !Number.isInteger(endMinute) || until <= '09:17' || until > '15:30') throw new Error('Use --until HH:MM after 09:17 and no later than 15:30.')
const start = Date.parse(`${date}T09:15:00+05:30`), end = Date.parse(`${date}T${until}:00+05:30`)
const clock = at => new Date(at + 330 * minuteMs).toISOString().slice(11, 16)
const local = time => new Date(time * 1000 + 330 * minuteMs).toISOString().slice(0, 16).replace('T', ' ')
const pct = (to, from) => from ? 100 * (to / from - 1) : null
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const read = file => !fs.existsSync(file) ? [] : fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] } })
const sectors = JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks_sector_wise'), 'utf8'))
const universe = [...new Set(Object.entries(sectors).flatMap(([key, values]) => key === '_meta' || !Array.isArray(values) ? [] : values))].sort()

function depthSnapshots(symbol) {
  const fields = {}, out = []
  let previous = null
  for (const event of read(path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`))) {
    const at = Date.parse(event.receivedAt)
    if (!Number.isFinite(at) || at < start || at >= end) continue
    if (event.kind === 'checkpoint') for (const key of Object.keys(fields)) delete fields[key]
    for (const [key, value] of Object.entries(event.data ?? {})) fields[key] = value
    const bp = +fields.bid_price1, ap = +fields.ask_price1
    const bids = Array.from({ length: 5 }, (_, i) => +fields[`bid_size${i + 1}`]), asks = Array.from({ length: 5 }, (_, i) => +fields[`ask_size${i + 1}`])
    if (![bp, ap, ...bids, ...asks].every(Number.isFinite) || bp <= 0 || ap <= bp) continue
    const bidTotal = bids.reduce((sum, value) => sum + value, 0), askTotal = asks.reduce((sum, value) => sum + value, 0), mid = (bp + ap) / 2
    const ofi = previous && at - previous.at <= 90_000 ? (bp >= previous.bp ? bids[0] : 0) - (bp <= previous.bp ? previous.bid1 : 0) - (ap <= previous.ap ? asks[0] : 0) + (ap >= previous.ap ? previous.ask1 : 0) : 0
    out.push({ at, minute: clock(at), bp, ap, mid, bid1: bids[0], bidTotal, askTotal, spreadBps: 10_000 * (ap - bp) / mid, ofi })
    previous = { at, bp, ap, bid1: bids[0], ask1: asks[0] }
  }
  return out
}

function depthScore(items) {
  if (items.length < 2) return null
  const first = items[0], last = items.at(-1), maxMid = Math.max(...items.map(x => x.mid))
  const grouped = Map.groupBy(items, x => x.minute)
  const minutes = [...grouped.keys()].sort().map(minute => {
    const rows = grouped.get(minute)
    return { minute, mid: rows.reduce((sum, x) => sum + x.mid, 0) / rows.length, bid: rows.reduce((sum, x) => sum + x.bidTotal, 0) / rows.length, ask: rows.reduce((sum, x) => sum + x.askTotal, 0) / rows.length }
  })
  const bidUp = items.slice(1).filter((x, index) => x.bp > items[index].bp).length, bidDown = items.slice(1).filter((x, index) => x.bp < items[index].bp).length
  const askUp = items.slice(1).filter((x, index) => x.ap > items[index].ap).length, askDown = items.slice(1).filter((x, index) => x.ap < items[index].ap).length
  const minBidRatio = Math.min(...minutes.map(x => x.bid)) / minutes[0].bid, maxAskRatio = Math.max(...minutes.map(x => x.ask)) / minutes[0].ask
  const spreads = items.map(x => x.spreadBps).sort((a, b) => a - b), p90 = spreads[Math.floor((spreads.length - 1) * .9)]
  const totalOfi = items.reduce((sum, x) => sum + x.ofi, 0)
  const checks = {
    midpointStairStepHigher: last.mid > first.mid && minutes.every((x, index) => !index || x.mid >= minutes[index - 1].mid),
    bestBidStepsHigher: last.bp > first.bp && bidUp > bidDown,
    bidRefillsAtHigherLevels: last.bid1 >= first.bid1 * .7 && minBidRatio >= .7,
    offersAbsorbed: items.filter(x => x.ofi > 0).length > items.filter(x => x.ofi < 0).length,
    noPersistentAskWall: maxAskRatio <= 1.5,
    asksRetreatUpward: last.ap >= first.ap && askUp >= askDown,
    topFiveBidSupportStable: minBidRatio >= .7,
    positiveOrderFlowImbalance: totalOfi > 0,
    spreadOrderly: last.spreadBps <= first.spreadBps * 1.25 && p90 <= first.spreadBps * 1.5,
    noAdverseDepthReversal: 10_000 * (last.mid / maxMid - 1) >= -5
  }
  return { score: Object.values(checks).filter(Boolean).length, midpointMovePct: pct(last.mid, first.mid), ofi: totalOfi }
}

function candleWindows(symbol) {
  const rows = read(path.join(root, 'db', 'candles', `${symbol}.jsonl`)).flatMap(row => {
    const stamp = local(row.time)
    return [{ date: stamp.slice(0, 10), minute: stamp.slice(11, 16), open: +row.open, close: +row.close }]
  })
  const days = [...new Set(rows.map(x => x.date))].filter(day => day <= date).sort()
  const previousDate = days.filter(day => day < date).at(-1)
  const previousClose = previousDate ? rows.filter(row => row.date === previousDate && row.minute >= '09:15' && row.minute <= '15:29').at(-1)?.close : null
  const feature = (day, through) => {
    const bars = rows.filter(row => row.date === day && row.minute >= '09:15' && row.minute <= through)
    if (!bars.length) return null
    return { returnPct: pct(bars.at(-1).close, bars[0].open), dayReturnPct: pct(bars.at(-1).close, previousClose), greenPct: 100 * bars.filter(row => row.close > row.open).length / bars.length, candles: bars.length }
  }
  return { days, feature, previousClose }
}

const signals = [], diagnostics = []
for (const symbol of universe) {
  const depth = depthSnapshots(symbol), candles = candleWindows(symbol)
  const series = []
  for (let at = start; at < end; at += minuteMs) {
    const through = clock(at), cutoff = at + minuteMs
    const depthResult = depthScore(depth.filter(row => row.at < cutoff))
    const current = candles.feature(date, through)
    const prior = candles.days.filter(day => day < date).slice(-10).map(day => candles.feature(day, through)).filter(Boolean)
    if (!depthResult || !current || prior.length !== 10) continue
    const returnRank = 1 + prior.filter(row => row.returnPct > current.returnPct).length
    series.push({ through, depthScore: depthResult.score, returnRank, greenPct: current.greenPct, candles: current.candles, returnPct: current.returnPct, dayReturnPct: current.dayReturnPct, midpointMovePct: depthResult.midpointMovePct, ofi: depthResult.ofi })
  }
  diagnostics.push({ symbol, series })
  for (let index = 2; index < series.length; index++) {
    const run = series.slice(index - 2, index + 1)
    const last = run.at(-1)
    const returnGate = requireNegativeDayReturn ? last.dayReturnPct < 0 : last.returnRank <= 2
    if (run.every(row => row.depthScore >= 8) && returnGate && last.greenPct > 70) {
      signals.push({ symbol, signalCandle: last.through, signalKnownAt: clock(Date.parse(`${date}T${last.through}:00+05:30`) + minuteMs), depthScores: run.map(row => row.depthScore), returnRank: last.returnRank, returnPct: round(last.returnPct), dayReturnIncludingGapPct: round(last.dayReturnPct), greenPct: round(last.greenPct), candles: last.candles, midpointMovePct: round(last.midpointMovePct), ofi: round(last.ofi) })
      break
    }
  }
}
signals.sort((a, b) => a.signalKnownAt.localeCompare(b.signalKnownAt) || a.symbol.localeCompare(b.symbol))
const report = {
  date, windowIST: `09:15 through completed ${clock(end - minuteMs)} candle`,
  rules: requireNegativeDayReturn ? 'First signal per stock. Three consecutive cumulative minute depth scores >=8/10; current close below prior session close (negative day return including gap); >70% completed opening candles green. Signal becomes known at the end of the labeled signal candle.' : 'First signal per stock. Three consecutive cumulative minute depth scores >=8/10; current same-window return rank <=2 against prior ten sessions; >70% completed opening candles green. Signal becomes known at the end of the labeled signal candle.',
  universeCount: universe.length, signalCount: signals.length, signals, diagnostics
}
let suffix = 1, file
const mode = requireNegativeDayReturn ? 'negative-day-return' : 'return-rank'
do { file = path.join(root, 'reports', `${date}-0915-${clock(end - minuteMs).replace(':', '')}-depth-${mode}-signals${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
console.log(`Scanned ${universe.length} stocks; found ${signals.length} signals.`)
console.table(signals.map(row => ({ Stock: row.symbol, 'Signal known': row.signalKnownAt, 'Depth run': row.depthScores.join('/'), 'Return rank': `${row.returnRank}/11`, 'Open return %': row.returnPct, 'Day return incl. gap %': row.dayReturnIncludingGapPct ?? '-', 'Green %': row.greenPct, Candles: row.candles, 'Depth midpoint %': row.midpointMovePct })))
console.log(`Report: ${file}`)
