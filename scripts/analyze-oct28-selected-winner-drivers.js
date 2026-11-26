import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const REPORTS = path.join(ROOT, 'reports')
const DATE = '2026-10-28'
const DATES = ['2026-10-26', '2026-10-27', DATE]
const PRIOR_DATES = DATES.slice(0, 2)
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const SESSION_OPEN = 9 * 60 + 15
const SESSION_CLOSE = 15 * 60 + 30

const signalReport = path.join(REPORTS, '2026-10-28-1530-fixed-29-filter-chronological-2.json')
if (!fs.existsSync(signalReport)) throw new Error(`Missing signal report: ${signalReport}`)
const allSignals = JSON.parse(fs.readFileSync(signalReport, 'utf8')).signals

const targets = [
  ['BIOCON', 'BUY', '10:54'], ['WAAREEENER', 'BUY', '11:05'],
  ['CROMPTON', 'BUY', '11:10'], ['KALYANKJIL', 'BUY', '11:33'],
  ['BLUESTARCO', 'BUY', '11:37'], ['NAUKRI', 'BUY', '11:38'],
  ['PREMIERENE', 'BUY', '11:46'], ['VOLTAS', 'BUY', '11:56'],
  ['TECHM', 'BUY', '11:58'], ['UNITDSPR', 'SELL', '11:11']
]
const targetSet = new Set(targets.map(values => values.join('|')))

const round = (value, places = 4) => Number.isFinite(value) ? +value.toFixed(places) : null
const mean = values => {
  const valid = values.filter(Number.isFinite)
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : NaN
}
const median = values => quantile(values, 0.5)
const quantile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return NaN
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position), upper = Math.ceil(position)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}
const std = values => {
  const valid = values.filter(Number.isFinite), average = mean(valid)
  return valid.length ? Math.sqrt(mean(valid.map(value => (value - average) ** 2))) : NaN
}
const pct = (value, base) => Number.isFinite(value) && Number.isFinite(base) && base !== 0 ? 100 * (value / base - 1) : NaN
const localDate = epoch => new Date(epoch + IST_OFFSET).toISOString().slice(0, 10)
const localTime = epoch => new Date(epoch + IST_OFFSET).toISOString().slice(11, 16)
const minuteOfDay = epoch => {
  const value = new Date(epoch + IST_OFFSET)
  return value.getUTCHours() * 60 + value.getUTCMinutes()
}
const epochAt = (date, time) => Date.parse(`${date}T${time}:00+05:30`)
const readJsonLines = filename => {
  if (!fs.existsSync(filename)) return []
  const rows = []
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try { rows.push(JSON.parse(line)) } catch { /* Ignore damaged records. */ }
  }
  return rows
}

