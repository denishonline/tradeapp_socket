import fs from 'node:fs'
import path from 'node:path'

// Explicitly requested 2026-10-22/23 candidate cohort, outside the usual AGENTS.md dates.
const root = process.cwd(), dates = ['2026-10-22', '2026-10-23']
const ist = t => new Date(t * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const clock = t => ist(t).slice(11), day = t => ist(t).slice(0, 10)
const pct = (a, b) => 100 * (a / b - 1), round = x => Number.isFinite(x) ? Number(x.toFixed(4)) : null
const epoch = (d, c) => Date.parse(`${d}T${c}:00+05:30`) / 1000
const readRows = file => fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line)] } catch { return [] }
})
const cohort = new Map(dates.map(d => [d, new Set(fs.readFileSync(path.join(root, 'reports', `opening-weakness-rules-${d}.csv`), 'utf8').trim().split(/\r?\n/).slice(1).map(x => x.split(',')[1]).filter(Boolean))]))
const loadCandles = (symbol, date) => readRows(path.join(root, 'db', 'candles', `${symbol}.jsonl`))
  .filter(r => day(r.time) === date && clock(r.time) >= '09:15' && clock(r.time) < '15:00' && [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite))
  .sort((a, b) => a.time - b.time)

function depthAtMinutes(symbol, date) {
  const file = path.join(root, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return new Map()
  const state = {}, minute = new Map()
  for (const e of readRows(file)) {
    const received = Date.parse(e.receivedAt) / 1000
    if (!Number.isFinite(received) || received >= epoch(date, '10:00')) break
    if (e.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, e.data ?? {})
    let bid = 0, ask = 0, ok = true
    for (let i = 1; i <= 5; i++) {
      const bp = Number(state[`bid_price${i}`]), ap = Number(state[`ask_price${i}`]), bs = Number(state[`bid_size${i}`]), as = Number(state[`ask_size${i}`])
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) { ok = false; break }
      bid += bs; ask += as
    }
    if (ok && bid + ask > 0) minute.set(Math.floor(received / 60) * 60, { at: received, bidShare: bid / (bid + ask), midpoint: (Number(state.bid_price1) + Number(state.ask_price1)) / 2 })
  }
  return minute
}

function exitTrade(rows, entryIndex, side) {
  const entry = rows[entryIndex], dir = side === 'BUY' ? 1 : -1, stop = entry.close * (1 - dir * .005), target = entry.close * (1 + dir * .01)
  let mae = 0, exit = null
  for (let i = entryIndex + 1; i < rows.length; i++) {
    const r = rows[i]
    if (r.time !== rows[i - 1].time + 60) { exit = { reason: 'GAP', exitPrice: rows[i - 1].close, exitAt: ist(rows[i - 1].time + 60) }; break }
    const adverse = dir > 0 ? pct(r.low, entry.close) : -pct(r.high, entry.close)
    mae = Math.min(mae, adverse)
    const gapStop = dir > 0 ? r.open <= stop : r.open >= stop
    const stopHit = dir > 0 ? r.low <= stop : r.high >= stop
    const targetHit = dir > 0 ? r.high >= target : r.low <= target
    if (gapStop || stopHit) { exit = { reason: 'SL', exitPrice: gapStop ? r.open : stop, exitAt: ist(r.time + 60), sameBarBoth: targetHit }; break }
    if (targetHit) { exit = { reason: 'TARGET', exitPrice: target, exitAt: ist(r.time + 60) }; break }
    if (clock(r.time + 60) === '15:00') { exit = { reason: '15:00', exitPrice: r.close, exitAt: ist(r.time + 60) }; break }
  }
  if (!exit) { const r = rows.at(-1); exit = { reason: 'DATA_END', exitPrice: r.close, exitAt: ist(r.time + 60) } }
  return { entryAt: ist(entry.time + 60), entryPrice: round(entry.close), stopPrice: round(stop), targetPrice: round(target), ...exit,
    exitPrice: round(exit.exitPrice), returnPct: round(dir * pct(exit.exitPrice, entry.close)), maxAdverseExcursionPct: round(mae) }
}

