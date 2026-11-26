import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), minuteMs = 60_000
const parseArgs = argv => { const out = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const [key, inline] = argv[i].slice(2).split('=', 2); out[key] = inline ?? argv[++i] } return out }
const args = parseArgs(process.argv.slice(2))
const ist = at => new Date(at + 330 * minuteMs).toISOString()
const input = args['cutoff-datetime']
const cutoffAt = input
  ? Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(String(input)) ? input : `${input}+05:30`)
  : Date.parse(`${args.date ?? ist(Date.now()).slice(0, 10)}T09:20:00+05:30`)
if (!Number.isFinite(cutoffAt)) throw new Error('Usage: node scripts/scan-opening-five-candle-baseline.js --cutoff-datetime YYYY-MM-DDTHH:mm [--symbols "NSE:AAA-EQ,..."] [--require-group]')
const date = ist(cutoffAt).slice(0, 10), cutoffTime = ist(cutoffAt).slice(11, 16)
const startAt = Date.parse(`${date}T09:15:00+05:30`), endAt = cutoffAt
if (endAt <= startAt) throw new Error('Cutoff must be after 09:15 IST.')
const windowMinutes = Math.round((endAt - startAt) / minuteMs)
const depthRoot = path.join(root, 'db', 'cash-depth', date)
if (!fs.existsSync(depthRoot)) throw new Error(`Missing depth directory: ${depthRoot}`)
const clock = at => new Date(at + 330 * minuteMs).toISOString().slice(11, 16)
const day = at => new Date(at + 330 * minuteMs).toISOString().slice(0, 10)
const pct = (to, from) => 100 * (to / from - 1)
const round = (value, digits = 2) => Number(value.toFixed(digits))
const normalize = value => String(value).replace(/\s+/g, '').replace(/^NSE:/i, '').replace(/-EQ$/i, '').replace(/^TVSMOTORS$/i, 'TVSMOTOR').toUpperCase()
const explicitSymbols = Boolean(args.symbols)
const symbols = explicitSymbols ? [...new Set(String(args.symbols).split(',').map(normalize).filter(Boolean))] : fs.readdirSync(depthRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => normalize(entry.name)).sort()

function candles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) throw new Error('candle file missing')
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap(line => { try { const row = JSON.parse(line), at = +row.time * 1000; return [{ at, day: day(at), minute: clock(at), open: +row.open, high: +row.high, low: +row.low, close: +row.close }] } catch { return [] } }).sort((a, b) => a.at - b.at)
}

function openingFeature(rows, sessionDate) {
  const sessionStart = Date.parse(`${sessionDate}T09:15:00+05:30`)
  const sessionEnd = sessionStart + (endAt - startAt)
  const firstFive = rows.filter(row => row.at >= sessionStart && row.at < sessionEnd)
  if (firstFive.length !== windowMinutes) return null
  let ema10, ema20
  for (let index = 0; index < firstFive.length; index++) {
    ema10 = index ? ema10 + 2 / 11 * (firstFive[index].close - ema10) : firstFive[index].close
    ema20 = index ? ema20 + 2 / 21 * (firstFive[index].close - ema20) : firstFive[index].close
  }
  const high = Math.max(...firstFive.map(row => row.high)), low = Math.min(...firstFive.map(row => row.low)), close = firstFive.at(-1).close
  return { returnPct: pct(close, firstFive[0].open), greenCandles: firstFive.filter(row => row.close > row.open).length, closeLocationPct: 100 * (close - low) / (high - low || 1), emaGapBps: 10_000 * (ema10 - ema20) / close, emaUp: ema10 > ema20 }
}

