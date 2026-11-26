import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = process.argv[2] ?? '2026-10-19'
const strictNear = process.argv[3] === '--strict-near'
const replayFile = path.join(root, 'reports', `${date}-ema45-retest-${strictNear ? 'strict-near-' : ''}chronological-replay.json`)
const trades = JSON.parse(fs.readFileSync(replayFile, 'utf8')).trades
const IST = 330 * 60_000
const local = t => new Date(t * 1000 + IST).toISOString().slice(0, 16).replace('T', ' ')
const mean = a => a.reduce((x, y) => x + y, 0) / a.length
const round = (x, p = 4) => Number(x.toFixed(p))

function candles(symbol) {
  const unique = new Map()
  for (const line of fs.readFileSync(path.join(root, 'db/candles', `${symbol}.jsonl`), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    const time = Number(r.time)
    if (!Number.isFinite(time) || local(time).slice(0, 10) > date) continue
    unique.set(time, { time, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume })
  }
  return [...unique.values()].sort((a, b) => a.time - b.time)
}
const features = []
for (const symbol of new Set(trades.map(t => t.symbol))) {
  const a = candles(symbol), index = new Map(a.map((r, i) => [local(r.time), i]))
  for (const t of trades.filter(x => x.symbol === symbol)) {
    const i = index.get(t.signalTimeIST); if (i === undefined || i < 20) continue
    const current = a[i], prev = a[i - 1], five = a.slice(i - 4, i + 1), prior20 = a.slice(i - 20, i)
    const volume20 = mean(prior20.map(x => x.volume))
    const range20 = mean(prior20.map(x => x.high - x.low))
    features.push({ ...t,
      closeVsEma45Pct: round(100 * (current.close / t.ema45 - 1)),
      threeMinuteReturnPct: round(100 * (current.close / a[i - 3].close - 1)),
      fiveMinuteReturnPct: round(100 * (current.close / a[i - 5].close - 1)),
      twentyMinuteReturnPct: round(100 * (current.close / a[i - 20].close - 1)),
      signalBodyPct: round(100 * (current.close / current.open - 1)),
      closeInCandlePct: round(100 * (current.close - current.low) / Math.max(current.high - current.low, 0.0001)),
      signalVolumeRatio20: round(current.volume / Math.max(volume20, 1)),
      fiveMinuteVolumeRatio20: round(mean(five.map(x => x.volume)) / Math.max(volume20, 1)),
      rangeRatio20: round((current.high - current.low) / Math.max(range20, 0.0001)),
      priorCandleReturnPct: round(100 * (prev.close / prev.open - 1)),
      signalMinute: Number(t.signalTimeIST.slice(11, 13)) * 60 + Number(t.signalTimeIST.slice(14, 16))
    })
  }
}

const ruleDefinitions = [
  ['all replay trades', () => true],
  ['EMA45 rise 3m >= 0.01%', x => x.ema45Rise3mPct >= 0.01],
  ['EMA45 rise 3m >= 0.02%', x => x.ema45Rise3mPct >= 0.02],
  ['depth midpoint move >= 0.10%', x => x.depth.midpointMovePct >= 0.10],
  ['bid share >= 60%', x => x.depth.avgBidSharePct >= 60],
  ['candle closes upper half', x => x.closeInCandlePct >= 50],
  ['signal volume >= 20m mean', x => x.signalVolumeRatio20 >= 1],
  ['5m price change positive', x => x.fiveMinuteReturnPct > 0],
  ['20m price change positive', x => x.twentyMinuteReturnPct > 0],
  ['EMA rise and bid share', x => x.ema45Rise3mPct >= 0.01 && x.depth.avgBidSharePct >= 60],
  ['EMA rise and midpoint', x => x.ema45Rise3mPct >= 0.01 && x.depth.midpointMovePct >= 0.10],
  ['positive 5m price and midpoint', x => x.fiveMinuteReturnPct > 0 && x.depth.midpointMovePct >= 0.10],
  ['EMA rise, bid share, 5m price', x => x.ema45Rise3mPct >= 0.01 && x.depth.avgBidSharePct >= 60 && x.fiveMinuteReturnPct > 0],
  ['EMA rise, bid share, midpoint', x => x.ema45Rise3mPct >= 0.01 && x.depth.avgBidSharePct >= 60 && x.depth.midpointMovePct >= 0.10],
  ['EMA rise, 5m price, midpoint', x => x.ema45Rise3mPct >= 0.01 && x.fiveMinuteReturnPct > 0 && x.depth.midpointMovePct >= 0.10]
]
const ruleResults = ruleDefinitions.map(([name, rule]) => {
  const matches = features.filter(rule), returns = matches.map(x => x.returnPct)
  return { name, tradeCount: matches.length, winRatePct: matches.length ? round(100 * returns.filter(x => x > 0).length / matches.length) : null, averageReturnPct: matches.length ? round(mean(returns)) : null, totalReturnPct: round(returns.reduce((a, b) => a + b, 0)), maxAdverseExcursionPct: matches.length ? Math.min(...matches.map(x => x.maximumAdverseExcursionPct)) : null }
})
const originalTopTen = new Set(JSON.parse(fs.readFileSync(path.join(root, 'reports', `${date}-ema45-retest-target-signals.json`), 'utf8')).signals.sort((a, b) => b.returnPct - a.returnPct).slice(0, 10).map(x => `${x.symbol}|${x.entryTime}`))
for (let i = 0; i < ruleResults.length; i++) ruleResults[i].originalTopTenRetained = features.filter(ruleDefinitions[i][1]).filter(x => originalTopTen.has(`${x.symbol}|${x.signalTimeIST}`)).length
const output = { date, strictNear, note: 'Exploratory same-day filter comparison. All filters use signal-time features. Returns use next completed candle entry and actual later EMA10/EMA20 down cross.', featuresCount: features.length, rules: ruleResults, features }
let n = 1, file
do { file = path.join(root, 'reports', `${date}-ema45-retest-${strictNear ? 'strict-near-' : ''}quality-study${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(ruleResults, null, 2))
console.log(`JSON: ${file}`)