const nifty = new Map(dates.map(d => [d, new Map(loadCandles('NIFTY50', d).map(r => [r.time, r]))]))
const all = [], audit = { cohort: Object.fromEntries(dates.map(d => [d, cohort.get(d).size])), missingCandles: [], missingDepth: [], candidateCount: 0 }
for (const date of dates) for (const symbol of cohort.get(date)) {
  const rows = loadCandles(symbol, date)
  if (!rows.length) { audit.missingCandles.push(`${date}:${symbol}`); continue }
  const book = depthAtMinutes(symbol, date)
  if (!book.size) audit.missingDepth.push(`${date}:${symbol}`)
  let ema5 = null, ema10 = null, ema20 = null, pv = 0, volume = 0, rsiGain = 0, rsiLoss = 0
  for (let j = 0; j < rows.length; j++) {
    const r = rows[j]
    ema5 = ema5 == null ? r.close : ema5 + (r.close - ema5) / 3
    ema10 = ema10 == null ? r.close : ema10 + 2 / 11 * (r.close - ema10)
    ema20 = ema20 == null ? r.close : ema20 + 2 / 21 * (r.close - ema20)
    pv += (r.high + r.low + r.close) / 3 * r.volume; volume += r.volume
    if (j) {
      const diff = r.close - rows[j - 1].close, gain = Math.max(diff, 0), loss = Math.max(-diff, 0)
      if (j <= 14) { rsiGain += gain; rsiLoss += loss; if (j === 14) { rsiGain /= 14; rsiLoss /= 14 } }
      else { rsiGain = (13 * rsiGain + gain) / 14; rsiLoss = (13 * rsiLoss + loss) / 14 }
    }
    r.ema5 = ema5; r.ema10 = ema10; r.ema20 = ema20; r.vwap = pv / (volume || 1)
    r.rsi14 = j < 14 ? null : rsiLoss ? 100 - 100 / (1 + rsiGain / rsiLoss) : 100
  }
  const firstIndex = rows.findIndex(r => clock(r.time + 60) === '09:30')
  if (firstIndex < 0) continue
  const openingClose = rows[firstIndex].close
  for (let i = firstIndex; i < rows.length; i++) {
    const r = rows[i], at = r.time + 60, hhmm = clock(at)
    if (hhmm >= '10:00') break
    if (i < 4 || !rows[i + 1] || rows[i + 1].time !== r.time + 60 || rows[i - 1].time !== r.time - 60) continue
    const latest = book.get(r.time), prior = book.get(r.time - 60)
    if (!latest || !prior || latest.at > at || prior.at > r.time || at - latest.at > 90 || r.time - prior.at > 90) continue
    const n = nifty.get(date).get(r.time), nPrior = nifty.get(date).get(r.time - 180)
    if (!n || !nPrior) continue
    const two = pct(r.close, rows[i - 1].open), five = pct(r.close, rows[i - 4].open), n3 = pct(n.close, nPrior.close)
    const fiveRows = rows.slice(i - 4, i + 1), green = fiveRows.filter(x => x.close > x.open).length
    const bid = (latest.bidShare + prior.bidShare) / 2, mid = pct(latest.midpoint, prior.midpoint)
    const completed5m = rows.slice(0, i + 1).filter(x => {
      const c = clock(x.time), minute = Number(c.slice(0, 2)) * 60 + Number(c.slice(3))
      return (minute - 555) % 5 === 4
    })
    const prior5m = completed5m.at(-2), last5m = completed5m.at(-1)
    const priorVolume = rows.slice(Math.max(0, i - 9), i - 4).reduce((s, x) => s + x.volume, 0)
    const recentVolume = fiveRows.reduce((s, x) => s + x.volume, 0)
    for (const side of ['SELL', 'BUY']) {
      const dir = side === 'BUY' ? 1 : -1
      const twoDirectional = dir * two, fiveDirectional = dir * five, niftyDirectional = dir * n3, depthShare = side === 'BUY' ? bid : 1 - bid, depthMidMove = dir * mid
      if (twoDirectional < .15 || dir * (r.close - r.ema5) <= 0 || dir * (r.ema5 - rows[i - 1].ema5) <= 0) continue
      const trade = exitTrade(rows, i + 1, side)
      all.push({ date, symbol, side, type: side === 'SELL' ? 'SELL_CONTINUATION' : 'BUY_REVERSAL', signalAt: ist(at),
        twoDirectionalPct: round(twoDirectional), fiveDirectionalPct: round(fiveDirectional),
        directionalCandles5: side === 'BUY' ? green : fiveRows.length - green,
        depthSharePct: round(depthShare * 100), depthMidMovePct: round(depthMidMove), nifty3DirectionalPct: round(niftyDirectional),
        ema10Vs20DirectionalPct: round(dir * pct(r.ema10, r.ema20)), priceVsVwapDirectionalPct: round(dir * pct(r.close, r.vwap)),
        rsi14Directional: round(side === 'BUY' ? r.rsi14 : 100 - r.rsi14),
        completed5mDirectionalPct: last5m && prior5m ? round(dir * pct(last5m.close, prior5m.close)) : null,
        recentVolumeRatio: priorVolume > 0 ? round(recentVolume / priorVolume) : null,
        versus0930Pct: round(dir * pct(r.close, openingClose)), ...trade })
    }
  }
}
audit.candidateCount = all.length
const variants = [
  { name: 'momentum', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 },
  { name: 'depth52', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 },
  { name: 'depth55_nifty', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 55 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 },
  { name: 'depth52_nifty', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 },
  { name: 'depth55_nifty_strong', pass: x => x.directionalCandles5 >= 4 && x.fiveDirectionalPct >= .4 && x.depthSharePct >= 55 && x.depthMidMovePct > .02 && x.nifty3DirectionalPct > 0 },
  { name: 'depth52_nifty_vwap', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.priceVsVwapDirectionalPct > 0 },
  { name: 'depth52_nifty_ema10_20', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.ema10Vs20DirectionalPct > 0 },
  { name: 'depth52_nifty_5m', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.completed5mDirectionalPct > 0 },
  { name: 'depth52_nifty_volume', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.recentVolumeRatio >= 1 },
  { name: 'depth52_nifty_rsi', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.rsi14Directional > 50 },
  { name: 'depth52_nifty_vwap_5m', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.priceVsVwapDirectionalPct > 0 && x.completed5mDirectionalPct > 0 },
  { name: 'depth52_nifty_5m_rsi', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.completed5mDirectionalPct > 0 && x.rsi14Directional > 50 },
  { name: 'depth52_nifty_5m_volume', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.completed5mDirectionalPct > 0 && x.recentVolumeRatio >= 1 },
  { name: 'depth52_nifty_5m_rsi_volume', pass: x => x.directionalCandles5 >= 3 && x.fiveDirectionalPct >= .25 && x.depthSharePct >= 52 && x.depthMidMovePct > 0 && x.nifty3DirectionalPct > 0 && x.completed5mDirectionalPct > 0 && x.rsi14Directional > 50 && x.recentVolumeRatio >= 1 },
]
function select(rows, test) {
  const picked = new Map()
  for (const x of rows) {
    if (!test(x)) continue
    const key = `${x.date}|${x.symbol}`
    if (!picked.has(key)) picked.set(key, x)
  }
  return [...picked.values()].sort((a, b) => a.signalAt.localeCompare(b.signalAt) || a.symbol.localeCompare(b.symbol))
}
const stats = rows => {
  const total = rows.reduce((sum, x) => sum + x.returnPct, 0)
  const days = dates.map(d => ({ date: d, tradeCount: rows.filter(x => x.date === d).length, totalReturnPct: round(rows.filter(x => x.date === d).reduce((sum, x) => sum + x.returnPct, 0)) })).filter(x => x.tradeCount)
  return { tradeCount: rows.length, wins: rows.filter(x => x.returnPct >= 1).length, winRatePct: round(100 * rows.filter(x => x.returnPct >= 1).length / (rows.length || 1)), averageReturnPct: round(total / (rows.length || 1)), totalReturnPct: round(total), maximumAdverseExcursionPct: rows.length ? round(Math.min(...rows.map(x => x.maxAdverseExcursionPct))) : null, worstDay: days.length ? days.reduce((a, b) => a.totalReturnPct <= b.totalReturnPct ? a : b) : null, days }
}
const evaluations = variants.map(v => ({ name: v.name, train: stats(select(all.filter(x => x.date === dates[0]), v.pass)), holdout: stats(select(all.filter(x => x.date === dates[1]), v.pass)), combined: stats(select(all, v.pass)), trades: select(all, v.pass) }))
const selectedVariant = evaluations.filter(v => v.train.tradeCount >= 10 && v.holdout.tradeCount >= 10 && v.train.totalReturnPct > 0 && v.holdout.totalReturnPct > 0)
  .sort((a, b) => b.combined.averageReturnPct - a.combined.averageReturnPct)[0]