function readCandles(symbol, allowZeroVolume = false) {
  const byDate = new Map(DATES.map(date => [date, []]))
  for (const record of readJsonLines(path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`))) {
    const t = Number(record.time) * 1000
    const date = localDate(t)
    if (!byDate.has(date)) continue
    const o = Number(record.open), h = Number(record.high), l = Number(record.low)
    const c = Number(record.close), v = Number(record.volume)
    if (![t, o, h, l, c, v].every(Number.isFinite) || (!allowZeroVolume && v <= 0)) continue
    const minute = minuteOfDay(t)
    if (minute < SESSION_OPEN || minute >= SESSION_CLOSE) continue
    byDate.get(date).push({t, o, h, l, c, v})
  }
  for (const [date, rows] of byDate) {
    rows.sort((a, b) => a.t - b.t)
    byDate.set(date, rows.filter((row, index) => index === 0 || row.t !== rows[index - 1].t))
  }
  return byDate
}

function enrich(rows, useVolume = true) {
  let ema10, ema20, ema12, ema26, vwapNumerator = 0, vwapVolume = 0, obv = 0, pvi = 1000, nvi = 1000
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], prior = rows[index - 1]
    ema10 = ema10 == null ? row.c : ema10 + 2 / 11 * (row.c - ema10)
    ema20 = ema20 == null ? row.c : ema20 + 2 / 21 * (row.c - ema20)
    ema12 = ema12 == null ? row.c : ema12 + 2 / 13 * (row.c - ema12)
    ema26 = ema26 == null ? row.c : ema26 + 2 / 27 * (row.c - ema26)
    if (prior) {
      obv += row.c > prior.c ? row.v : row.c < prior.c ? -row.v : 0
      if (row.v > prior.v) pvi *= row.c / prior.c
      if (row.v < prior.v) nvi *= row.c / prior.c
    }
    const weight = useVolume && row.v > 0 ? row.v : 1
    vwapNumerator += ((row.h + row.l + row.c) / 3) * weight
    vwapVolume += weight
    Object.assign(row, {ema10, ema20, macd: ema12 - ema26, vwap: vwapNumerator / vwapVolume, obv, pvi, nvi})
  }
}

function rsi(rows, endIndex, length = 14) {
  if (endIndex < length) return NaN
  let gain = 0, loss = 0
  for (let index = endIndex - length + 1; index <= endIndex; index++) {
    const change = rows[index].c - rows[index - 1].c
    if (change > 0) gain += change; else loss -= change
  }
  if (loss === 0) return 100
  return 100 - 100 / (1 + gain / loss)
}

function atr(rows, endIndex, length = 14) {
  if (endIndex < length) return NaN
  const values = []
  for (let index = endIndex - length + 1; index <= endIndex; index++) {
    const priorClose = rows[index - 1].c
    values.push(Math.max(rows[index].h - rows[index].l, Math.abs(rows[index].h - priorClose), Math.abs(rows[index].l - priorClose)))
  }
  return mean(values)
}

function directionalIndex(rows, endIndex, direction, length = 14) {
  if (endIndex < length) return {adx: NaN, directionalDi: NaN}
  let trueRange = 0, plusDm = 0, minusDm = 0
  for (let index = endIndex - length + 1; index <= endIndex; index++) {
    const row = rows[index], prior = rows[index - 1]
    trueRange += Math.max(row.h - row.l, Math.abs(row.h - prior.c), Math.abs(row.l - prior.c))
    const up = row.h - prior.h, down = prior.l - row.l
    plusDm += up > down && up > 0 ? up : 0
    minusDm += down > up && down > 0 ? down : 0
  }
  const plusDi = 100 * plusDm / (trueRange || 1), minusDi = 100 * minusDm / (trueRange || 1)
  return {adx: 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi || 1), directionalDi: direction > 0 ? plusDi - minusDi : minusDi - plusDi}
}

function regressionSlope(values) {
  if (values.length < 2) return NaN
  const xMean = (values.length - 1) / 2, yMean = mean(values)
  let numerator = 0, denominator = 0
  for (let index = 0; index < values.length; index++) {
    numerator += (index - xMean) * (values[index] - yMean)
    denominator += (index - xMean) ** 2
  }
  return numerator / denominator
}

function daily(rows) {
  if (!rows.length) return null
  return {
    open: rows[0].o, high: Math.max(...rows.map(row => row.h)), low: Math.min(...rows.map(row => row.l)),
    close: rows.at(-1).c, volume: rows.reduce((sum, row) => sum + row.v, 0)
  }
}

function readDepth(symbol, date) {
  const filename = path.join(ROOT, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  const rows = [], state = {}
  for (const event of readJsonLines(filename)) {
    const t = Date.parse(event.receivedAt)
    if (!Number.isFinite(t) || localDate(t) !== date) continue
    if (event.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    let bid = 0, ask = 0, bidOrders = 0, askOrders = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bp = Number(state[`bid_price${level}`]), ap = Number(state[`ask_price${level}`])
      const bs = Number(state[`bid_size${level}`]), as = Number(state[`ask_size${level}`])
      const bo = Number(state[`bid_order${level}`]), ao = Number(state[`ask_order${level}`])
      if (![bp, ap, bs, as].every(Number.isFinite) || ap <= bp) { valid = false; break }
      bid += bs; ask += as
      if (Number.isFinite(bo)) bidOrders += bo
      if (Number.isFinite(ao)) askOrders += ao
    }
    if (!valid || bid + ask <= 0) continue
    const bp1 = Number(state.bid_price1), ap1 = Number(state.ask_price1)
    const bs1 = Number(state.bid_size1), as1 = Number(state.ask_size1)
    const midpoint = (bp1 + ap1) / 2
    rows.push({
      t, bidShare: 100 * bid / (bid + ask), topBidShare: 100 * bs1 / (bs1 + as1 || 1),
      orderBidShare: 100 * bidOrders / (bidOrders + askOrders || 1),
      spreadBps: 10000 * (ap1 - bp1) / midpoint, midpoint, bid, ask
    })
  }
  return rows
}

function depthWindow(rows, start, end, side) {
  const window = rows.filter(row => row.t >= start && row.t < end)
  if (window.length < 5) return null
  const directionShare = row => side === 'BUY' ? row.bidShare : 100 - row.bidShare
  const topShare = row => side === 'BUY' ? row.topBidShare : 100 - row.topBidShare
  const orderShare = row => side === 'BUY' ? row.orderBidShare : 100 - row.orderBidShare
  const directionSize = row => side === 'BUY' ? row.bid : row.ask
  const oppositeSize = row => side === 'BUY' ? row.ask : row.bid
  const shares = window.map(directionShare)
  const third = Math.max(1, Math.floor(window.length / 3))
  const early = window.slice(0, third), late = window.slice(-third)
  return {
    snapshots: window.length,
    directionalDepthShareMean: mean(shares), directionalDepthShareMedian: median(shares),
    directionalDepthShareLast: shares.at(-1), directionalDepthShareMax: Math.max(...shares),
    directionalDepthShareP75: quantile(shares, 0.75), directionalDepthShareStd: std(shares),
    directionalDepthShareDelta: shares.at(-1) - shares[0],
    directionalDepthShareLateEarly: mean(late.map(directionShare)) - mean(early.map(directionShare)),
    directionalDepthAbove50Pct: 100 * shares.filter(value => value > 50).length / shares.length,
    directionalDepthAbove55Pct: 100 * shares.filter(value => value > 55).length / shares.length,
    directionalTopShareMean: mean(window.map(topShare)), directionalOrderShareMean: mean(window.map(orderShare)),
    spreadMeanBps: mean(window.map(row => row.spreadBps)), spreadMaxBps: Math.max(...window.map(row => row.spreadBps)),
    directionalSizeLateEarlyPct: pct(mean(late.map(directionSize)), mean(early.map(directionSize))),
    oppositeSizeLateEarlyPct: pct(mean(late.map(oppositeSize)), mean(early.map(oppositeSize))),
    directionalBookRatioLateEarly: mean(late.map(row => directionSize(row) / oppositeSize(row))) - mean(early.map(row => directionSize(row) / oppositeSize(row))),
    depthMidReturnDirPct: (side === 'BUY' ? 1 : -1) * pct(window.at(-1).midpoint, window[0].midpoint),
    depthMidRangePct: pct(Math.max(...window.map(row => row.midpoint)), Math.min(...window.map(row => row.midpoint)))
  }
}

const featureCatalog = {
  priorDayReturnDirPct: ['History/SR', 'Prior-session return aligned with trade'],
  twoDayReturnDirPct: ['History/SR', 'Two-session momentum aligned with trade'],
  openingGapDirPct: ['History/SR', 'Opening gap aligned with trade'],
  currentFromOpenDirPct: ['History/SR', 'Signal price move from session open'],
  priorDayExtremeBreakDirPct: ['History/SR', 'Break beyond prior-day high/low'],
  twoDayExtremeBreakDirPct: ['History/SR', 'Break beyond two-day high/low'],
  openingRange15BreakDirPct: ['History/SR', 'Break beyond first-15-minute range'],
  prior20BreakDirPct: ['History/SR', 'Break beyond prior 20-candle extreme'],
  directionalSessionPositionPct: ['History/SR', 'Position toward directional session extreme'],
  oppositePriorExtremeBufferPct: ['History/SR', 'Distance from opposite prior-day extreme'],
  priorDayRangePct: ['History/SR', 'Previous-session range'],
  prior2AverageRangePct: ['History/SR', 'Average range of prior two sessions'],
  atr14Pct: ['Volatility', 'ATR-14 as percentage of price'],
  currentRangeVsPrior2Pct: ['Volatility', 'Current range versus prior average range'],
  cumulativeVolumeVsPrior2: ['Volume', 'Cumulative volume versus same time on prior sessions'],
  window15VolumeVsPrior2: ['Volume', '15-minute volume versus same window on prior sessions'],
  signalVolumeVs20: ['Volume', 'Signal-candle volume versus prior 20 candles'],
  volume5VsPrevious5: ['Volume', 'Latest five-candle volume versus preceding five'],
  volume15VsPrevious15: ['Volume', 'Confirmation volume versus preceding 15 candles'],
  favorableVolumeShare15Pct: ['Volume', 'Directional candle-volume share'],
  favorableAdverseVolumeRatio15: ['Volume', 'Mean directional/adverse candle-volume ratio'],
  directionalObvChange15: ['Volume', 'Directional OBV change normalized by average volume'],
  directionalPviChange15Pct: ['Volume', 'Directional PVI change'],
  directionalNviChange15Pct: ['Volume', 'Directional NVI change'],
  highVolumeCandles15: ['Volume', 'Confirmation candles above prior-20 average volume'],
  return5DirPct: ['Momentum', 'Directional five-candle return'],
  return15DirPct: ['Momentum', 'Directional 15-candle return'],
  return30DirPct: ['Momentum', 'Directional 30-candle return'],
  emaGapDirBps: ['Momentum', 'Directional EMA10/EMA20 separation'],
  ema10Slope5DirPct: ['Momentum', 'Directional five-candle EMA10 slope'],
  ema20Slope5DirPct: ['Momentum', 'Directional five-candle EMA20 slope'],
  priceVsEma10DirPct: ['Momentum', 'Price position versus EMA10'],
  priceVsEma20DirPct: ['Momentum', 'Price position versus EMA20'],
  priceVsVwapDirPct: ['Momentum', 'Price position versus session VWAP'],
  vwapSlope15DirPct: ['Momentum', 'Directional 15-candle VWAP slope'],
  macdDirBps: ['Momentum', 'Directional MACD normalized by price'],
  macdSlope5DirBps: ['Momentum', 'Directional five-candle MACD change'],
  rsi14Directional: ['Momentum', 'RSI transformed into trade direction'],
  adx14: ['Momentum', 'ADX-like 14-candle directional strength'],
  directionalDiSpread14: ['Momentum', 'Directional DI minus opposite DI'],
  bollingerZDirectional: ['Momentum', 'Directional 20-candle Bollinger z-score'],
  regressionSlope15DirBps: ['Structure', 'Directional 15-candle regression slope'],
  efficiency15Directional: ['Structure', 'Directional net/path efficiency'],
  favorableCandleShare15Pct: ['Structure', 'Directional candle-count share'],
  favorableBodyDominance15: ['Structure', 'Directional/adverse body ratio'],
  signalCloseLocationDirectionalPct: ['Structure', 'Signal close location toward directional edge'],
  directionalVwapHoldCount15: ['Structure', 'Confirmation closes on directional side of VWAP'],
  directionalHigherStructure: ['Structure', 'Directional higher/lower high-low structure'],
  maxDirectionalPullbackPct: ['Structure', 'Worst adverse retracement during confirmation'],
  nearDirectionalExtremeCloseCount15: ['Structure', 'Closes near directional candle extreme'],
  maxFavorableCloseStreak15: ['Structure', 'Maximum directional close streak'],
  momentumAccelerationDirPct: ['Structure', 'Latest-five acceleration versus 15-candle pace'],
  snapshots: ['Depth', 'Depth observations in confirmation window'],
  directionalDepthShareMean: ['Depth', 'Mean directional five-level displayed-size share'],
  directionalDepthShareMedian: ['Depth', 'Median directional displayed-size share'],
  directionalDepthShareLast: ['Depth', 'Final directional displayed-size share'],
  directionalDepthShareMax: ['Depth', 'Maximum directional displayed-size share'],
  directionalDepthShareP75: ['Depth', '75th percentile directional displayed-size share'],
  directionalDepthShareStd: ['Depth', 'Directional share variability'],
  directionalDepthShareDelta: ['Depth', 'Final-minus-first directional share'],
  directionalDepthShareLateEarly: ['Depth', 'Late-minus-early directional share'],
  directionalDepthAbove50Pct: ['Depth', 'Snapshots with directional share above 50%'],
  directionalDepthAbove55Pct: ['Depth', 'Snapshots with directional share above 55%'],
  directionalTopShareMean: ['Depth', 'Mean directional top-level share'],
  directionalOrderShareMean: ['Depth', 'Mean directional order-count share'],
  spreadMeanBps: ['Depth', 'Mean quoted spread'],
  spreadMaxBps: ['Depth', 'Maximum quoted spread'],
  directionalSizeLateEarlyPct: ['Depth', 'Late/early directional displayed-size change'],
  oppositeSizeLateEarlyPct: ['Depth', 'Late/early opposite displayed-size change'],
  directionalBookRatioLateEarly: ['Depth', 'Late/early directional book-ratio change'],
  depthMidReturnDirPct: ['Depth', 'Directional midpoint return during confirmation'],
  depthMidRangePct: ['Depth', 'Depth midpoint range'],
  depthShareVsPrior2SameTimePp: ['Depth history', 'Directional share versus same-time prior sessions'],
  depthOrderShareVsPrior2SameTimePp: ['Depth history', 'Directional order share versus prior sessions'],
  spreadVsPrior2SameTimeRatio: ['Depth history', 'Spread versus same-time prior sessions'],
  niftyFromOpenDirPct: ['NIFTY', 'NIFTY move from open aligned with trade'],
  niftyReturn5DirPct: ['NIFTY', 'NIFTY five-candle move aligned with trade'],
  niftyReturn15DirPct: ['NIFTY', 'NIFTY 15-candle move aligned with trade'],
  niftyEmaGapDirBps: ['NIFTY', 'Directional NIFTY EMA10/EMA20 gap'],
  niftyEma10Slope5DirPct: ['NIFTY', 'Directional NIFTY EMA10 slope'],
  niftySessionPositionDirectionalPct: ['NIFTY', 'NIFTY position toward directional session extreme'],
  niftyRsiDirectional: ['NIFTY', 'NIFTY RSI transformed into trade direction'],
  niftyPriceVsMeanDirPct: ['NIFTY', 'NIFTY versus session typical-price mean'],
  niftyTrendAligned: ['NIFTY', 'NIFTY EMA and price aligned with trade'],
  relativeStrengthFromOpenPct: ['Relative strength', 'Stock directional move minus NIFTY from open'],
  relativeStrength15Pct: ['Relative strength', 'Stock directional 15-candle return minus NIFTY'],
  stockNiftyCorrelation30: ['Relative strength', 'Thirty-candle stock/NIFTY return correlation'],
  niftyRangeToSignalPct: ['NIFTY', 'NIFTY session range through signal'],
  niftyMacdDirBps: ['NIFTY', 'Directional NIFTY MACD normalized by index']
}

function candleFeatureSet(signal, stockByDate, niftyByDate) {
  const direction = signal.side === 'BUY' ? 1 : -1
  const currentAll = stockByDate.get(DATE) ?? []
  const signalEpoch = epochAt(DATE, signal.signalCandleTime)
  const current = currentAll.filter(row => row.t <= signalEpoch)
  if (current.length < 35) return null
  enrich(current)
  const index = current.length - 1, row = current[index], window15 = current.slice(-15)
  const previous15 = current.slice(-30, -15), previous20 = current.slice(-35, -15)
  const last5 = current.slice(-5), previous5 = current.slice(-10, -5)
  const prior20Price = current.slice(-21, -1)
  const priorDay = daily(stockByDate.get('2026-10-27') ?? [])
  const priorTwoDays = PRIOR_DATES.map(date => daily(stockByDate.get(date) ?? [])).filter(Boolean)
  if (!priorDay || priorTwoDays.length < 2) return null
  const twoDayHigh = Math.max(...priorTwoDays.map(value => value.high))
  const twoDayLow = Math.min(...priorTwoDays.map(value => value.low))
  const priorExtreme = signal.side === 'BUY' ? priorDay.high : priorDay.low
  const twoDayExtreme = signal.side === 'BUY' ? twoDayHigh : twoDayLow
  const opening15 = current.slice(0, 15)
  const openingExtreme = signal.side === 'BUY' ? Math.max(...opening15.map(value => value.h)) : Math.min(...opening15.map(value => value.l))
  const prior20Extreme = signal.side === 'BUY' ? Math.max(...prior20Price.map(value => value.h)) : Math.min(...prior20Price.map(value => value.l))
  const sessionHigh = Math.max(...current.map(value => value.h)), sessionLow = Math.min(...current.map(value => value.l))
  const directionalPosition = signal.side === 'BUY' ? 100 * (row.c - sessionLow) / (sessionHigh - sessionLow || 1) : 100 * (sessionHigh - row.c) / (sessionHigh - sessionLow || 1)
  const oppositeBuffer = signal.side === 'BUY' ? pct(row.c, priorDay.low) : pct(priorDay.high, row.c)
  const priorRanges = priorTwoDays.map(value => 100 * (value.high - value.low) / value.open)
  const currentRangePct = 100 * (sessionHigh - sessionLow) / current[0].o
  const priorSameTimeVolumes = PRIOR_DATES.map(date => (stockByDate.get(date) ?? []).filter(value => localTime(value.t) <= signal.signalCandleTime).reduce((sum, value) => sum + value.v, 0))
  const currentCumulativeVolume = current.reduce((sum, value) => sum + value.v, 0)
  const windowStartTime = signal.windowStartTime
  const priorWindowVolumes = PRIOR_DATES.map(date => (stockByDate.get(date) ?? []).filter(value => localTime(value.t) >= windowStartTime && localTime(value.t) <= signal.signalCandleTime).reduce((sum, value) => sum + value.v, 0))
  const favorable = window15.filter(value => direction * (value.c - value.o) > 0)
  const adverse = window15.filter(value => direction * (value.c - value.o) < 0)
  const favorableVolume = favorable.reduce((sum, value) => sum + value.v, 0)
  const adverseVolume = adverse.reduce((sum, value) => sum + value.v, 0)
  const favorableBody = favorable.reduce((sum, value) => sum + Math.abs(value.c - value.o), 0)
  const adverseBody = adverse.reduce((sum, value) => sum + Math.abs(value.c - value.o), 0)
  const avgPrior20Volume = mean(current.slice(-35, -15).map(value => value.v))
  const di = directionalIndex(current, index, direction)
  const close20 = current.slice(-20).map(value => value.c), closeMean = mean(close20), closeStd = std(close20)
  const changes15 = window15.slice(1).map((value, offset) => Math.abs(value.c - window15[offset].c))
  const directionalNet15 = direction * (window15.at(-1).c - window15[0].o)
  const efficiency = 100 * directionalNet15 / (changes15.reduce((sum, value) => sum + value, 0) || 1)
  const firstHalf = window15.slice(0, 7), secondHalf = window15.slice(7)
  const directionalStructure = signal.side === 'BUY'
    ? Math.max(...secondHalf.map(value => value.h)) > Math.max(...firstHalf.map(value => value.h)) && Math.min(...secondHalf.map(value => value.l)) > Math.min(...firstHalf.map(value => value.l))
    : Math.min(...secondHalf.map(value => value.l)) < Math.min(...firstHalf.map(value => value.l)) && Math.max(...secondHalf.map(value => value.h)) < Math.max(...firstHalf.map(value => value.h))
  let favorableExtreme = window15[0].o, pullback = 0, streak = 0, maxStreak = 0
  for (const value of window15) {
    if (signal.side === 'BUY') {
      favorableExtreme = Math.max(favorableExtreme, value.h)
      pullback = Math.min(pullback, pct(value.l, favorableExtreme))
    } else {
      favorableExtreme = Math.min(favorableExtreme, value.l)
      pullback = Math.min(pullback, pct(favorableExtreme, value.h))
    }
    streak = direction * (value.c - value.o) > 0 ? streak + 1 : 0
    maxStreak = Math.max(maxStreak, streak)
  }

  const niftyAll = niftyByDate.get(DATE) ?? []
  const nifty = niftyAll.filter(value => value.t <= signalEpoch)
  enrich(nifty, false)
  const ni = nifty.length - 1, n = nifty[ni], nifty15 = nifty.slice(-15), nifty30 = nifty.slice(-31)
  const niftyHigh = Math.max(...nifty.map(value => value.h)), niftyLow = Math.min(...nifty.map(value => value.l))
  const niftyPosition = signal.side === 'BUY' ? 100 * (n.c - niftyLow) / (niftyHigh - niftyLow || 1) : 100 * (niftyHigh - n.c) / (niftyHigh - niftyLow || 1)
  const stockReturns = current.slice(-31).slice(1).map((value, offset) => pct(value.c, current.slice(-31)[offset].c))
  const niftyReturns = nifty30.slice(1).map((value, offset) => pct(value.c, nifty30[offset].c))
  const correlation = (() => {
    const count = Math.min(stockReturns.length, niftyReturns.length)
    if (count < 10) return NaN
    const a = stockReturns.slice(-count), b = niftyReturns.slice(-count), am = mean(a), bm = mean(b)
    const covariance = mean(a.map((value, offset) => (value - am) * (b[offset] - bm)))
    return covariance / (std(a) * std(b) || 1)
  })()
  const stock15Return = direction * pct(window15.at(-1).c, window15[0].o)
  const nifty15Return = direction * pct(nifty15.at(-1).c, nifty15[0].o)

  return {
    priorDayReturnDirPct: direction * pct(priorDay.close, priorDay.open),
    twoDayReturnDirPct: direction * pct(priorTwoDays.at(-1).close, priorTwoDays[0].open),
    openingGapDirPct: direction * pct(current[0].o, priorDay.close),
    currentFromOpenDirPct: direction * pct(row.c, current[0].o),
    priorDayExtremeBreakDirPct: direction * pct(row.c, priorExtreme),
    twoDayExtremeBreakDirPct: direction * pct(row.c, twoDayExtreme),
    openingRange15BreakDirPct: direction * pct(row.c, openingExtreme),
    prior20BreakDirPct: direction * pct(row.c, prior20Extreme),
    directionalSessionPositionPct: directionalPosition,
    oppositePriorExtremeBufferPct: oppositeBuffer,
    priorDayRangePct: priorRanges.at(-1), prior2AverageRangePct: mean(priorRanges),
    atr14Pct: 100 * atr(current, index) / row.c,
    currentRangeVsPrior2Pct: 100 * currentRangePct / mean(priorRanges),
    cumulativeVolumeVsPrior2: currentCumulativeVolume / mean(priorSameTimeVolumes),
    window15VolumeVsPrior2: window15.reduce((sum, value) => sum + value.v, 0) / mean(priorWindowVolumes),
    signalVolumeVs20: row.v / mean(current.slice(-21, -1).map(value => value.v)),
    volume5VsPrevious5: last5.reduce((sum, value) => sum + value.v, 0) / (previous5.reduce((sum, value) => sum + value.v, 0) || 1),
    volume15VsPrevious15: window15.reduce((sum, value) => sum + value.v, 0) / (previous15.reduce((sum, value) => sum + value.v, 0) || 1),
    favorableVolumeShare15Pct: 100 * favorableVolume / (favorableVolume + adverseVolume || 1),
    favorableAdverseVolumeRatio15: mean(favorable.map(value => value.v)) / (mean(adverse.map(value => value.v)) || 1),
    directionalObvChange15: direction * (row.obv - current[index - 15].obv) / (avgPrior20Volume || 1),
    directionalPviChange15Pct: direction * pct(row.pvi, current[index - 15].pvi),
    directionalNviChange15Pct: direction * pct(row.nvi, current[index - 15].nvi),
    highVolumeCandles15: window15.filter(value => value.v > avgPrior20Volume).length,
    return5DirPct: direction * pct(last5.at(-1).c, last5[0].o), return15DirPct: stock15Return,
    return30DirPct: direction * pct(current.at(-1).c, current.at(-30).o),
    emaGapDirBps: direction * 10000 * (row.ema10 - row.ema20) / row.c,
    ema10Slope5DirPct: direction * pct(row.ema10, current[index - 5].ema10),
    ema20Slope5DirPct: direction * pct(row.ema20, current[index - 5].ema20),
    priceVsEma10DirPct: direction * pct(row.c, row.ema10), priceVsEma20DirPct: direction * pct(row.c, row.ema20),
    priceVsVwapDirPct: direction * pct(row.c, row.vwap), vwapSlope15DirPct: direction * pct(row.vwap, current[index - 15].vwap),
    macdDirBps: direction * 10000 * row.macd / row.c,
    macdSlope5DirBps: direction * 10000 * (row.macd - current[index - 5].macd) / row.c,
    rsi14Directional: signal.side === 'BUY' ? rsi(current, index) : 100 - rsi(current, index),
    adx14: di.adx, directionalDiSpread14: di.directionalDi,
    bollingerZDirectional: direction * (row.c - closeMean) / (closeStd || 1),
    regressionSlope15DirBps: direction * 10000 * regressionSlope(window15.map(value => value.c)) / row.c,
    efficiency15Directional: efficiency,
    favorableCandleShare15Pct: 100 * favorable.length / 15,
    favorableBodyDominance15: favorableBody / (adverseBody || 0.000001),
    signalCloseLocationDirectionalPct: signal.side === 'BUY' ? 100 * (row.c - row.l) / (row.h - row.l || 1) : 100 * (row.h - row.c) / (row.h - row.l || 1),
    directionalVwapHoldCount15: window15.filter(value => direction * (value.c - value.vwap) > 0).length,
    directionalHigherStructure: directionalStructure ? 1 : 0,
    maxDirectionalPullbackPct: pullback,
    nearDirectionalExtremeCloseCount15: window15.filter(value => signal.side === 'BUY' ? (value.c - value.l) / (value.h - value.l || 1) >= 0.7 : (value.h - value.c) / (value.h - value.l || 1) >= 0.7).length,
    maxFavorableCloseStreak15: maxStreak,
    momentumAccelerationDirPct: direction * pct(last5.at(-1).c, last5[0].o) - stock15Return / 3,
    niftyFromOpenDirPct: direction * pct(n.c, nifty[0].o),
    niftyReturn5DirPct: direction * pct(n.c, nifty.at(-5).o), niftyReturn15DirPct: nifty15Return,
    niftyEmaGapDirBps: direction * 10000 * (n.ema10 - n.ema20) / n.c,
    niftyEma10Slope5DirPct: direction * pct(n.ema10, nifty[ni - 5].ema10),
    niftySessionPositionDirectionalPct: niftyPosition,
    niftyRsiDirectional: signal.side === 'BUY' ? rsi(nifty, ni) : 100 - rsi(nifty, ni),
    niftyPriceVsMeanDirPct: direction * pct(n.c, n.vwap),
    niftyTrendAligned: direction * (n.ema10 - n.ema20) > 0 && direction * (n.c - n.vwap) > 0 ? 1 : 0,
    relativeStrengthFromOpenPct: direction * pct(row.c, current[0].o) - direction * pct(n.c, nifty[0].o),
    relativeStrength15Pct: stock15Return - nifty15Return,
    stockNiftyCorrelation30: correlation,
    niftyRangeToSignalPct: 100 * (niftyHigh - niftyLow) / nifty[0].o,
    niftyMacdDirBps: direction * 10000 * n.macd / n.c
  }
}

const niftyByDate = readCandles('NIFTY50', true)
const signalsBySymbol = new Map()
for (const signal of allSignals) {
  if (!signalsBySymbol.has(signal.symbol)) signalsBySymbol.set(signal.symbol, [])
  signalsBySymbol.get(signal.symbol).push(signal)
}

const rows = []
let completed = 0
for (const [symbol, symbolSignals] of signalsBySymbol) {
  const stockByDate = readCandles(symbol)
  const depthByDate = new Map(DATES.map(date => [date, readDepth(symbol, date)]))
  for (const signal of symbolSignals) {
    const candle = candleFeatureSet(signal, stockByDate, niftyByDate)
    if (!candle) continue
    const start = epochAt(DATE, signal.windowStartTime), end = epochAt(DATE, signal.actionableTime)
    const currentDepth = depthWindow(depthByDate.get(DATE), start, end, signal.side)
    if (!currentDepth) continue
    const priorDepth = PRIOR_DATES.map(date => depthWindow(depthByDate.get(date), epochAt(date, signal.windowStartTime), epochAt(date, signal.actionableTime), signal.side)).filter(Boolean)
    const depthHistory = {
      depthShareVsPrior2SameTimePp: currentDepth.directionalDepthShareMean - mean(priorDepth.map(value => value.directionalDepthShareMean)),
      depthOrderShareVsPrior2SameTimePp: currentDepth.directionalOrderShareMean - mean(priorDepth.map(value => value.directionalOrderShareMean)),
      spreadVsPrior2SameTimeRatio: currentDepth.spreadMeanBps / mean(priorDepth.map(value => value.spreadMeanBps))
    }
    const target = targetSet.has([signal.symbol, signal.side, signal.entryTime].join('|'))
    rows.push({
      symbol: signal.symbol, side: signal.side, signalTime: signal.signalCandleTime, entryTime: signal.entryTime,
      returnPct: signal.returnPct, target, ...Object.fromEntries(Object.entries({...candle, ...currentDepth, ...depthHistory}).map(([key, value]) => [key, round(value)]))
    })
  }
  completed++
  process.stdout.write(`\rAnalyzing ${completed}/${signalsBySymbol.size}: ${symbol} | rows ${rows.length}`.padEnd(90))
}
process.stdout.write('\n')

const targetRows = rows.filter(row => row.target), controlRows = rows.filter(row => !row.target)
function compareGroups(targetGroup, controlGroup, minimumTargets, minimumControls) {
  const result = []
  for (const [feature, [category, description]] of Object.entries(featureCatalog)) {
    const targetValues = targetGroup.map(row => row[feature]).filter(Number.isFinite)
    const controlValues = controlGroup.map(row => row[feature]).filter(Number.isFinite)
    if (targetValues.length < minimumTargets || controlValues.length < minimumControls) continue
    const targetMedian = median(targetValues), controlMedian = median(controlValues)
    const high = targetMedian >= controlMedian
    const threshold = high ? quantile(targetValues, 0.2) : quantile(targetValues, 0.8)
    const pass = value => high ? value >= threshold : value <= threshold
    const targetPass = targetValues.filter(pass).length, controlPass = controlValues.filter(pass).length
    const targetRate = 100 * targetPass / targetValues.length, controlRate = 100 * controlPass / controlValues.length
    result.push({
      feature, category, description, direction: high ? '>=' : '<=', threshold: round(threshold),
      targetCount: targetValues.length, targetPass, targetPassPct: round(targetRate, 1), targetMedian: round(targetMedian),
      controlCount: controlValues.length, controlPass, controlPassPct: round(controlRate, 1), controlMedian: round(controlMedian),
      separationPctPoints: round(targetRate - controlRate, 1), lift: round(targetRate / (controlRate || 0.0001), 2)
    })
  }
  return result.sort((a, b) => b.separationPctPoints - a.separationPctPoints || b.lift - a.lift)
}
const comparisons = compareGroups(targetRows, controlRows, 8, 20)
const buyComparisons = compareGroups(targetRows.filter(row => row.side === 'BUY'), controlRows.filter(row => row.side === 'BUY'), 7, 15)
const topSeparators = comparisons.filter(row => row.targetPass >= 8).slice(0, 20)
const topBuySeparators = buyComparisons.filter(row => row.targetPass >= 7).slice(0, 20)
const universal = comparisons.filter(row => row.targetPass === row.targetCount).sort((a, b) => a.controlPassPct - b.controlPassPct).slice(0, 20)

const output = {
  date: DATE,
  sessionsUsed: DATES,
  scope: 'Ten supplied successful signals versus all other signals passing the same frozen 29-rule screen on 2026-10-28.',
  causality: 'Every explanatory feature ends before entry. Prior-session data use 26-27 October; signal-session candles and depth end at the actionable time. Returns are used only to define the supplied target group.',
  warning: 'Thresholds below are descriptive and selected after observing these winners. They are hypotheses, not validated causal rules.',
  signalReport: path.relative(ROOT, signalReport),
  criteriaEvaluated: comparisons.length,
  targetRows: targetRows.length,
  controlRows: controlRows.length,
  topSeparators,
  topBuySeparators,
  buyFeatureComparisons: buyComparisons,
  universalTargetConditions: universal,
  featureComparisons: comparisons,
  rows
}

let sequence = 1, jsonFile, csvFile
do {
  const suffix = sequence === 1 ? '' : `-${sequence}`
  jsonFile = path.join(REPORTS, `${DATE}-selected-10-winner-driver-analysis${suffix}.json`)
  csvFile = path.join(REPORTS, `${DATE}-selected-10-winner-driver-features${suffix}.csv`)
  sequence++
} while (fs.existsSync(jsonFile) || fs.existsSync(csvFile))
fs.writeFileSync(jsonFile, `${JSON.stringify(output, null, 2)}\n`, {flag: 'wx'})

const columns = ['symbol', 'side', 'signalTime', 'entryTime', 'returnPct', 'target', ...Object.keys(featureCatalog)]
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
const csv = [columns.map(quote).join(','), ...rows.map(row => columns.map(column => quote(row[column])).join(','))].join('\n')
fs.writeFileSync(csvFile, `${csv}\n`, {flag: 'wx'})

console.log(`Criteria evaluated: ${comparisons.length}; targets: ${targetRows.length}; controls: ${controlRows.length}`)
console.log(`JSON: ${jsonFile}`)
console.log(`CSV:  ${csvFile}`)
console.table(topSeparators.map(row => ({
  Category: row.category, Criterion: row.description, Rule: `${row.direction} ${row.threshold}`,
  'Targets': `${row.targetPass}/${row.targetCount}`, 'Others': `${row.controlPass}/${row.controlCount}`,
  'Target med': row.targetMedian, 'Other med': row.controlMedian, 'Separation pp': row.separationPctPoints
})))
console.log('BUY-only comparison (9 supplied winners versus other BUY signals):')
console.table(topBuySeparators.map(row => ({
  Category: row.category, Criterion: row.description, Rule: `${row.direction} ${row.threshold}`,
  'Targets': `${row.targetPass}/${row.targetCount}`, 'Others': `${row.controlPass}/${row.controlCount}`,
  'Target med': row.targetMedian, 'Other med': row.controlMedian, 'Separation pp': row.separationPctPoints
})))