function depthFeature(symbol) {
  const file = path.join(depthRoot, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) throw new Error('depth file missing')
  const state = {}, snapshots = [], minutes = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event; try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt); if (!Number.isFinite(at)) continue
    if (at >= endAt) break
    if (event.kind === 'checkpoint' || event.book) for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    if (at < startAt) continue
    let bid = 0, ask = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = +state[`bid_price${level}`], ap = +state[`ask_price${level}`], bs = +state[`bid_size${level}`], as = +state[`ask_size${level}`]
      if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp) { valid = false; break }
      bid += bs; ask += as
    }
    if (!valid) continue
    snapshots.push({ mid: (+state.bid_price1 + +state.ask_price1) / 2 })
    minutes.add(clock(at))
  }
  if (minutes.size !== windowMinutes || !snapshots.length) return null
  return { midpointReturnPct: pct(snapshots.at(-1).mid, snapshots[0].mid), snapshots: snapshots.length }
}

function percentile80(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.8) - 1]
}
function percentile20(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.2) - 1]
}

const data = new Map(), skipped = []
for (let index = 0; index < symbols.length; index++) {
  const symbol = symbols[index]
  process.stdout.write(`\r\x1b[2KLoading [${index + 1}/${symbols.length}] ${symbol}...`)
  try {
    const rows = candles(symbol), today = openingFeature(rows, date), previousDays = [...new Set(rows.filter(row => row.day < date).map(row => row.day))].sort().slice(-10)
    const prior = previousDays.map(sessionDate => openingFeature(rows, sessionDate)).filter(Boolean)
    const depth = today ? depthFeature(symbol) : null
    if (!today || prior.length !== 10 || !depth) { skipped.push({ stock: symbol, reason: !today ? 'missing current five candles' : prior.length !== 10 ? 'fewer than ten prior sessions' : 'incomplete current depth' }); continue }
    data.set(symbol, { symbol, today, prior, depth })
  } catch (error) { skipped.push({ stock: symbol, reason: error.message }) }
}
process.stdout.write('\r\x1b[2K')

const groups = { buy: null, sell: null }
if (explicitSymbols) {
  const rows = [...data.values()]
  if (rows.length === symbols.length) {
    const daily = index => {
      const values = rows.map(row => index === 10 ? row.today : row.prior[index])
      const returns = values.map(value => value.returnPct).sort((a, b) => a - b)
      return { positive: values.filter(value => value.returnPct > 0).length, negative: values.filter(value => value.returnPct < 0).length, overHalf: values.filter(value => value.returnPct >= 0.5).length, underMinusHalf: values.filter(value => value.returnPct <= -0.5).length, emaUp: values.filter(value => value.emaUp).length, emaDown: values.filter(value => !value.emaUp).length, green3: values.filter(value => value.greenCandles >= 3).length, red3: values.filter(value => value.greenCandles <= windowMinutes - 3).length, average: values.reduce((sum, value) => sum + value.returnPct, 0) / values.length, median: returns[Math.floor(returns.length / 2)] }
    }
    const history = Array.from({ length: 10 }, (_, index) => daily(index)), today = daily(10), total = rows.length
    groups.buy = { active: today.positive === total && today.overHalf >= Math.ceil(total * 0.85) && today.emaUp === total && today.green3 === total && today.average > Math.max(...history.map(row => row.average)) && today.median > Math.max(...history.map(row => row.median)), today, priorExtremeAverage: Math.max(...history.map(row => row.average)), priorExtremeMedian: Math.max(...history.map(row => row.median)) }
    groups.sell = { active: today.negative === total && today.underMinusHalf >= Math.ceil(total * 0.85) && today.emaDown === total && today.red3 === total && today.average < Math.min(...history.map(row => row.average)) && today.median < Math.min(...history.map(row => row.median)), today, priorExtremeAverage: Math.min(...history.map(row => row.average)), priorExtremeMedian: Math.min(...history.map(row => row.median)) }
  }
}

