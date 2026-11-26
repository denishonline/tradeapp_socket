import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), targetDate = process.argv[2] ?? '2026-10-19', requestedCutoff = process.argv[3] ?? 'latest'
const IST = 330 * 60_000, ANGLE_MIN = 0.15, EMA45_ANGLE_MIN = 0.15, PRICE_EMA5_ANGLE_MIN = 0.15, MAX_EMA_GAP_PCT = 0.3
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const local = epoch => { const d = new Date(epoch * 1000 + IST); return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() } }
const cutoffValue = requestedCutoff === 'latest' ? Infinity : Number(requestedCutoff.slice(0, 2)) * 60 + Number(requestedCutoff.slice(3))
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db/stocks'), 'utf8')).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]

function readCandles(symbol) {
  const file = path.join(root, 'db/candles', `${symbol}.jsonl`), unique = new Map()
  if (!fs.existsSync(file)) return []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const time = Number(row.time), close = Number(row.close), localTime = local(time)
    if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0 || !Number.isFinite(Number(row.volume))) continue
    if (localTime.date > targetDate || localTime.minute < 555 || localTime.minute >= 930 || (localTime.date === targetDate && localTime.minute >= cutoffValue)) continue
    if (!unique.has(time)) unique.set(time, { time, open: +row.open, high: +row.high, low: +row.low, close, volume: +row.volume })
  }
  return [...unique.values()].filter(row => Object.values(row).every(Number.isFinite)).sort((a, b) => a.time - b.time)
}

function pviFeatures(candles) {
  if (candles.length < 300) return null
  const pvi = [1000]
  for (let i = 1; i < candles.length; i++) pvi.push(candles[i].volume > candles[i - 1].volume ? pvi[i - 1] * candles[i].close / candles[i - 1].close : pvi[i - 1])
  const makeEma = period => { const alpha = 2 / (period + 1), values = [pvi[0]]; for (const value of pvi.slice(1)) values.push(alpha * value + (1 - alpha) * values.at(-1)); return values }
  const angle = values => { const ys = values.slice(-300).map(Math.log), n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n; let cov = 0, xx = 0; ys.forEach((y, i) => { cov += (i - mx) * (y - my); xx += (i - mx) ** 2 }); return Math.atan(100 * cov / xx) * 180 / Math.PI }
  const e9 = makeEma(9), e45 = makeEma(45), e255 = makeEma(255), price5 = priceEmaSeries(candles, 5), price9 = priceEmaSeries(candles, 9), price45 = priceEmaSeries(candles, 45), last = candles.at(-1)
  return { pviEma9: e9.at(-1), pviEma45: e45.at(-1), pviEma255: e255.at(-1), pviEma9AngleDeg: angle(e9), pviEma45AngleDeg: angle(e45), pviEma255AngleDeg: angle(e255), priceEma5AngleDeg: angle(price5), priceEma9: price9.at(-1), priceEma45: price45.at(-1), priceEma9AngleDeg: angle(price9), priceEma45AngleDeg: angle(price45), candleTimeIST: `${local(last.time).date} ${String(Math.floor(local(last.time).minute / 60)).padStart(2, '0')}:${String(local(last.time).minute % 60).padStart(2, '0')}` }
}
function priceEmaSeries(candles, period) { const alpha = 2 / (period + 1), values = [candles[0].close]; for (const row of candles.slice(1)) values.push(alpha * row.close + (1 - alpha) * values.at(-1)); return values }

