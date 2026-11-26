import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const MINUTE = 60_000
const IST_OFFSET = 330 * MINUTE
const SESSION_OPEN_MINUTE = 9 * 60 + 15
const SESSION_CLOSE_MINUTE = 15 * 60 + 30
const APPLY_DRIVER_FILTER = !process.argv.includes('--no-driver-filter')

const RULES = [
  ['directionalEmaGapAtSignalBps', '>=', 5.112],
  ['startMinute', '>=', 615],
  ['directionalOrderShareMean', '>=', 44.4815],
  ['favorableBodyToAdverseBodyRatio', '>=', 1.075],
  ['spreadMaxBps', '>=', 5.0168],
  ['oppositeSizeLateVsEarlyPct', '<=', 85.3035],
  ['directionalShareMax', '>=', 77.4477],
  ['directionalShareMax', '<=', 97.2868],
  ['snapshots', '<=', 1190],
  ['oppositeSizeLateVsEarlyPct', '>=', -45.463],
  ['favorableVolumeSharePct', '>=', 44.075],
  ['directionalVwapChangePct', '>=', -0.035],
  ['directionalShareMedian', '>=', 34.1912],
  ['directionalBookRatioLateVsEarly', '>=', -1.1152],
  ['confirmationDirectionalVolumeRatio', '<=', 6.193],
  ['maxDirectionalPullbackPct', '<=', -0.18],
  ['directionalConfirmationReturnPct', '>=', -0.012],
  ['directionalEmaGapAtCrossBps', '<=', 5.042],
  ['directionalShareStd', '>=', 10.8103],
  ['directionalShareLast', '>=', 20.7767],
  ['directionalShareDelta', '<=', 35.0465],
  ['favorableBodyToAdverseBodyRatio', '<=', 6.679],
  ['nearFavorableExtremeCloseCount', '<=', 11],
  ['directionalEmaGapAtCrossBps', '>=', 0.04],
  ['directionalShareP75', '<=', 82.1429],
  ['directionalShareLast', '<=', 79.2995],
  ['directionalShareLateVsEarly', '<=', 19.7856],
  ['directionalTopShareMean', '>=', 35.6378],
  ['directionalSizeLateVsEarlyPct', '>=', -46.8994]
].map(([feature, op, threshold]) => ({feature, op, threshold}))

function usage(message) {
  if (message) console.error(message)
  console.error('Usage: node scripts/backtest-fixed-29-filters-cutoff.js <YYYY-MM-DD> <HH:MM>')
  console.error('Example: node scripts/backtest-fixed-29-filters-cutoff.js 2026-10-28 12:00')
  process.exit(1)
}

const positional = process.argv.slice(2).filter(value => !value.startsWith('--'))
let date = positional[0]
let cutoffTime = positional[1]
if (date?.includes('T') && !cutoffTime) [date, cutoffTime] = date.split('T')
if (date?.includes(' ') && !cutoffTime) [date, cutoffTime] = date.split(/\s+/)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(cutoffTime ?? '')) usage('Invalid cutoff date/time.')

const [cutoffHour, cutoffMinuteValue] = cutoffTime.split(':').map(Number)
if (cutoffHour > 23 || cutoffMinuteValue > 59) usage('Invalid cutoff time.')
const cutoffEpoch = Date.parse(`${date}T${cutoffTime}:00+05:30`)
if (!Number.isFinite(cutoffEpoch)) usage('Could not parse cutoff date/time.')

const depthRoot = path.join(ROOT, 'db', 'cash-depth')
const priorDates = fs.existsSync(depthRoot)
  ? fs.readdirSync(depthRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < date)
    .map(entry => entry.name).sort().slice(-2)
  : []
if (priorDates.length < 2) throw new Error(`Two prior stored sessions are required before ${date}.`)
const sessionDates = [...priorDates, date]