const buyMatches = [], sellMatches = []
for (const row of data.values()) {
  const buyBaseline = percentile80(row.prior.map(value => value.returnPct))
  const buyThreshold = Math.max(0.5, buyBaseline)
  const sellBaseline = percentile20(row.prior.map(value => value.returnPct))
  const sellThreshold = Math.min(-0.5, sellBaseline)
  const priceDepthAgreement = Math.abs(row.today.returnPct - row.depth.midpointReturnPct) <= 0.5
  const buyEligible = row.today.returnPct >= buyThreshold && row.today.emaUp && row.today.greenCandles >= 3 && row.today.closeLocationPct >= 75 && row.depth.midpointReturnPct > 0 && priceDepthAgreement && (!args['require-group'] || groups.buy?.active)
  const sellEligible = row.today.returnPct <= sellThreshold && !row.today.emaUp && row.today.greenCandles <= windowMinutes - 3 && row.today.closeLocationPct <= 25 && row.depth.midpointReturnPct < 0 && priceDepthAgreement && (!args['require-group'] || groups.sell?.active)
  if (buyEligible) buyMatches.push({ Stock: row.symbol, 'Signal time': cutoffTime, 'Today return': `${row.today.returnPct >= 0 ? '+' : ''}${row.today.returnPct.toFixed(2)}%`, 'Prior P80': `${buyBaseline.toFixed(2)}%`, 'Depth midpoint': `${row.depth.midpointReturnPct >= 0 ? '+' : ''}${row.depth.midpointReturnPct.toFixed(2)}%`, 'EMA gap': `${row.today.emaGapBps.toFixed(1)} bps`, 'Green candles': `${row.today.greenCandles}/${windowMinutes}` })
  if (sellEligible) sellMatches.push({ Stock: row.symbol, 'Signal time': cutoffTime, 'Today return': `${row.today.returnPct >= 0 ? '+' : ''}${row.today.returnPct.toFixed(2)}%`, 'Prior P20': `${sellBaseline.toFixed(2)}%`, 'Depth midpoint': `${row.depth.midpointReturnPct >= 0 ? '+' : ''}${row.depth.midpointReturnPct.toFixed(2)}%`, 'EMA gap': `${row.today.emaGapBps.toFixed(1)} bps`, 'Red candles': `${windowMinutes - row.today.greenCandles}/${windowMinutes}` })
}
buyMatches.sort((a, b) => Number.parseFloat(b['Today return']) - Number.parseFloat(a['Today return']))
sellMatches.sort((a, b) => Number.parseFloat(a['Today return']) - Number.parseFloat(b['Today return']))
console.log(`Opening baseline scan | ${date} | 09:15-${cutoffTime} IST | signal at ${cutoffTime} IST`)
if (groups.buy) console.log(`BUY group regime: ${groups.buy.active ? 'ACTIVE' : 'inactive'} | today average ${groups.buy.today.average.toFixed(2)}% vs prior max ${groups.buy.priorExtremeAverage.toFixed(2)}%`)
if (groups.sell) console.log(`SELL group regime: ${groups.sell.active ? 'ACTIVE' : 'inactive'} | today average ${groups.sell.today.average.toFixed(2)}% vs prior min ${groups.sell.priorExtremeAverage.toFixed(2)}%`)
console.log('BUY side')
if (buyMatches.length) console.table(buyMatches); else console.log('No eligible BUY signals found.')
console.log('SELL side')
if (sellMatches.length) console.table(sellMatches); else console.log('No eligible SELL signals found.')
const report = { date, startTime: '09:15', signalTime: cutoffTime, cutoffExclusive: true, windowMinutes, rules: { buy: 'Window return positive and at least max(+0.50%, stock prior-ten-session P80 for the same window); EMA10 > EMA20; >=3 green candles; close location >=75%; depth midpoint positive; price/depth return difference <=0.50pp', sell: 'Window return negative and at most min(-0.50%, stock prior-ten-session P20 for the same window); EMA10 < EMA20; >=3 red candles; close location <=25%; depth midpoint negative; price/depth return difference <=0.50pp', groupWhenRequired: 'BUY and SELL each use their exact directional group regime: all directional, >=85% beyond the respective +/-0.50% threshold, and average/median more extreme than each prior ten-session window.' }, groups, buySignals: buyMatches, sellSignals: sellMatches, skipped }
let suffix = 1, outputFile
do { outputFile = path.join(root, 'reports', `${date}-opening-five-candle-baseline${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(outputFile))
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(`Signals: BUY ${buyMatches.length}, SELL ${sellMatches.length}/${symbols.length}`)
console.log(`Saved report: ${outputFile}`)
