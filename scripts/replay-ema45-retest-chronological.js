import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2] ?? '2026-10-19'
const strictNear = process.argv.includes('--strict-near')
const sourceArgIndex = process.argv.indexOf('--source')
const source = sourceArgIndex >= 0 && process.argv[sourceArgIndex + 1]
  ? path.resolve(root, process.argv[sourceArgIndex + 1])
  : path.join(root, 'reports', `${date}-ema45-retest-${strictNear ? 'strict-near-' : ''}target-signals.json`)
if (!fs.existsSync(source)) throw new Error(`Missing candidate report: ${source}`)
const candidates = JSON.parse(fs.readFileSync(source, 'utf8')).signals
const IST = 330 * 60_000
const local = epoch => new Date(epoch * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const round = (x, places = 4) => Number(x.toFixed(places))

function readCandles(symbol) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const time = Number(row.time)
    if (!Number.isFinite(time) || local(time).slice(0, 10) > date) continue
    if (![row.open, row.high, row.low, row.close, row.volume].every(x => Number.isFinite(Number(x)))) continue
    unique.set(time, { time, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume })
  }
  return [...unique.values()].sort((a, b) => a.time - b.time)
}
function ema(candles, period) {
  const alpha = 2 / (period + 1)
  const result = [candles[0].close]
  for (let i = 1; i < candles.length; i++) result.push(alpha * candles[i].close + (1 - alpha) * result.at(-1))
  return result
}

const bySymbol = Map.groupBy(candidates, row => row.symbol)
const trades = []
const rejected = { signalBelowOrAtEMA20: 0, entryBelowOrAtEMA20: 0, overlappingPosition: 0, noNextCandle: 0 }
let topTenOriginalOverlap = 0
const legacyCandidates = JSON.parse(fs.readFileSync(path.join(root, 'reports', `${date}-ema45-retest-target-signals.json`), 'utf8')).signals
const originalTopTen = new Set([...legacyCandidates].sort((a, b) => b.returnPct - a.returnPct).slice(0, 10).map(x => `${x.symbol}|${x.entryTime}`))

for (const [symbol, events] of bySymbol) {
  const candles = readCandles(symbol)
  const ema10 = ema(candles, 10), ema20 = ema(candles, 20)
  const indexByTime = new Map(candles.map((row, i) => [local(row.time), i]))
  let occupiedThrough = -1
  for (const signal of events.sort((a, b) => (a.signalTime ?? a.entryTime).localeCompare(b.signalTime ?? b.entryTime))) {
    const signalTime = signal.signalTime ?? signal.entryTime
    const signalIndex = indexByTime.get(signalTime)
    if (signalIndex === undefined) continue
    if (signalIndex <= occupiedThrough) { rejected.overlappingPosition++; continue }
    if (ema10[signalIndex] <= ema20[signalIndex]) { rejected.signalBelowOrAtEMA20++; continue }
    const entryIndex = signalIndex + 1
    if (entryIndex >= candles.length || local(candles[entryIndex].time).slice(0, 10) !== date || candles[entryIndex].time - candles[signalIndex].time !== 60) { rejected.noNextCandle++; continue }
    if (ema10[entryIndex] <= ema20[entryIndex]) { rejected.entryBelowOrAtEMA20++; continue }
    let crossIndex = -1
    for (let i = entryIndex + 1; i < candles.length; i++) {
      if (local(candles[i].time).slice(0, 10) !== date) break
      if (ema10[i - 1] >= ema20[i - 1] && ema10[i] < ema20[i]) { crossIndex = i; break }
    }
    let exitIndex = crossIndex + 1
    const executableCross = crossIndex >= 0 && exitIndex < candles.length && local(candles[exitIndex].time).slice(0, 10) === date && candles[exitIndex].time - candles[crossIndex].time === 60
    if (!executableCross) exitIndex = candles.findLastIndex(row => local(row.time).slice(0, 10) === date)
    const entry = candles[entryIndex], exit = candles[exitIndex]
    const maeLow = Math.min(entry.close, ...candles.slice(entryIndex + 1, exitIndex + 1).map(row => row.low))
    const trade = {
      symbol, signalTimeIST: signalTime, entryTimeIST: local(entry.time), entryPrice: entry.close,
      ema45: signal.ema45, ema45Rise3mPct: signal.ema45Rise3mPct, depth: signal.depth,
      crossTimeIST: crossIndex >= 0 ? local(candles[crossIndex].time) : null,
      exitTimeIST: local(exit.time), exitPrice: exit.close,
      exitReason: executableCross ? 'EMA10 crossed below EMA20; next candle close' : 'end-of-day mark; no executable cross',
      returnPct: round(100 * (exit.close / entry.close - 1)), maximumAdverseExcursionPct: round(100 * (maeLow / entry.close - 1))
    }
    trades.push(trade)
    if (originalTopTen.has(`${symbol}|${signalTime}`)) topTenOriginalOverlap++
    occupiedThrough = exitIndex
  }
}

trades.sort((a, b) => a.signalTimeIST.localeCompare(b.signalTimeIST) || a.symbol.localeCompare(b.symbol))
const realized = trades.filter(row => row.exitReason.startsWith('EMA10'))
const returns = realized.map(row => row.returnPct)
const summary = {
  date, strictNear, rawCandidateRows: candidates.length, symbolsWithCandidates: bySymbol.size,
  tradeCount: trades.length, completedCrossExitTrades: realized.length,
  endOfDayMarkedTrades: trades.length - realized.length, originalTopTenRetained: topTenOriginalOverlap,
  rejected,
  realizedWinRatePct: realized.length ? round(100 * returns.filter(x => x > 0).length / realized.length) : null,
  realizedAverageReturnPct: realized.length ? round(returns.reduce((a, b) => a + b, 0) / realized.length) : null,
  realizedTotalReturnPct: round(returns.reduce((a, b) => a + b, 0)),
  maximumAdverseExcursionPct: trades.length ? Math.min(...trades.map(row => row.maximumAdverseExcursionPct)) : null,
  worstDay: realized.length ? { date, totalReturnPct: round(returns.reduce((a, b) => a + b, 0)) } : null
}
const report = { summary, execution: 'Signal at completed candle and depth minute; entry at next completed candle close; cross exit at next completed candle close; one active trade per stock.', trades }
let n = 1, output
do { output = path.join(root, 'reports', `${date}-ema45-retest-${strictNear ? 'strict-near-' : ''}chronological-replay${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(output))
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(summary, null, 2))
console.log(`JSON: ${output}`)