const day = epoch => new Date(epoch + IST_OFFSET).toISOString().slice(0, 10)
const clock = epoch => new Date(epoch + IST_OFFSET).toISOString().slice(11, 16)
const minuteOfDay = epoch => {
  const value = new Date(epoch + IST_OFFSET)
  return value.getUTCHours() * 60 + value.getUTCMinutes()
}
const pct = (value, base) => 100 * (value / base - 1)
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN
const round = (value, places = 3) => Number.isFinite(value) ? +value.toFixed(places) : null
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * fraction)] : NaN
}
const std = values => {
  const average = mean(values)
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)))
}
const normalizeSymbol = value => String(value).trim().toUpperCase().replace(/-EQ$/, '')
const readJsonLines = filename => {
  if (!fs.existsSync(filename)) return []
  const rows = []
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    try { rows.push(JSON.parse(line)) } catch { /* Skip damaged lines. */ }
  }
  return rows
}

function readCandleSessions(symbol, allowZeroVolume = false) {
  const sessions = new Map(sessionDates.map(sessionDate => [sessionDate, []]))
  for (const record of readJsonLines(path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`))) {
    const epoch = Number(record.time) * 1000
    const open = Number(record.open), high = Number(record.high), low = Number(record.low)
    const close = Number(record.close), volume = Number(record.volume)
    const sessionDate = day(epoch)
    if (!Number.isFinite(epoch) || !sessions.has(sessionDate)) continue
    if (![open, high, low, close, volume].every(Number.isFinite) || (!allowZeroVolume && volume <= 0)) continue
    const sessionMinute = minuteOfDay(epoch)
    if (sessionMinute < SESSION_OPEN_MINUTE || sessionMinute >= SESSION_CLOSE_MINUTE) continue
    sessions.get(sessionDate).push({t: epoch, o: open, h: high, l: low, c: close, v: volume})
  }
  for (const [sessionDate, rows] of sessions) {
    rows.sort((a, b) => a.t - b.t)
    sessions.set(sessionDate, rows.filter((row, index) => index === 0 || row.t !== rows[index - 1].t))
  }
  return sessions
}

function enrichCandles(rows) {
  let ema10, ema20, ema12, ema26, pvi = 1000, priceVolume = 0, totalVolume = 0
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    ema10 = ema10 == null ? row.c : ema10 + 2 / 11 * (row.c - ema10)
    ema20 = ema20 == null ? row.c : ema20 + 2 / 21 * (row.c - ema20)
    ema12 = ema12 == null ? row.c : ema12 + 2 / 13 * (row.c - ema12)
    ema26 = ema26 == null ? row.c : ema26 + 2 / 27 * (row.c - ema26)
    if (index && row.v > rows[index - 1].v) pvi *= row.c / rows[index - 1].c
    priceVolume += ((row.h + row.l + row.c) / 3) * row.v
    totalVolume += row.v
    Object.assign(row, {e10: ema10, e20: ema20, macd: ema12 - ema26, pvi, pv: priceVolume, vv: totalVolume})
  }
}

function rsi14(rows, endIndex) {
  if (endIndex < 14) return NaN
  let gains = 0, losses = 0
  for (let index = endIndex - 13; index <= endIndex; index++) {
    const change = rows[index].c - rows[index - 1].c
    if (change > 0) gains += change; else losses -= change
  }
  if (losses === 0) return 100
  return 100 - 100 / (1 + gains / losses)
}

function sessionRangePct(rows) {
  if (!rows.length) return NaN
  return 100 * (Math.max(...rows.map(row => row.h)) - Math.min(...rows.map(row => row.l))) / rows[0].o
}

function candleFeatures(rows, crossIndex, side) {
  const window = rows.slice(crossIndex + 1, crossIndex + 16)
  if (crossIndex < 20 || window.length !== 15) return null
  if (window.some((row, index) => index && row.t !== window[index - 1].t + MINUTE)) return null

  const direction = side === 'BUY' ? 1 : -1
  const cross = rows[crossIndex]
  const prior = rows.slice(0, crossIndex + 1)
  const priorHigh = Math.max(...prior.slice(-20).map(row => row.h))
  const green = window.filter(row => row.c > row.o)
  const red = window.filter(row => row.c < row.o)
  const favorable = side === 'BUY' ? green : red
  const adverse = side === 'BUY' ? red : green
  const favorableBody = favorable.reduce((sum, row) => sum + Math.abs(row.c - row.o), 0)
  const adverseBody = adverse.reduce((sum, row) => sum + Math.abs(row.c - row.o), 0)
  const favorableVolumeMean = mean(favorable.map(row => row.v))
  const adverseVolumeMean = mean(adverse.map(row => row.v))
  let favorableExtreme = window[0].o, pullback = 0
  for (const row of window) {
    if (side === 'BUY') {
      favorableExtreme = Math.max(favorableExtreme, row.h)
      pullback = Math.min(pullback, pct(row.l, favorableExtreme))
    } else {
      favorableExtreme = Math.min(favorableExtreme, row.l)
      pullback = Math.min(pullback, pct(favorableExtreme, row.h))
    }
  }
  const end = window.at(-1)
  const high = Math.max(...window.map(row => row.h))
  const low = Math.min(...window.map(row => row.l))
  const entry = window[0].o
  const totalWindowVolume = window.reduce((sum, row) => sum + row.v, 0)
  const firstHalf = window.slice(0, 7), secondHalf = window.slice(7)
  const directionalHigherStructure = side === 'BUY'
    ? Math.max(...secondHalf.map(row => row.h)) > Math.max(...firstHalf.map(row => row.h)) && Math.min(...secondHalf.map(row => row.l)) > Math.min(...firstHalf.map(row => row.l))
    : Math.min(...secondHalf.map(row => row.l)) < Math.min(...firstHalf.map(row => row.l)) && Math.max(...secondHalf.map(row => row.h)) < Math.max(...firstHalf.map(row => row.h))
  let streak = 0, maxFavorableCloseStreak15 = 0
  for (const row of window) {
    streak = direction * (row.c - row.o) > 0 ? streak + 1 : 0
    maxFavorableCloseStreak15 = Math.max(maxFavorableCloseStreak15, streak)
  }

  return {
    confirmationIndex: crossIndex + 15,
    startMinute: minuteOfDay(window[0].t),
    maxDirectionalPullbackPct: round(pullback),
    confirmationDirectionalVolumeRatio: round(favorableVolumeMean / (adverseVolumeMean || 1)),
    directionalConfirmationReturnPct: round(direction * pct(end.c, entry)),
    confirmationMfePct: round(pct(high, entry)),
    confirmationMaePct: round(pct(low, entry)),
    favorableBodyToAdverseBodyRatio: round(favorableBody / (adverseBody || 0.000001)),
    nearFavorableExtremeCloseCount: window.filter(row => side === 'BUY'
      ? (row.c - row.l) / (row.h - row.l || 1) >= 0.7
      : (row.h - row.c) / (row.h - row.l || 1) >= 0.7).length,
    favorableVolumeSharePct: round(100 * favorable.reduce((sum, row) => sum + row.v, 0) / totalWindowVolume),
    maxFavorableCloseStreak15,
    directionalVwapHoldCount15: window.filter(row => direction * (row.c - row.pv / row.vv) > 0).length,
    directionalHigherStructure: directionalHigherStructure ? 1 : 0,
    favorableAdverseVolumeRatio15: round(favorableVolumeMean / (adverseVolumeMean || 1)),
    directionalPviChange15Pct: round(direction * pct(end.pvi, cross.pvi)),
    priceVsEma10DirPct: round(direction * pct(end.c, end.e10)),
    priceVsEma20DirPct: round(direction * pct(end.c, end.e20)),
    priceVsVwapDirPct: round(direction * pct(end.c, end.pv / end.vv)),
    breakoutCloseCount: window.filter(row => row.c > priorHigh).length,
    directionalVwapChangePct: round(direction * pct(end.pv / end.vv, cross.pv / cross.vv)),
    directionalEmaGapAtCrossBps: round(direction * 10000 * (cross.e10 - cross.e20) / cross.c),
    directionalEmaGapAtSignalBps: round(direction * 10000 * (end.e10 - end.e20) / end.c)
  }
}

function readDepth(symbol) {
  const filename = path.join(ROOT, 'db', 'cash-depth', date, symbol, `${symbol}.jsonl`)
  const output = [], state = {}
  for (const event of readJsonLines(filename)) {
    const epoch = Date.parse(event.receivedAt)
    if (!Number.isFinite(epoch) || day(epoch) !== date) continue
    if (event.kind === 'checkpoint') for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, event.data ?? {})
    let bidSize = 0, askSize = 0, bidOrders = 0, askOrders = 0, valid = true
    for (let level = 1; level <= 5; level++) {
      const bidPrice = Number(state[`bid_price${level}`]), askPrice = Number(state[`ask_price${level}`])
      const bid = Number(state[`bid_size${level}`]), ask = Number(state[`ask_size${level}`])
      const bidOrder = Number(state[`bid_order${level}`]), askOrder = Number(state[`ask_order${level}`])
      if (![bidPrice, askPrice, bid, ask].every(Number.isFinite) || askPrice <= bidPrice) { valid = false; break }
      bidSize += bid; askSize += ask
      if (Number.isFinite(bidOrder)) bidOrders += bidOrder
      if (Number.isFinite(askOrder)) askOrders += askOrder
    }
    if (!valid || bidSize + askSize <= 0) continue
    const bidPrice1 = Number(state.bid_price1), askPrice1 = Number(state.ask_price1)
    const bidSize1 = Number(state.bid_size1), askSize1 = Number(state.ask_size1)
    const midpoint = (bidPrice1 + askPrice1) / 2
    output.push({
      t: epoch,
      bidShare: 100 * bidSize / (bidSize + askSize),
      topBidShare: 100 * bidSize1 / (bidSize1 + askSize1 || 1),
      orderBidShare: 100 * bidOrders / (bidOrders + askOrders || 1),
      spreadBps: 10000 * (askPrice1 - bidPrice1) / midpoint,
      bidSize,
      askSize
    })
  }
  return output
}

function depthFeatures(rows, startEpoch, endEpoch, side) {
  const window = rows.filter(row => row.t >= startEpoch && row.t < endEpoch)
  if (window.length < 5) return null
  const directionalShares = window.map(row => side === 'BUY' ? row.bidShare : 100 - row.bidShare)
  const directionalTopShares = window.map(row => side === 'BUY' ? row.topBidShare : 100 - row.topBidShare)
  const directionalOrderShares = window.map(row => side === 'BUY' ? row.orderBidShare : 100 - row.orderBidShare)
  const third = Math.max(1, Math.floor(window.length / 3))
  const early = window.slice(0, third), late = window.slice(-third)
  const directionalSize = row => side === 'BUY' ? row.bidSize : row.askSize
  const oppositeSize = row => side === 'BUY' ? row.askSize : row.bidSize
  const directionalRatio = row => directionalSize(row) / oppositeSize(row)
  const feature = {
    snapshots: window.length,
    directionalShareMean: mean(directionalShares),
    directionalShareMedian: quantile(directionalShares, 0.5),
    directionalShareMax: Math.max(...directionalShares),
    directionalShareP75: quantile(directionalShares, 0.75),
    directionalShareStd: std(directionalShares),
    directionalShareLast: directionalShares.at(-1),
    directionalShareDelta: directionalShares.at(-1) - directionalShares[0],
    directionalShareLateVsEarly: mean(late.map(row => side === 'BUY' ? row.bidShare : 100 - row.bidShare)) - mean(early.map(row => side === 'BUY' ? row.bidShare : 100 - row.bidShare)),
    directionalShareAbove50Pct: 100 * directionalShares.filter(value => value > 50).length / directionalShares.length,
    directionalTopShareMean: mean(directionalTopShares),
    directionalOrderShareMean: mean(directionalOrderShares),
    spreadMaxBps: Math.max(...window.map(row => row.spreadBps)),
    directionalSizeLateVsEarlyPct: 100 * (mean(late.map(directionalSize)) / mean(early.map(directionalSize)) - 1),
    oppositeSizeLateVsEarlyPct: 100 * (mean(late.map(oppositeSize)) / mean(early.map(oppositeSize)) - 1),
    directionalBookRatioLateVsEarly: mean(late.map(directionalRatio)) - mean(early.map(directionalRatio))
  }
  return Object.fromEntries(Object.entries(feature).map(([key, value]) => [key, round(value, 4)]))
}

function passesAllRules(row) {
  return RULES.every(rule => {
    const value = row[rule.feature]
    if (!Number.isFinite(value)) return false
    return rule.op === '>=' ? value >= rule.threshold : value <= rule.threshold
  })
}

function evaluateDriverProfile(side, combined, candles, signalIndex, priorSessions, niftyRows) {
  const direction = side === 'BUY' ? 1 : -1
  const signal = candles[signalIndex]
  const currentToSignal = candles.slice(0, signalIndex + 1)
  const priorClose = priorSessions.at(-1).at(-1)?.c
  const priorAverageRange = mean(priorSessions.map(sessionRangePct))
  const currentRangePct = sessionRangePct(currentToSignal)
  let niftyIndex = niftyRows.findIndex(row => row.t === signal.t)
  if (niftyIndex < 0) niftyIndex = niftyRows.findLastIndex(row => row.t <= signal.t)
  const nifty15 = niftyIndex >= 14 ? niftyRows.slice(niftyIndex - 14, niftyIndex + 1) : []
  const nifty = niftyRows[niftyIndex]
  const metrics = {
    openingGapDirPct: direction * pct(candles[0].o, priorClose),
    currentRangeVsPrior2Pct: 100 * currentRangePct / priorAverageRange,
    niftyRsiDirectional: nifty ? (side === 'BUY' ? rsi14(niftyRows, niftyIndex) : 100 - rsi14(niftyRows, niftyIndex)) : NaN,
    niftyReturn15DirPct: nifty15.length === 15 ? direction * pct(nifty15.at(-1).c, nifty15[0].o) : NaN,
    niftyEma10Slope5DirPct: niftyIndex >= 5 ? direction * pct(nifty.e10, niftyRows[niftyIndex - 5].e10) : NaN,
    niftyFromOpenDirPct: nifty ? direction * pct(nifty.c, niftyRows[0].o) : NaN
  }

  const buyRules = [
    ['depthMax90', combined.directionalShareMax >= 90.4793],
    ['adverseOpeningGap', metrics.openingGapDirPct <= -0.2382],
    ['niftyRsiNotExtended', metrics.niftyRsiDirectional <= 63.41],
    ['intradayRangeExpanded', metrics.currentRangeVsPrior2Pct >= 65.0548],
    ['fourFavorableCandleStreak', combined.maxFavorableCloseStreak15 >= 4],
    ['depthMeanAbove50', combined.directionalShareMean >= 50.7151],
    ['depthMedianNear50', combined.directionalShareMedian >= 49.4897],
    ['depthDominantHalfWindow', combined.directionalShareAbove50Pct >= 48.7639],
    ['nifty15NotOverextended', metrics.niftyReturn15DirPct <= 0.133],
    ['niftyEmaSlopeModerate', metrics.niftyEma10Slope5DirPct <= 0.0405]
  ]
  const sellRules = [
    ['belowDirectionalEma10', combined.priceVsEma10DirPct > 0],
    ['belowDirectionalEma20', combined.priceVsEma20DirPct > 0],
    ['belowDirectionalVwap', combined.priceVsVwapDirPct > 0],
    ['directionalVwapHold', combined.directionalVwapHoldCount15 >= 12],
    ['directionalStructure', combined.directionalHigherStructure === 1],
    ['directionalVolumeDominance', combined.favorableAdverseVolumeRatio15 >= 1],
    ['directionalPviRising', combined.directionalPviChange15Pct > 0],
    ['niftyAlignedFromOpen', metrics.niftyFromOpenDirPct > 0]
  ]
  const rules = side === 'BUY' ? buyRules : sellRules
  const score = rules.filter(([, passed]) => passed).length
  return {
    driverProfile: side === 'BUY' ? 'BUY_WINNER_10' : 'SELL_STRUCTURE_DIAGNOSTIC_8',
    driverScore: score,
    driverRuleCount: rules.length,
    driverPassed: side === 'BUY' ? score >= 6 : true,
    driverFailedRules: rules.filter(([, passed]) => !passed).map(([name]) => name).join('|'),
    ...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, round(value, 4)]))
  }
}

function outcome(rows, entryIndex, side) {
  let oppositeCrossIndex = -1
  for (let index = entryIndex; index < rows.length; index++) {
    const crossedAgainstTrade = side === 'BUY'
      ? rows[index - 1].e10 >= rows[index - 1].e20 && rows[index].e10 < rows[index].e20
      : rows[index - 1].e10 <= rows[index - 1].e20 && rows[index].e10 > rows[index].e20
    if (index && crossedAgainstTrade) {
      oppositeCrossIndex = index
      break
    }
  }
  let exitIndex = oppositeCrossIndex >= 0 ? oppositeCrossIndex + 1 : -1
  let exitReason = side === 'BUY' ? 'EMA10_CROSSED_BELOW_EMA20' : 'EMA10_CROSSED_ABOVE_EMA20'
  if (exitIndex < 0 || exitIndex >= rows.length) {
    exitIndex = rows.length - 1
    exitReason = 'EOD_MARK_NO_EXECUTABLE_CROSS'
  }
  const entry = rows[entryIndex], exit = rows[exitIndex]
  const pathRows = rows.slice(entryIndex, exitIndex + 1)
  const exitPrice = exitReason.startsWith('EMA') ? exit.o : exit.c
  const tradeReturn = side === 'BUY' ? pct(exitPrice, entry.o) : 100 * (entry.o - exitPrice) / entry.o
  const favorable = side === 'BUY'
    ? pct(Math.max(...pathRows.map(row => row.h)), entry.o)
    : 100 * (entry.o - Math.min(...pathRows.map(row => row.l))) / entry.o
  const adverse = side === 'BUY'
    ? pct(Math.min(...pathRows.map(row => row.l)), entry.o)
    : 100 * (entry.o - Math.max(...pathRows.map(row => row.h))) / entry.o
  return {
    entryTime: clock(entry.t),
    entryPrice: round(entry.o),
    emaOppositeCrossTime: oppositeCrossIndex >= 0 ? clock(rows[oppositeCrossIndex].t) : '',
    exitTime: clock(exit.t),
    exitPrice: round(exitPrice),
    exitReason,
    holdMinutes: (exit.t - entry.t) / MINUTE,
    returnPct: round(tradeReturn),
    maximumFavorableExcursionPct: round(favorable),
    maximumAdverseExcursionPct: round(adverse)
  }
}

const stockFile = path.join(ROOT, 'db', 'stocks')
if (!fs.existsSync(stockFile)) throw new Error(`Missing stock universe: ${stockFile}`)
const symbols = [...new Set(JSON.parse(fs.readFileSync(stockFile, 'utf8')).map(normalizeSymbol))]
const niftySessions = readCandleSessions('NIFTY50', true)
const niftyCandles = niftySessions.get(date) ?? []
enrichCandles(niftyCandles)
const baseSignals = []
let crossCandidates = 0, buyCrossCandidates = 0, sellCrossCandidates = 0
let candidatesByCutoff = 0, candidatesWithDepth = 0

for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex++) {
  const symbol = symbols[symbolIndex]
  const candleSessions = readCandleSessions(symbol)
  const candles = candleSessions.get(date) ?? []
  const priorSessions = priorDates.map(priorDate => candleSessions.get(priorDate) ?? [])
  if (candles.length >= 37 && priorSessions.every(rows => rows.length)) {
    enrichCandles(candles)
    const candidates = []
    for (let crossIndex = 20; crossIndex + 16 < candles.length; crossIndex++) {
      const bullish = candles[crossIndex - 1].e10 <= candles[crossIndex - 1].e20 && candles[crossIndex].e10 > candles[crossIndex].e20
      const bearish = candles[crossIndex - 1].e10 >= candles[crossIndex - 1].e20 && candles[crossIndex].e10 < candles[crossIndex].e20
      const side = bullish ? 'BUY' : bearish ? 'SELL' : null
      if (!side) continue
      crossCandidates++
      if (side === 'BUY') buyCrossCandidates++; else sellCrossCandidates++
      const candle = candleFeatures(candles, crossIndex, side)
      if (!candle) continue
      const signal = candles[candle.confirmationIndex]
      const entryIndex = candle.confirmationIndex + 1
      const entry = candles[entryIndex]
      if (entry.t !== signal.t + MINUTE || entry.t > cutoffEpoch) continue
      candidatesByCutoff++
      candidates.push({side, crossIndex, entryIndex, signal, candle})
    }
    if (candidates.length) {
      const depth = readDepth(symbol)
      for (const candidate of candidates) {
        const depthValues = depthFeatures(depth, candles[candidate.crossIndex + 1].t, candidate.signal.t + MINUTE, candidate.side)
        if (!depthValues) continue
        candidatesWithDepth++
        const combined = {...candidate.candle, ...depthValues}
        if (!passesAllRules(combined)) continue
        const driver = evaluateDriverProfile(candidate.side, combined, candles, candidate.candle.confirmationIndex, priorSessions, niftyCandles)
        baseSignals.push({
          date,
          symbol,
          side: candidate.side,
          crossoverTime: clock(candles[candidate.crossIndex].t),
          windowStartTime: clock(candles[candidate.crossIndex + 1].t),
          signalCandleTime: clock(candidate.signal.t),
          actionableTime: clock(candidate.signal.t + MINUTE),
          ...driver,
          ...outcome(candles, candidate.entryIndex, candidate.side)
        })
      }
    }
  }
  const progress = `Scanning ${symbolIndex + 1}/${symbols.length}: ${symbol} | BUY ${baseSignals.filter(row => row.side === 'BUY').length} SELL ${baseSignals.filter(row => row.side === 'SELL').length}`
  process.stdout.write(`\r${progress.padEnd(85)}`)
}
process.stdout.write('\n')

const signals = APPLY_DRIVER_FILTER ? baseSignals.filter(row => row.driverPassed) : baseSignals
signals.sort((a, b) => a.actionableTime.localeCompare(b.actionableTime) || a.symbol.localeCompare(b.symbol))
const returns = signals.map(row => row.returnPct)
const totalReturn = returns.reduce((sum, value) => sum + value, 0)
const sideSummary = side => {
  const rows = signals.filter(row => row.side === side)
  const values = rows.map(row => row.returnPct)
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    tradeCount: rows.length,
    winCount: rows.filter(row => row.returnPct > 0).length,
    lossCount: rows.filter(row => row.returnPct <= 0).length,
    winRatePct: round(100 * rows.filter(row => row.returnPct > 0).length / (rows.length || 1)),
    averageReturnPct: round(mean(values)),
    totalReturnPct: round(total),
    maximumAdverseExcursionPct: rows.length ? round(Math.min(...rows.map(row => row.maximumAdverseExcursionPct))) : null
  }
}
const summary = {
  stocksScanned: symbols.length,
  crossCandidates,
  buyCrossCandidates,
  sellCrossCandidates,
  candidatesActionableByCutoff: candidatesByCutoff,
  candidatesWithDepth: candidatesWithDepth,
  base29RuleSignals: baseSignals.length,
  base29BuySignals: baseSignals.filter(row => row.side === 'BUY').length,
  base29SellSignals: baseSignals.filter(row => row.side === 'SELL').length,
  driverFilterApplied: APPLY_DRIVER_FILTER,
  driverFilteredOut: baseSignals.length - signals.length,
  tradeCount: signals.length,
  winCount: signals.filter(row => row.returnPct > 0).length,
  lossCount: signals.filter(row => row.returnPct <= 0).length,
  winRatePct: round(100 * signals.filter(row => row.returnPct > 0).length / (signals.length || 1)),
  averageReturnPct: round(mean(returns)),
  totalReturnPct: round(totalReturn),
  maximumAdverseExcursionPct: signals.length ? round(Math.min(...signals.map(row => row.maximumAdverseExcursionPct))) : null,
  worstDay: {date, totalReturnPct: round(totalReturn)},
  worstTrade: signals.length ? [...signals].sort((a, b) => a.returnPct - b.returnPct)[0] : null,
  bySide: {BUY: sideSummary('BUY'), SELL: sideSummary('SELL')}
}

const output = {
  cutoff: `${date} ${cutoffTime} IST`,
  priorSessionsUsed: priorDates,
  methodology: `Frozen 29-rule chronological replay in both directions. BUY starts after EMA10 crosses above EMA20; SELL starts after EMA10 crosses below EMA20. The next 15 completed candles form the confirmation window. ${APPLY_DRIVER_FILTER ? 'BUY additionally requires at least 6 of the 10 post-analysis driver conditions; SELL keeps the original 29-rule selection because its eight-condition profile was not discriminative.' : 'The optional post-analysis BUY driver filter is disabled.'} Only signals actionable by the cutoff are accepted. Entry is the following candle open; exit is the next open after the opposite EMA crossover, otherwise the final available close. Zero-volume candles are excluded.`,
  sellMirroring: 'SELL reverses every directional input: red replaces green, falling replaces rising, ask-side share/size/order depth replaces bid-side depth, and bid-side size becomes the opposite side. Time, spread and snapshot-count rules are unchanged.',
  causality: 'Candle and depth filters use no records at or after the actionable time. Post-cutoff candles may be used only to measure the historical trade outcome.',
  warning: 'The 29 thresholds were fitted on the 2026-10-28 target examples and are not out-of-sample validated.',
  driverWarning: 'The BUY driver score was also discovered on 2026-10-28 and is in-sample. SELL structure score is diagnostic only and does not filter SELL signals.',
  driverFilter: {
    enabled: APPLY_DRIVER_FILTER,
    buyRule: 'Pass at least 6 of 10 conditions',
    sellRule: 'Diagnostic score only; all original 29-rule SELL signals retained',
    disableFlag: '--no-driver-filter'
  },
  rules: RULES,
  summary,
  signals
}

const cutoffStem = cutoffTime.replace(':', '')
const base = `${date}-${cutoffStem}-fixed-29-filter-chronological-${APPLY_DRIVER_FILTER ? 'driver' : 'all29'}`
let sequence = 1, jsonFile, csvFile
do {
  const suffix = sequence === 1 ? '' : `-${sequence}`
  jsonFile = path.join(ROOT, 'reports', `${base}${suffix}.json`)
  csvFile = path.join(ROOT, 'reports', `${base}${suffix}.csv`)
  sequence++
} while (fs.existsSync(jsonFile) || fs.existsSync(csvFile))

fs.writeFileSync(jsonFile, `${JSON.stringify(output, null, 2)}\n`, {flag: 'wx'})
const columns = ['date', 'symbol', 'side', 'crossoverTime', 'windowStartTime', 'signalCandleTime', 'actionableTime', 'driverProfile', 'driverScore', 'driverRuleCount', 'driverPassed', 'driverFailedRules', 'entryTime', 'entryPrice', 'emaOppositeCrossTime', 'exitTime', 'exitPrice', 'exitReason', 'holdMinutes', 'returnPct', 'maximumFavorableExcursionPct', 'maximumAdverseExcursionPct']
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`
const csv = [columns.map(quote).join(','), ...signals.map(row => columns.map(column => quote(row[column])).join(','))].join('\n')
fs.writeFileSync(csvFile, `${csv}\n`, {flag: 'wx'})

console.log(`Cutoff: ${output.cutoff}`)
console.log(`JSON: ${jsonFile}`)
console.log(`CSV:  ${csvFile}`)
console.table([{
  Stocks: summary.stocksScanned,
  Candidates: summary.candidatesActionableByCutoff,
  'With depth': summary.candidatesWithDepth,
  'Base 29': summary.base29RuleSignals,
  'Driver removed': summary.driverFilteredOut,
  Signals: summary.tradeCount,
  Wins: summary.winCount,
  Losses: summary.lossCount,
  'Win rate %': summary.winRatePct,
  'Average %': summary.averageReturnPct,
  'Total %': summary.totalReturnPct,
  'Worst MAE %': summary.maximumAdverseExcursionPct
}])
console.table(['BUY', 'SELL'].map(side => ({
  Side: side,
  Signals: summary.bySide[side].tradeCount,
  Wins: summary.bySide[side].winCount,
  Losses: summary.bySide[side].lossCount,
  'Win rate %': summary.bySide[side].winRatePct,
  'Average %': summary.bySide[side].averageReturnPct,
  'Total %': summary.bySide[side].totalReturnPct,
  'Worst MAE %': summary.bySide[side].maximumAdverseExcursionPct
})))

if (signals.length) {
  console.table(signals.map(row => ({
    Stock: row.symbol,
    Side: row.side,
    Cross: row.crossoverTime,
    Window: row.windowStartTime,
    Signal: row.signalCandleTime,
    Actionable: row.actionableTime,
    Driver: `${row.driverScore}/${row.driverRuleCount}`,
    Entry: row.entryTime,
    Exit: row.exitTime,
    'Return %': row.returnPct,
    'MFE %': row.maximumFavorableExcursionPct,
    'MAE %': row.maximumAdverseExcursionPct
  })))
} else {
  console.log('No signals passed all 29 filters by the cutoff.')
}