function depthMinute(symbol, candleTime) {
  const date = local(candleTime).date, minuteStart = Math.floor(candleTime / 60) * 60 * 1000, minuteEnd = minuteStart + 60_000, file = path.join(root, 'db/cash-depth', date, symbol, `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { available: false }
  const state = {}, buckets = new Map(), valid = data => {
    let bid = 0, ask = 0
    for (let i = 1; i <= 5; i++) { const bp = +state[`bid_price${i}`], ap = +state[`ask_price${i}`], bs = +state[`bid_size${i}`], as = +state[`ask_size${i}`]; if (![bp, ap, bs, as].every(Number.isFinite) || bp <= 0 || ap <= bp || bs < 0 || as < 0) return null; bid += bs; ask += as }
    return { at: data.at, bidSharePct: 100 * bid / (bid + ask || 1), mid: (+state.bid_price1 + +state.ask_price1) / 2, spreadBps: 10000 * (+state.ask_price1 - +state.bid_price1) / ((+state.bid_price1 + +state.ask_price1) / 2), cumulativeVolume: Number(data.event.marketContext?.cumulativeVolume) }
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const at = Date.parse(event.receivedAt); if (!Number.isFinite(at) || at >= minuteEnd) continue
    if (event.kind === 'checkpoint' || event.book) { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, event.data ?? {}) } else if (event.kind === 'update') Object.assign(state, event.data ?? {}); else continue
    const row = valid({ at, event }); if (!row) continue
    const key = Math.floor(at / 60_000) * 60_000; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row)
  }
  const current = buckets.get(minuteStart) ?? [], previous = buckets.get(minuteStart - 60_000) ?? []
  if (!current.length) return { available: false }
  const first = current[0], last = current.at(-1), previousLast = previous.at(-1)
  return { available: true, snapshots: current.length, bidDominantPct: 100 * current.filter(x => x.bidSharePct > 50).length / current.length, meanBidSharePct: current.reduce((s, x) => s + x.bidSharePct, 0) / current.length, meanSpreadBps: current.reduce((s, x) => s + x.spreadBps, 0) / current.length, midpointMovePct: 100 * (last.mid / first.mid - 1), cumulativeVolumeIncrease: last.cumulativeVolume - first.cumulativeVolume, previousMinuteCumulativeVolume: previousLast?.cumulativeVolume ?? null, cumulativeVolumeIncreasing: Number.isFinite(last.cumulativeVolume) && last.cumulativeVolume > first.cumulativeVolume && (!previousLast || last.cumulativeVolume > previousLast.cumulativeVolume) }
}

function screenAt(symbol, candles, endIndex) {
  const history = candles.slice(0, endIndex + 1), base = { symbol, stage: 0 }
  if (history.length < 300) return { ...base, failure: 'fewer than 300 candles' }
  const pvi = pviFeatures(history), latest = history.at(-1), previous = history.at(-2), prior3 = history.slice(-5, -2)
  const meanPrior3Volume = prior3.length ? prior3.reduce((s, x) => s + x.volume, 0) / prior3.length : NaN
  const candleGap = latest.time - previous.time
  const priceAction = latest.close > latest.open && previous.close > previous.open && latest.close > previous.close && latest.low >= previous.low && latest.high > previous.high
  const moderateVolume = previous.volume >= 0.5 * meanPrior3Volume && previous.volume <= 1.5 * meanPrior3Volume
  const strongerContinuation = latest.volume > previous.volume && latest.volume >= 1.2 * meanPrior3Volume
  const row = { ...base, candleTimeIST: pvi.candleTimeIST, pviEma9AngleDeg: round(pvi.pviEma9AngleDeg, 5), pviEma45AngleDeg: round(pvi.pviEma45AngleDeg, 5), pviEma255AngleDeg: round(pvi.pviEma255AngleDeg, 5), priceEma5AngleDeg: round(pvi.priceEma5AngleDeg, 5), priceEma9AngleDeg: round(pvi.priceEma9AngleDeg, 5), priceEma45AngleDeg: round(pvi.priceEma45AngleDeg, 5), priceEma9: round(pvi.priceEma9, 2), priceEma45: round(pvi.priceEma45, 2), priceEmaGapPct: round(100 * Math.abs(pvi.priceEma9 / pvi.priceEma45 - 1), 5), latestVolume: latest.volume, previousVolume: previous.volume, prior3MeanVolume: round(meanPrior3Volume, 2), moderateVolume, strongerContinuation, bullishPriceAction: priceAction, contiguousCandles: candleGap === 60 }
  if (!(pvi.pviEma9AngleDeg > ANGLE_MIN && pvi.pviEma45AngleDeg > EMA45_ANGLE_MIN && pvi.pviEma255AngleDeg > ANGLE_MIN)) return { ...row, failure: 'PVI EMA angle rule' }
  row.stage = 1
  if (!(pvi.priceEma5AngleDeg > PRICE_EMA5_ANGLE_MIN && pvi.priceEma9AngleDeg > ANGLE_MIN && pvi.priceEma45AngleDeg > ANGLE_MIN && pvi.priceEma9 > pvi.priceEma45)) return { ...row, failure: 'regular price EMA angle/direction rule' }
  row.stage = 1.5
  if (!(row.priceEmaGapPct < MAX_EMA_GAP_PCT)) return { ...row, failure: 'price EMA9/EMA45 distance >= 0.3%' }
  row.stage = 2
  if (!(row.contiguousCandles && row.bullishPriceAction)) return { ...row, failure: 'bullish price action/continuity rule' }
  row.stage = 3
  if (!row.moderateVolume) return { ...row, failure: 'moderate volume confirmation rule' }
  row.stage = 4
  if (!row.strongerContinuation) return { ...row, failure: 'stronger volume continuation rule' }
  row.stage = 5
  Object.assign(row, depthMinute(symbol, latest.time))
  if (!(row.available && row.cumulativeVolumeIncreasing)) return { ...row, failure: 'depth cumulative volume not increasing' }
  row.stage = 6
  return { ...row, eligible: true }
}

let n = 1, file
function screen(symbol) {
  const candles = readCandles(symbol)
  if (requestedCutoff === 'latest') return screenAt(symbol, candles, candles.length - 1)
  const outputRows = []
  for (let i = 299; i < candles.length; i++) if (local(candles[i].time).date === targetDate) outputRows.push(screenAt(symbol, candles, i))
  return outputRows
}

const screened = symbols.flatMap(screen), eligible = screened.filter(row => row.eligible), rows = screened, output = { targetDate, requestedCutoff, mode: requestedCutoff === 'latest' ? 'latest-only' : 'all-completed-minutes-through-cutoff', symbolsScanned: symbols.length, rowsEvaluated: screened.length, rules: ['PVI-EMA9/45/255 and regular price EMA5/EMA9/EMA45 trend angles > +0.15 degrees', 'regular price EMA9 > EMA45', 'absolute price EMA9/EMA45 distance < 0.3%', 'two consecutive bullish higher candles with higher high and higher low', 'previous candle volume moderate confirmation', 'latest candle volume stronger continuation', 'latest depth-minute cumulative volume rises from first to last snapshot and exceeds previous-minute final cumulative volume'], stageCounts: Object.fromEntries(Array.from({ length: 6 }, (_, i) => i + 1).map(stage => [`afterRule${stage}`, screened.filter(row => row.stage >= stage).length])), eligibleCount: eligible.length, eligible, rows }
do { file = path.join(root, 'reports', `${targetDate}-${requestedCutoff === 'latest' ? 'live' : requestedCutoff.replace(':', '')}-pvi-ema-depth-strategy${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(`Date: ${targetDate} | cutoff: ${requestedCutoff} | scanned: ${symbols.length} | rows: ${screened.length} | eligible: ${eligible.length}`); console.log(eligible.map(row => `${row.symbol} ${row.candleTimeIST} PVI angles ${row.pviEma9AngleDeg}/${row.pviEma45AngleDeg}/${row.pviEma255AngleDeg} EMA gap ${row.priceEmaGapPct}%`).join('\n')); console.log(`JSON: ${file}`)