const selectedRules = {
  candidate: 'Provided stock lists known at 09:30; first qualifying signal per stock from 09:30 through 09:59 IST',
  signal: 'Two-minute directional move >=0.15%, five-minute directional move >=0.25%, at least three of last five 1m candles in trade direction, EMA5 rising for BUY/falling for SELL and close on trade side of EMA5',
  confirmation: 'Two latest completed-minute five-level book snapshots: directional displayed size share >=52% and midpoint moving in trade direction; NIFTY50 3m completed-candle move in trade direction >0; previous completed 5m close moves in trade direction; 1m RSI14 >50 BUY or <50 SELL',
  entry: 'Close of next completed 1m candle',
  stop: '0.5% from entry, gap through stop filled at candle open',
  exit: '+1% target before stop, else 15:00 IST close; stop priority if both touch within same 1m bar',
  accounting: 'Gross equal-trade percentage sum, no costs or capital constraints'
}
const output = { method: 'User supplied 09:30 stocks on 22/23 Oct. NIFTY and depth are known by signal time. One trade per stock. Final variant chosen by combined average return among variants with >=10 trades and positive totals on each day; both days inform selection, so neither is a pristine holdout.', audit, selectedVariant: selectedVariant?.name ?? null, selectedRules, evaluations, candidates: all }
let file = path.join(root, 'reports', '2026-10-22-23-0930-weakness-bidirectional-research.json'), n = 2
while (fs.existsSync(file)) file = path.join(root, 'reports', `2026-10-22-23-0930-weakness-bidirectional-research-${n++}.json`)
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' })
const columns = ['date', 'symbol', 'side', 'type', 'signalAt', 'entryAt', 'entryPrice', 'stopPrice', 'targetPrice', 'exitAt', 'exitPrice', 'reason', 'returnPct', 'maxAdverseExcursionPct', 'depthSharePct', 'depthMidMovePct', 'nifty3DirectionalPct', 'completed5mDirectionalPct', 'rsi14Directional']
let csv = path.join(root, 'reports', '2026-10-22-23-0930-weakness-bidirectional-signals.csv'), csvN = 2
while (fs.existsSync(csv)) csv = path.join(root, 'reports', `2026-10-22-23-0930-weakness-bidirectional-signals-${csvN++}.csv`)
const csvRow = r => columns.map(k => r[k] == null ? '' : String(r[k])).join(',')
fs.writeFileSync(csv, `${columns.join(',')}\n${selectedVariant.trades.map(csvRow).join('\n')}\n`, { flag: 'wx' })
let realized = path.join(root, 'reports', '2026-10-22-23-0930-weakness-realized-1pct-targets.csv'), realizedN = 2
while (fs.existsSync(realized)) realized = path.join(root, 'reports', `2026-10-22-23-0930-weakness-realized-1pct-targets-${realizedN++}.csv`)
fs.writeFileSync(realized, `${columns.join(',')}\n${selectedVariant.trades.filter(t => t.reason === 'TARGET').map(csvRow).join('\n')}\n`, { flag: 'wx' })
console.log(JSON.stringify({ file, csv, realizedTargetCsv: realized, audit, selectedVariant: selectedVariant.name, selectedRules, firstDay: selectedVariant.train, secondDay: selectedVariant.holdout, combined: selectedVariant.combined, sides: ['BUY', 'SELL'].map(side => ({ side, ...stats(selectedVariant.trades.filter(t => t.side === side)) })) }, null, 2))
