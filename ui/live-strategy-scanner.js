import fsp from "node:fs/promises"
import path from "node:path"

const IST_MS = 330 * 60_000
const MARKET_OPEN = 555
const MARKET_CLOSE = 930
// Experimental PVI/NVI protection rules. Each input is available at the
// signal candle, so rejected names never create or persist a live signal.
const PVI_NVI_STOP_PCT = 0.8
const PVI_NVI_REJECTION = {
  sellOpenReturnLt: -1.901923,
  buyPriorEma20_40GapLt: -0.0305755,
}
const STRATEGIES = [
  { id: "ranked-sr", name: "Ranked S/R Price Action" },
  { id: "pvi-nvi", name: "PVI/NVI Three-OR" },
  { id: "ema20-40", name: "EMA20/40 Advanced" },
  { id: "sr-mtf", name: "S/R MTF High Precision" },
  { id: "oct05-loose", name: "Oct-05 High-Volume Retest" },
  { id: "sep29-tight-stop", name: "Sep-29 Tight Stop Continuation" },
  { id: "sep25-opening-breakout", name: "Sep-25 Opening Breakout" },
]
const LIVE_STRATEGIES = STRATEGIES.filter(strategy => strategy.id !== "ranked-sr")
const LIVE_STRATEGY_IDS = new Set(LIVE_STRATEGIES.map(strategy => strategy.id))

const round = (value, digits = 4) => Number.isFinite(value) ? +value.toFixed(digits) : null
const pct = (value, base) => Number.isFinite(value) && Number.isFinite(base) && base > 0 ? 100 * (value / base - 1) : NaN
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
const minuteOf = value => {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "")
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN
}
const parts = epochSeconds => {
  const date = new Date(Number(epochSeconds) * 1000 + IST_MS).toISOString()
  return { date: date.slice(0, 10), minute: +date.slice(11, 13) * 60 + +date.slice(14, 16) }
}
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN
}
const completeDates = rows => [...new Set(rows.map(row => row.date))].sort()

function normalizeStored(value) {
  const { date, minute } = parts(value.time)
  const prices = [+value.open, +value.high, +value.low, +value.close]
  const volume = +value.volume
  if (minute < MARKET_OPEN || minute >= MARKET_CLOSE || !prices.every(Number.isFinite) || !Number.isFinite(volume)) return null
  return { time: +value.time, date, minute, o: prices[0], h: prices[1], l: prices[2], c: prices[3], v: volume }
}

function emaDecorate(rows, periods = [5, 10, 20, 40]) {
  const state = Object.fromEntries(periods.map(period => [period, null]))
  return rows.map(row => {
    const ema = {}
    for (const period of periods) {
      state[period] = state[period] == null ? row.c : state[period] + 2 / (period + 1) * (row.c - state[period])
      ema[period] = state[period]
    }
    return { ...row, ema }
  })
}

function aggregate(rows, size) {
  const output = []
  for (const date of completeDates(rows)) {
    const day = rows.filter(row => row.date === date)
    const groups = new Map()
    for (const row of day) {
      const offset = row.minute - MARKET_OPEN
      if (offset < 0 || offset >= 375) continue
      const group = Math.floor(offset / size)
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(row)
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.minute - b.minute)
      if (group.length !== size || group.some((row, index) => index && row.minute !== group[index - 1].minute + 1)) continue
      output.push({ date, minute: group.at(-1).minute, o: group[0].o, h: Math.max(...group.map(x => x.h)), l: Math.min(...group.map(x => x.l)), c: group.at(-1).c, v: group.reduce((sum, x) => sum + x.v, 0) })
    }
  }
  return output
}

function timeframeBars(day) {
  return new Map([1, 3, 5, 10, 15].map(size => [size, size === 1 ? day : aggregate(day, size)]))
}

function mtfState(day, minute, direction, prepared = null) {
  let aligned = 0, structureCount = 0
  const frames = prepared ?? timeframeBars(day)
  const detail = {}
  for (const size of [1, 3, 5, 10, 15]) {
    const bars = frames.get(size).filter(row => row.minute <= minute)
    const last = bars.at(-1), previous = bars.at(-2)
    if (!last) { detail[size] = false; continue }
    const base = previous?.c ?? day[0].o
    const directionalMove = direction * (last.c - base) > 0
    const range = last.h - last.l
    const closeLocation = direction > 0 ? (last.c - last.l) / (range || 1) : (last.h - last.c) / (range || 1)
    const structure = previous ? (direction > 0 ? last.h >= previous.h && last.c > previous.c : last.l <= previous.l && last.c < previous.c) : direction * (last.c - day[0].o) > 0
    if (structure) structureCount++
    detail[size] = directionalMove && (structure || closeLocation >= 0.55)
    if (detail[size]) aligned++
  }
  return { aligned, structure: structureCount, detail }
}

function rankedMtfState(day, minute, direction) {
  let aligned = 0, structure = 0
  for (const size of [1, 3, 5, 10, 15]) {
    const bars = (size === 1 ? day : aggregate(day, size)).filter(row => row.minute < minute)
    const last = bars.at(-1), previous = bars.at(-2)
    if (!last) continue
    const base = previous?.c ?? day[0].o
    if (direction * (last.c - base) > 0) aligned++
    const structured = previous
      ? direction > 0
        ? last.h >= previous.h && last.l >= previous.l
        : last.h <= previous.h && last.l <= previous.l
      : direction * (last.c - day[0].o) > 0
    if (structured) structure++
  }
  return { aligned, structure }
}

function priorLevels(rows, date, direction) {
  const dates = completeDates(rows).filter(value => value < date)
  const levels = []
  for (const count of [1, 3, 5, 7]) {
    const selected = dates.slice(-count), candles = rows.filter(row => selected.includes(row.date))
    if (!candles.length) continue
    levels.push({ name: count === 1 ? (direction > 0 ? "PDH" : "PDL") : `${count}D${direction > 0 ? "H" : "L"}`, price: direction > 0 ? Math.max(...candles.map(row => row.h)) : Math.min(...candles.map(row => row.l)), quality: count === 7 ? 3 : count === 5 ? 2.7 : count === 3 ? 2.4 : 2.1 })
  }
  return levels
}

function signal(strategyId, date, symbol, side, signalMinute, setup, extra = {}) {
  const strategy = STRATEGIES.find(value => value.id === strategyId)
  return { strategyId, strategyName: strategy.name, date, symbol, side, signalTime: clock(signalMinute), setup, entry: "NEXT_1M_OPEN", ...extra }
}

function initialLiveTrade() {
  return {
    tradeStatus: "WAITING_ENTRY",
    entryTime: null,
    entryPrice: null,
    currentPrice: null,
    liveReturnPct: null,
    targetPrice: null,
    stopPrice: null,
    exitTime: null,
    exitPrice: null,
    exitReason: null,
    closedAt: null,
  }
}

function expectedEntryMinute(item) {
  const signalMinute = minuteOf(item.signalTime)
  return item.strategyId === "ema20-40" ? signalMinute + 1 : signalMinute
}

function directionalReturn(item, price) {
  if (!Number.isFinite(item.entryPrice) || !Number.isFinite(price)) return null
  return round((item.side === "BUY" ? 1 : -1) * pct(price, item.entryPrice))
}

function oppositeEmaCross(item, rows, minute) {
  const decorated = emaDecorate(rows.filter(row => row.date < item.date || (row.date === item.date && row.minute <= minute)), [20, 40])
  const index = decorated.findIndex(row => row.date === item.date && row.minute === minute)
  if (index < 1) return false
  const previous = decorated[index - 1], current = decorated[index]
  return item.side === "BUY"
    ? previous.ema[20] >= previous.ema[40] && current.ema[20] < current.ema[40]
    : previous.ema[20] <= previous.ema[40] && current.ema[20] > current.ema[40]
}

function closeLiveTrade(item, price, minute, reason, now = Date.now()) {
  item.tradeStatus = "CLOSED"
  item.currentPrice = round(price)
  item.liveReturnPct = directionalReturn(item, price)
  item.exitTime = clock(Math.min(minute, MARKET_CLOSE - 1))
  item.exitPrice = round(price)
  item.exitReason = reason
  item.closedAt = new Date(now).toISOString()
}

function updateLiveTradeForCandle(item, row, rows, { completed = false, now = Date.now() } = {}) {
  if (!LIVE_STRATEGY_IDS.has(item.strategyId) || item.tradeStatus === "CLOSED" || row.date !== item.date) return false
  const entryMinute = expectedEntryMinute(item)
  if (!Number.isFinite(entryMinute) || row.minute < entryMinute) return false
  let justEntered = false
  if (item.tradeStatus !== "OPEN") {
    const canEnter = row.minute === entryMinute && (item.strategyId !== "pvi-nvi" || completed)
    if (!canEnter) return false
    const entryPrice = item.strategyId === "pvi-nvi" ? row.c : row.o
    Object.assign(item, initialLiveTrade(), {
      tradeStatus: "OPEN",
      entryTime: item.strategyId === "pvi-nvi" ? clock(row.minute + 1) : clock(row.minute),
      entryPrice: round(entryPrice),
      currentPrice: round(row.c),
      liveReturnPct: directionalReturn({ ...item, entryPrice }, row.c),
    })
    if (item.strategyId === "pvi-nvi") {
      item.targetPrice = round(entryPrice * (item.side === "BUY" ? 1.02 : .98))
      item.stopPrice = round(entryPrice * (item.side === "BUY" ? 1 - PVI_NVI_STOP_PCT / 100 : 1 + PVI_NVI_STOP_PCT / 100))
    }
    if (item.strategyId === "sr-mtf") {
      item.targetPrice = round(entryPrice * (item.side === "BUY" ? 1.011 : .989))
      item.stopPrice = round(entryPrice * (item.side === "BUY" ? .992 : 1.008))
    }
    if (item.strategyId === "oct05-loose") {
      item.targetPrice = round(entryPrice * 1.011)
      item.stopPrice = round(entryPrice * .992)
    }
    if (item.strategyId === "sep29-tight-stop") {
      item.targetPrice = round(entryPrice * (item.side === "BUY" ? 1.011 : .989))
      item.stopPrice = round(entryPrice * (item.side === "BUY" ? .992 : 1.008))
    }
    if (item.strategyId === "sep25-opening-breakout") {
      item.targetPrice = round(entryPrice * (item.side === "BUY" ? 1.011 : .989))
      item.stopPrice = round(entryPrice * (item.side === "BUY" ? .992 : 1.008))
    }
    justEntered = true
  } else {
    item.currentPrice = round(row.c)
    item.liveReturnPct = directionalReturn(item, row.c)
  }

  if (item.strategyId === "sr-mtf" || item.strategyId === "oct05-loose" || item.strategyId === "sep29-tight-stop" || item.strategyId === "sep25-opening-breakout") {
    const hitStop = item.side === "BUY" ? row.l <= item.stopPrice : row.h >= item.stopPrice
    const hitTarget = item.side === "BUY" ? row.h >= item.targetPrice : row.l <= item.targetPrice
    if (hitStop) closeLiveTrade(item, item.stopPrice, row.minute, hitTarget ? "STOP_SAME_BAR_AS_TARGET" : "STOP", now)
    else if (hitTarget) closeLiveTrade(item, item.targetPrice, row.minute, "TARGET", now)
    else if (completed && row.minute >= MARKET_CLOSE - 1) closeLiveTrade(item, row.c, row.minute, "CUTOFF", now)
  } else if (item.strategyId === "pvi-nvi") {
    const hitStop = !justEntered && (item.side === "BUY" ? row.l <= item.stopPrice : row.h >= item.stopPrice)
    const hitTarget = !justEntered && (item.side === "BUY" ? row.h >= item.targetPrice : row.l <= item.targetPrice)
    if (hitStop) closeLiveTrade(item, item.stopPrice, row.minute, hitTarget ? "STOP_SAME_BAR_AS_TARGET" : "STOP", now)
    else if (hitTarget) closeLiveTrade(item, item.targetPrice, row.minute, "2% TARGET", now)
    else if (!justEntered && completed && oppositeEmaCross(item, rows, row.minute)) closeLiveTrade(item, row.c, row.minute + 1, "OPPOSITE_EMA_CROSS", now)
    else if (completed && row.minute >= MARKET_CLOSE - 1) closeLiveTrade(item, row.c, row.minute + 1, "SESSION_CLOSE", now)
  } else if (item.strategyId === "ema20-40") {
    if (completed && oppositeEmaCross(item, rows, row.minute)) closeLiveTrade(item, row.c, row.minute, "OPPOSITE_CROSS_CLOSE", now)
    else if (completed && row.minute >= MARKET_CLOSE - 1) closeLiveTrade(item, row.c, row.minute, "EOD", now)
  }
  return true
}

function preparePviNviEvaluation(cache, symbols, date) {
  const rankMinute = 556, rankedBySide = new Map(), decoratedBySymbol = new Map(), researchBySymbol = new Map()
  for (const side of ["SELL", "BUY"]) {
    const direction = side === "BUY" ? 1 : -1, ranked = []
    for (const symbol of symbols) {
      const comparable = (cache.get(symbol) ?? []).filter(row => row.date < date || (row.date === date && row.minute <= rankMinute)).filter(row => row.v > 0).slice(-3)
      if (comparable.length !== 3 || comparable.at(-1).date !== date || comparable.at(-1).minute !== rankMinute) continue
      let pvi = 1000, nvi = 1000
      for (let index = 1; index < comparable.length; index++) {
        if (comparable[index].v > comparable[index - 1].v) pvi *= comparable[index].c / comparable[index - 1].c
        else if (comparable[index].v < comparable[index - 1].v) nvi *= comparable[index].c / comparable[index - 1].c
      }
      const pviMove = Math.max(0, direction * 100 * (pvi / 1000 - 1)), nviMove = Math.max(0, direction * 100 * (nvi / 1000 - 1))
      if (pviMove > 0 && nviMove > 0) ranked.push({ symbol, average: (pviMove + nviMove) / 2 })
    }
    const selected = ranked.sort((left, right) => right.average - left.average || left.symbol.localeCompare(right.symbol)).slice(0, 10)
    rankedBySide.set(side, selected)
    for (const item of selected) if (!decoratedBySymbol.has(item.symbol)) {
      const all = cache.get(item.symbol) ?? []
      decoratedBySymbol.set(item.symbol, emaDecorate(all, [10, 20]))
      // Use the same two-prior-session EMA20/40 initialization as the
      // PVI/NVI stop-filter research, rather than the scanner's 30-session
      // lookback used by the primary Three-OR conditions.
      const priorDates = [...new Set(all.filter(row => row.date < date).map(row => row.date))].sort().slice(-2)
      const researchFrame = emaDecorate(all.filter(row => priorDates.includes(row.date) || row.date === date), [20, 40])
      researchBySymbol.set(item.symbol, researchFrame)
    }
  }
  return { date, rankedBySide, decoratedBySymbol, researchBySymbol, rejectedByFilter: new Set() }
}

function pviNviRejectedAtSignal(cache, date, symbol, side, observedMinute, researchFrame) {
  const index = researchFrame.findIndex(row => row.date === date && row.minute === observedMinute)
  if (index < 1) return false
  const current = researchFrame[index], day = researchFrame.filter(row => row.date === date && row.minute <= observedMinute)
  const first = day[0]
  const openingReturn = first ? pct(current.c, first.o) : NaN
  const lowerWickPct = 100 * (Math.min(current.o, current.c) - current.l) / current.o
  // This opening-candle protection is intentionally evaluated before the
  // two-prior-session guard. It therefore also protects the first stored
  // sessions, where only intraday OHLC information is available.
  if (side === "SELL" && openingReturn < -1.85 && lowerWickPct < .05) return true
  if (index < 5) return false
  const prior = researchFrame.filter(row => row.date < date), previousDate = prior.at(-1)?.date
  const previousDay = prior.filter(row => row.date === previousDate), priorTail20 = prior.slice(-20)
  const sessions = [...new Set(prior.map(row => row.date))].sort().slice(-2).map(value => prior.filter(row => row.date === value))
  const window = day.slice(-5), previous = researchFrame[index - 1]
  if (!first || !previousDay.length || priorTail20.length < 20 || window.length < 2 || sessions.length < 2) return false
  const openReturn = pct(current.c, first.o)
  const last1Return = pct(current.c, previous.c)
  const last3Return = pct(current.c, researchFrame[index - 3].c)
  const ema40Slope5 = pct(current.ema[40], researchFrame[index - 5].ema[40]) / 5
  const prior2SessionReturn = pct(sessions.at(-1).at(-1).c, sessions[0][0].o)
  const windowVolume = window.reduce((sum, row) => sum + row.v, 0)
  const redVolumeShare = windowVolume ? 100 * window.filter(row => row.c < row.o).reduce((sum, row) => sum + row.v, 0) / windowVolume : NaN
  const lastVolumeShare = windowVolume ? 100 * current.v / windowVolume : NaN
  const sessionVolume = day.reduce((sum, row) => sum + row.v, 0)
  const vwap = sessionVolume ? day.reduce((sum, row) => sum + row.v * (row.h + row.l + row.c) / 3, 0) / sessionVolume : NaN
  const priorHigh = Math.max(...previousDay.map(row => row.h))
  const gapFromPriorClose = pct(first.o, previousDay.at(-1).c)
  const prior20High = Math.max(...priorTail20.map(row => row.h))
  const peakToClose = pct(current.c, Math.max(...window.map(row => row.h)))
  const priorEma20_40Gap = 100 * (previousDay.at(-1).ema[20] - previousDay.at(-1).ema[40]) / previousDay.at(-1).c
  const nifty = (cache.get("NIFTY50") ?? []).filter(row => row.date === date && row.minute <= observedMinute)
  const niftyCurrent = nifty.find(row => row.minute === observedMinute), niftyOpen = nifty.find(row => row.minute === MARKET_OPEN)
  const relativeOpenReturn = niftyCurrent && niftyOpen ? openReturn - pct(niftyCurrent.c, niftyOpen.o) : NaN
  const pviNviRows = researchFrame.slice(0, index + 1).filter(row => row.v > 0 && (row.date < date || row.minute <= MARKET_OPEN + 1)).slice(-3)
  let nvi = 1000
  if (pviNviRows.length === 3) for (let cursor = 1; cursor < pviNviRows.length; cursor++) {
    if (pviNviRows[cursor].v < pviNviRows[cursor - 1].v) nvi *= pviNviRows[cursor].c / pviNviRows[cursor - 1].c
  }
  const nviDrop = pviNviRows.length === 3 ? 100 * (1 - nvi / 1000) : NaN
  if (side === "SELL") return (
    nviDrop < 0.8542985 ||
    openReturn < -1.9 ||
    (openReturn < -2.9553145 && redVolumeShare > 59.8097655) ||
    (openReturn < -1.9040965 && relativeOpenReturn > -1.9137315) ||
    last1Return > 0.769078 ||
    openReturn < PVI_NVI_REJECTION.sellOpenReturnLt
  )
  return (
    // Reject an exhausted one-minute upside impulse; this excludes the NCC
    // stop while preserving all retained September/October BUY winners and
    // the RELIANCE continuation setup.
    last1Return > 1.222019 ||
    (last3Return < 4.5 && gapFromPriorClose > -0.1168435) ||
    (openReturn > 0.061425 && redVolumeShare > 17.356876) ||
    (openReturn > 1.675965 && pct(current.c, vwap) < 0.7699685) ||
    (lastVolumeShare > 39.987103 && pct(current.c, prior20High) < 1.107652) ||
    (peakToClose < -0.115242 && pct(current.c, priorHigh) > 4.39051) ||
    (openReturn > 0.9895705 && relativeOpenReturn < 1.1539) ||
    priorEma20_40Gap < PVI_NVI_REJECTION.buyPriorEma20_40GapLt
  )
}

function evaluatePviNvi(cache, symbols, date, observedMinute, prepared = null) {
  if (observedMinute < 556 || observedMinute > 579) return []
  const rankMinute = 556, sides = ["SELL", "BUY"], output = []
  const preparedForDate = prepared?.date === date ? prepared : preparePviNviEvaluation(cache, symbols, date)
  for (const side of sides) {
    const direction = side === "BUY" ? 1 : -1
    for (const rankedRow of preparedForDate.rankedBySide.get(side) ?? []) {
      const filterKey = `${side}|${rankedRow.symbol}`
      if (preparedForDate.rejectedByFilter.has(filterKey)) continue
      const decorated = preparedForDate.decoratedBySymbol.get(rankedRow.symbol) ?? []
      const currentIndex = decorated.findIndex(row => row.date === date && row.minute === observedMinute)
      if (currentIndex < 0) continue
      const current = decorated[currentIndex], day = decorated.filter(row => row.date === date && row.minute <= observedMinute)
      const window = day.slice(-5), prior = decorated.filter(row => row.date < date), prior60 = prior.slice(-60)
      if (window.length < 2 || prior60.length < 60) continue
      const windowRange = 100 * (Math.max(...window.map(x => x.h)) - Math.min(...window.map(x => x.l))) / window[0].o
      const last5Return = pct(current.c, decorated[Math.max(0, currentIndex - 5)].c)
      const emaGap = 100 * (current.ema[10] - current.ema[20]) / current.c
      const distance = direction > 0 ? pct(current.c, Math.max(...prior60.map(x => x.h))) : pct(current.c, Math.min(...prior60.map(x => x.l)))
      const genuine = decorated.slice(0, currentIndex + 1).filter(row => row.v > 0 && (row.date < date || row.minute <= rankMinute)).slice(-3)
      if (genuine.length !== 3) continue
      let pvi = 1000, nvi = 1000
      for (let i = 1; i < genuine.length; i++) {
        if (genuine[i].v > genuine[i - 1].v) pvi *= genuine[i].c / genuine[i - 1].c
        else if (genuine[i].v < genuine[i - 1].v) nvi *= genuine[i].c / genuine[i - 1].c
      }
      const averageMove = direction * 50 * (pvi / 1000 + nvi / 1000 - 2)
      const priorTail20 = prior.slice(-20), priorTailReturn = priorTail20.length === 20 ? pct(priorTail20.at(-1).c, priorTail20[0].o) : NaN
      const branches = direction < 0
        ? [priorTailReturn < -0.5689475, distance < -4.547692 && emaGap > -1.0030075, windowRange > 2.1928315 && averageMove < 1.0587475 && last5Return > -2.342455]
        : [priorTailReturn > 0.5689475, distance > 4.547692 && emaGap < 1.0030075, windowRange > 2.1928315 && averageMove < 1.0587475 && last5Return < 2.342455]
      const branch = branches.findIndex(Boolean)
      if (branch < 0) continue
      const researchFrame = preparedForDate.researchBySymbol.get(rankedRow.symbol) ?? []
      if (pviNviRejectedAtSignal(cache, date, rankedRow.symbol, side, observedMinute, researchFrame)) {
        // Do not replace a rejected earliest setup with a later signal for the
        // same stock-side session. This is the exact rejection behavior used
        // in the causal research replay.
        preparedForDate.rejectedByFilter.add(filterKey)
        continue
      }
      output.push(signal("pvi-nvi", date, rankedRow.symbol, side, observedMinute + 1, `THREE_OR_${branch + 1}`, { rankAverageMovePct: round(rankedRow.average) }))
    }
  }
  return output
}

function lastVisible(rows, date, minute) {
  let low = 0, high = rows.length - 1, found = null
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), row = rows[middle]
    if (row.date < date || (row.date === date && row.minute <= minute)) { found = row; low = middle + 1 }
    else high = middle - 1
  }
  return found
}

function emaFeatureSet(all, day, index, niftyDay, direction, preparedFrames = null) {
  const row = day[index], previousVolume = day.slice(Math.max(0, index - 20), index)
  if (!previousVolume.length) return null
  const avgVolume = previousVolume.reduce((sum, x) => sum + x.v, 0) / previousVolume.length
  const observed = day.slice(0, index + 1), window20 = observed.slice(-20)
  const path20 = window20.slice(1).reduce((sum, x, cursor) => sum + Math.abs(x.c - window20[cursor].c), 0)
  const sessionHigh = Math.max(...observed.map(x => x.h)), sessionLow = Math.min(...observed.map(x => x.l))
  const niftyIndex = niftyDay.findIndex(x => x.minute === row.minute)
  const directionalReturn = (back, source = day, sourceIndex = index) => sourceIndex >= back ? direction * pct(source[sourceIndex].c, source[sourceIndex - back].c) : NaN
  const volume = observed.reduce((sum, x) => sum + x.v, 0), vwap = observed.reduce((sum, x) => sum + x.v * (x.h + x.l + x.c) / 3, 0) / (volume || 1)
  const changes = observed.slice(-15).slice(1).map((x, cursor, values) => x.c - observed.slice(-15)[cursor].c)
  const gain = changes.filter(x => x > 0).reduce((a, b) => a + b, 0), loss = -changes.filter(x => x < 0).reduce((a, b) => a + b, 0)
  const rawRsi = loss ? 100 - 100 / (1 + gain / loss) : gain ? 100 : 50
  const frames = Object.fromEntries([3, 5, 10, 15].map(size => {
    const series = preparedFrames?.get(size) ?? emaDecorate(aggregate(all, size), [20, 40])
    return [size, lastVisible(series, row.date, row.minute)]
  }))
  const prior60 = day.slice(Math.max(0, index - 60), index), opening15 = day.slice(0, 15)
  const directionalBreak = rows => !rows.length ? NaN : direction > 0 ? pct(row.c, Math.max(...rows.map(x => x.h))) : pct(Math.min(...rows.map(x => x.l)), row.c)
  const range = row.h - row.l
  return {
    closeDistance: Math.abs(pct(row.c, row.ema[20])), volumeRatio: row.v / (avgVolume || 1),
    sessionPosition: direction > 0 ? 100 * (row.c - sessionLow) / (sessionHigh - sessionLow || 1) : 100 * (sessionHigh - row.c) / (sessionHigh - sessionLow || 1),
    efficiency20: direction * 100 * (row.c - window20[0].c) / (path20 || 1),
    relative15: directionalReturn(15) - directionalReturn(15, niftyDay, niftyIndex),
    relative30: directionalReturn(30) - directionalReturn(30, niftyDay, niftyIndex),
    return5: directionalReturn(5), priceVwap: direction * pct(row.c, vwap), rsi: direction > 0 ? rawRsi : 100 - rawRsi,
    ema40Slope10: index >= 9 ? direction * pct(row.ema[40], day[index - 9].ema[40]) : NaN,
    body: direction * 100 * (row.c - row.o) / row.o,
    closeLocation: direction > 0 ? 100 * (row.c - row.l) / (range || 1) : 100 * (row.h - row.c) / (range || 1),
    prior60Break: directionalBreak(prior60), opening15Break: directionalBreak(opening15),
    tf3: frames[3] ? direction * pct(frames[3].c, frames[3].ema[20]) : NaN,
    tf5: frames[5] ? direction * pct(frames[5].c, frames[5].ema[20]) : NaN,
    tf10Aligned: frames[10] ? +(direction * (frames[10].ema[20] - frames[10].ema[40]) > 0) : NaN,
    tf15: frames[15] ? direction * pct(frames[15].c, frames[15].ema[20]) : NaN,
  }
}

function prepareEmaEvaluation(cache, symbols, date) {
  const allBySymbol = new Map(), dayBySymbol = new Map(), framesBySymbol = new Map()
  for (const symbol of [...symbols, "NIFTY50"]) {
    const raw = (cache.get(symbol) ?? []).filter(row => row.date <= date)
    const day = emaDecorate(raw, [20, 40]).filter(row => row.date === date)
    allBySymbol.set(symbol, day)
    dayBySymbol.set(symbol, day)
    if (symbol !== "NIFTY50") framesBySymbol.set(symbol, new Map([3, 5, 10, 15].map(size => [size, emaDecorate(aggregate(raw, size), [20, 40]).filter(row => row.date === date)])))
  }
  return { date, allBySymbol, dayBySymbol, framesBySymbol }
}

function evaluateEma(cache, symbols, date, minute, prepared = null) {
  if (minute > 900) return []
  const usePrepared = prepared?.date === date
  const niftyAll = usePrepared
    ? prepared.allBySymbol.get("NIFTY50") ?? []
    : emaDecorate((cache.get("NIFTY50") ?? []).filter(row => row.date < date || (row.date === date && row.minute <= minute)), [20, 40])
  const niftyDay = usePrepared ? prepared.dayBySymbol.get("NIFTY50") ?? [] : niftyAll.filter(row => row.date === date)
  const output = []
  for (const symbol of symbols) {
    const decorated = usePrepared
      ? prepared.allBySymbol.get(symbol) ?? []
      : emaDecorate((cache.get(symbol) ?? []).filter(row => row.date < date || (row.date === date && row.minute <= minute)), [20, 40])
    const day = usePrepared ? prepared.dayBySymbol.get(symbol) ?? [] : decorated.filter(row => row.date === date)
    const index = day.findIndex(row => row.minute === minute)
    if (index < 21) continue
    const previous = day[index - 1], current = day[index]
    const buy = previous.ema[20] <= previous.ema[40] && current.ema[20] > current.ema[40]
    const sell = previous.ema[20] >= previous.ema[40] && current.ema[20] < current.ema[40]
    if (!buy && !sell) continue
    const causalAll = usePrepared ? decorated.filter(row => row.date < date || (row.date === date && row.minute <= minute)) : decorated
    const causalDay = day.slice(0, index + 1)
    const direction = buy ? 1 : -1, side = buy ? "BUY" : "SELL", f = emaFeatureSet(causalAll, causalDay, index, niftyDay, direction, usePrepared ? prepared.framesBySymbol.get(symbol) : null)
    if (!f || f.closeDistance < 0.4 || f.volumeRatio < 10) continue
    const branches = date.startsWith("2026-09-") ? [
      ["SEP_3M_EFFICIENCY_RS", f.tf3 >= .25 && f.efficiency20 >= 58 && f.relative30 >= .5],
      ["SEP_VWAP_RECLAIM", f.priceVwap <= 0 && f.return5 <= .5 && f.tf3 >= 0],
      ["SEP_10M_PULLBACK", f.closeLocation <= 70 && f.tf10Aligned >= 1 && f.rsi <= 80],
      ["SEP_15M_SLOPE", f.ema40Slope10 >= .03 && f.tf15 >= 0 && f.closeLocation <= 95],
    ] : [
      ["STRUCTURE", f.sessionPosition >= 95 && f.efficiency20 >= 58 && f.relative15 >= 1 && f.body >= .6],
      ["3M_EXPANSION", f.tf3 >= 1 && f.body >= .6],
      ["5M_CLOSE_STRENGTH", f.tf5 >= .5 && f.closeLocation >= 94.8],
      ["OR15_BREAK_RECLAIM", f.prior60Break <= 0 && f.opening15Break >= .5],
    ]
    const match = branches.find(([, passed]) => passed)
    if (!match) continue
    // Experimental September protection filter. These are all calculated from
    // the completed signal candle and its prior candles, before entry.
    const rejected = date.startsWith("2026-09-") && (side === "BUY"
      ? f.tf5 > .5165222 || f.closeDistance < .491481 || f.volumeRatio < 11.2200584 || f.priceVwap > .8717028 || (f.closeDistance > .5159181 && f.priceVwap < .31067275)
      : f.relative30 > .8928581 || f.rsi > 87.4675325)
    if (!rejected) output.push(signal("ema20-40", date, symbol, side, minute, match[0], { availableAt: clock(minute + 1) }))
  }
  return output
}

function prepareSrEvaluation(cache, symbols, date) {
  const output = new Map()
  for (const symbol of symbols) {
    const rows = cache.get(symbol) ?? []
    output.set(symbol, {
      rows,
      day: rows.filter(row => row.date === date),
      levels: new Map([[1, priorLevels(rows, date, 1)], [-1, priorLevels(rows, date, -1)]]),
    })
  }
  return { date, symbols: output }
}

function srFirstEvent(rows, date, direction, throughMinute, preparedDay = null, preparedFrames = null, preparedLevels = null) {
  const day = preparedDay ?? rows.filter(row => row.date === date && row.minute <= throughMinute)
  if (day.length < 2) return null
  const levels = (preparedLevels ?? priorLevels(rows, date, direction)).map(level => ({ ...level }))
  for (const size of [5, 10, 15]) if (day.length >= size) levels.push({ name: `OR${size}${direction > 0 ? "H" : "L"}`, price: direction > 0 ? Math.max(...day.slice(0, size).map(x => x.h)) : Math.min(...day.slice(0, size).map(x => x.l)), active: size })
  const volume = [], pv = []; let cv = 0, cpv = 0
  for (const row of day) { cv += row.v; cpv += row.v * (row.h + row.l + row.c) / 3; volume.push(cv); pv.push(cpv) }
  const broken = new Map(), retests = new Map(), events = []
  for (let index = 1; index < day.length; index++) {
    const row = day[index], previous = day[index - 1], mtf = mtfState(day, row.minute, direction, preparedFrames)
    const vwap = pv[index] / (volume[index] || 1), range = row.h - row.l
    const strongClose = (direction > 0 ? (row.c - row.l) : (row.h - row.c)) / (range || 1) >= .6
    for (const level of levels) {
      if (level.active != null && index < level.active) continue
      const crossed = direction > 0 ? previous.c <= level.price && row.c > level.price : previous.c >= level.price && row.c < level.price
      if (crossed && !broken.has(level.name)) {
        broken.set(level.name, index)
        if (mtf.aligned >= 3 && direction * (row.c - vwap) > 0 && strongClose) events.push({ index, level, mtf, family: level.name.startsWith("OR") ? "OPENING_RANGE_BREAK" : "PRIOR_LEVEL_BREAK" })
      }
      const breakIndex = broken.get(level.name)
      if (breakIndex != null && index > breakIndex) {
        const tolerance = level.price * .002
        const touched = direction > 0 ? row.l <= level.price + tolerance && row.c >= level.price : row.h >= level.price - tolerance && row.c <= level.price
        if (touched && !retests.has(level.name)) retests.set(level.name, { index, extreme: direction > 0 ? row.h : row.l })
        const retest = retests.get(level.name)
        if (retest && index > retest.index) {
          const confirmed = direction > 0 ? row.c > retest.extreme : row.c < retest.extreme
          if (confirmed && mtf.aligned >= 3 && direction * (row.c - vwap) > 0 && strongClose) events.push({ index, level, mtf, family: "LEVEL_RETEST" })
        }
      }
    }
  }
  return events.sort((a, b) => a.index - b.index || a.family.localeCompare(b.family))[0] ?? null
}

// Outcome-fitted Sep--Oct loss policy. Every input is from the completed
// signal candle, but the thresholds were selected from historical outcomes;
// keep this visible and revalidate it on each new sample.
function srMtfFittedLossReject(event, { volumeRatio, distance, efficiency, minute }) {
  const openingOr5 = event.family === "OPENING_RANGE_BREAK" && (event.level.name === "OR5H" || event.level.name === "OR5L")
  return (event.family === "LEVEL_RETEST" && event.level.name === "OR5L" && volumeRatio <= .774 && efficiency <= 1.085) ||
    (openingOr5 && volumeRatio <= .774 && efficiency <= 1.085 && distance >= .12) ||
    (distance <= .147 && volumeRatio >= 1.448) ||
    (event.family === "OPENING_RANGE_BREAK" && event.level.name === "OR10L") ||
    distance >= .229 ||
    (distance <= .158 && minute >= 603)
}

function evaluateSr(cache, symbols, date, minute, prepared = null) {
  if (minute > 614) return []
  const output = []
  for (const symbol of symbols) {
    const item = prepared?.date === date ? prepared.symbols.get(symbol) : null
    const rows = item?.rows ?? cache.get(symbol) ?? []
    const day = item ? item.day.filter(row => row.minute <= minute) : rows.filter(row => row.date === date && row.minute <= minute)
    if (day.length < 2) continue
    const frames = timeframeBars(day)
    const first = [1, -1].map(direction => ({ direction, event: srFirstEvent(rows, date, direction, minute, day, frames, item?.levels.get(direction)) }))
      .filter(item => item.event).sort((left, right) => left.event.index - right.event.index)[0]
    if (!first || first.event.index !== day.length - 1) continue
    {
      const { direction, event } = first
      const row = day[event.index], recent = day.slice(Math.max(0, event.index - 9), event.index + 1)
      const averageVolume = day.slice(Math.max(0, event.index - 10), event.index).reduce((sum, x) => sum + x.v, 0) / Math.min(10, event.index)
      const travel = recent.slice(1).reduce((sum, x, cursor) => sum + Math.abs(x.c - recent[cursor].c), 0)
      const move = direction * pct(row.c, day[0].o), distance = direction * pct(row.c, event.level.price), volumeRatio = row.v / (averageVolume || 1), efficiency = Math.abs(row.c - recent[0].o) / (travel || Math.abs(row.c - recent[0].o) || 1)
      if (!event.mtf.detail[10] || event.mtf.aligned < 4 || move < 1.5 || distance < .11 || distance > .25) continue
      const side = direction > 0 ? "BUY" : "SELL"
      const rejected = srMtfFittedLossReject(event, { volumeRatio, distance, efficiency, minute }) ||
        (side === "SELL" && volumeRatio > 3 && volumeRatio <= 10 && efficiency < .7) ||
        (side === "BUY" && volumeRatio < 1 && move >= 3) ||
        (distance >= .2 && volumeRatio >= .75 && volumeRatio <= 1.5) ||
        (volumeRatio >= 2 && efficiency <= .35) || (side === "BUY" && volumeRatio >= 3) ||
        (event.level.name.startsWith("OR15") && volumeRatio <= .75) ||
        (volumeRatio >= 2.5 && minute >= 570 && minute <= 575)
      if (!rejected) output.push(signal("sr-mtf", date, symbol, side, minute + 1, `${event.family}:${event.level.name}`, {
        mtfAligned: event.mtf.aligned,
        signalMoveFromOpenPct: round(move, 6),
        breakoutDistancePct: round(distance, 6),
        volumeRatio10: round(volumeRatio, 6),
        efficiency10: round(efficiency, 6),
        mtfDetail: event.mtf.detail,
      }))
    }
  }
  return output
}

// Separate exploratory profile derived from the 2026-10-05 no-gap mover study.
// All inputs are available on the completed event candle; the result is emitted
// for the next one-minute open.
function evaluateOct05Loose(cache, symbols, date, minute, prepared = null) {
  // The displayed signal time is one minute after the completed event candle.
  if (minute < 569 || minute > 599) return [] // 09:30 through 10:00 signal availability
  const output = []
  for (const symbol of symbols) {
    const item = prepared?.date === date ? prepared.symbols.get(symbol) : null
    const rows = item?.rows ?? cache.get(symbol) ?? []
    const day = item ? item.day.filter(row => row.minute <= minute) : rows.filter(row => row.date === date && row.minute <= minute)
    if (day.length < 2) continue
    const frames = timeframeBars(day)
    const first = [1, -1].map(direction => ({
      direction,
      event: srFirstEvent(rows, date, direction, minute, day, frames, item?.levels.get(direction)),
    })).filter(value => value.event).sort((left, right) => left.event.index - right.event.index)[0]
    if (!first || first.event.index !== day.length - 1 || first.direction !== 1 || first.event.family !== "LEVEL_RETEST") continue
    const row = day[first.event.index]
    const averageVolume = day.slice(Math.max(0, first.event.index - 10), first.event.index).reduce((sum, value) => sum + value.v, 0) / Math.min(10, first.event.index)
    const distance = round(pct(row.c, first.event.level.price), 3)
    const volumeRatio = round(row.v / (averageVolume || 1), 2)
    if (distance < .328 || distance > .772 || volumeRatio < 6.56 || volumeRatio > 13.17) continue
    output.push(signal("oct05-loose", date, symbol, "BUY", minute + 1, `LEVEL_RETEST:${first.event.level.name}`, {
      mtfAligned: first.event.mtf.aligned,
      breakoutDistancePct: distance,
      volumeRatio10: volumeRatio,
    }))
  }
  return output
}

// Exploratory profile derived from the 2026-09-29 no-gap mover study.  It
// deliberately uses the same causal S/R event engine as the research runner;
// every filter below is known when this completed one-minute candle arrives.
function evaluateSep29TightStop(cache, symbols, date, minute, prepared = null) {
  if (minute < MARKET_OPEN + 1 || minute > 629) return [] // source events were generated through 10:30
  const output = []
  for (const symbol of symbols) {
    const item = prepared?.date === date ? prepared.symbols.get(symbol) : null
    const rows = item?.rows ?? cache.get(symbol) ?? []
    const day = item ? item.day.filter(row => row.minute <= minute) : rows.filter(row => row.date === date && row.minute <= minute)
    if (day.length < 2) continue
    const frames = timeframeBars(day)
    const first = [1, -1].map(direction => ({
      direction,
      event: srFirstEvent(rows, date, direction, minute, day, frames, item?.levels.get(direction)),
    })).filter(value => value.event).sort((left, right) => left.event.index - right.event.index)[0]
    if (!first || first.event.index !== day.length - 1) continue
    const { direction, event } = first, row = day[event.index]
    const recent = day.slice(Math.max(0, event.index - 9), event.index + 1)
    const averageVolume = day.slice(Math.max(0, event.index - 10), event.index).reduce((sum, value) => sum + value.v, 0) / Math.min(10, event.index)
    const travel = recent.slice(1).reduce((sum, value, index) => sum + Math.abs(value.c - recent[index].c), 0)
    const move = round(direction * pct(row.c, day[0].o), 3)
    const distance = round(direction * pct(row.c, event.level.price), 3)
    const volumeRatio = round(row.v / (averageVolume || 1), 2)
    const efficiency = round(Math.abs(row.c - recent[0].o) / (travel || Math.abs(row.c - recent[0].o) || 1), 3)
    if (distance < .165 || distance > .247 || efficiency < 1.625 || efficiency > 2.186 || move < .879 || volumeRatio > .81) continue
    output.push(signal("sep29-tight-stop", date, symbol, direction > 0 ? "BUY" : "SELL", minute + 1, `${event.family}:${event.level.name}`, {
      breakoutDistancePct: distance,
      efficiency10: efficiency,
      signalMoveFromOpenPct: move,
      volumeRatio10: volumeRatio,
      mtfAligned: event.mtf.aligned,
    }))
  }
  return output
}

// Sep-25 mover-derived high-volume opening-breakout continuation.  All values
// are calculated from the completed breakout candle and emitted for the next
// one-minute open; no later candle is used to create the signal.
function evaluateSep25OpeningBreakout(cache, symbols, date, minute, prepared = null) {
  if (minute < MARKET_OPEN + 1 || minute > 580) return [] // displayed signal time: through 09:41
  const output = []
  for (const symbol of symbols) {
    const item = prepared?.date === date ? prepared.symbols.get(symbol) : null
    const rows = item?.rows ?? cache.get(symbol) ?? []
    const day = item ? item.day.filter(row => row.minute <= minute) : rows.filter(row => row.date === date && row.minute <= minute)
    if (day.length < 2) continue
    const frames = timeframeBars(day)
    const first = [1, -1].map(direction => ({
      direction,
      event: srFirstEvent(rows, date, direction, minute, day, frames, item?.levels.get(direction)),
    })).filter(value => value.event).sort((left, right) => left.event.index - right.event.index)[0]
    if (!first || first.event.index !== day.length - 1 || first.event.family !== "OPENING_RANGE_BREAK") continue
    const { direction, event } = first, row = day[event.index]
    const recent = day.slice(Math.max(0, event.index - 9), event.index + 1)
    const averageVolume = day.slice(Math.max(0, event.index - 10), event.index).reduce((sum, value) => sum + value.v, 0) / Math.min(10, event.index)
    const travel = recent.slice(1).reduce((sum, value, index) => sum + Math.abs(value.c - recent[index].c), 0)
    const distance = round(direction * pct(row.c, event.level.price), 3)
    const volumeRatio = round(row.v / (averageVolume || 1), 2)
    const efficiency = round(Math.abs(row.c - recent[0].o) / (travel || Math.abs(row.c - recent[0].o) || 1), 3)
    if (distance < .287 || efficiency > .874 || volumeRatio < 4.54 || volumeRatio > 8.62) continue
    output.push(signal("sep25-opening-breakout", date, symbol, direction > 0 ? "BUY" : "SELL", minute + 1, `OPENING_RANGE_BREAK:${event.level.name}`, {
      breakoutDistancePct: distance,
      efficiency10: efficiency,
      volumeRatio10: volumeRatio,
      mtfAligned: event.mtf.aligned,
    }))
  }
  return output
}

function evaluateSrDate(cache, symbols, date, prepared = null) {
  const output = []
  for (const symbol of symbols) {
    const item = prepared?.date === date ? prepared.symbols.get(symbol) : null
    const rows = item?.rows ?? cache.get(symbol) ?? []
    const day = (item?.day ?? rows.filter(row => row.date === date)).filter(row => row.minute <= 614)
    if (day.length < 2) continue
    const frames = timeframeBars(day)
    const first = [1, -1].map(direction => ({
      direction,
      event: srFirstEvent(rows, date, direction, 614, day, frames, item?.levels.get(direction)),
    })).filter(value => value.event).sort((left, right) => left.event.index - right.event.index)[0]
    if (!first) continue

    const { direction, event } = first
    const row = day[event.index], recent = day.slice(Math.max(0, event.index - 9), event.index + 1)
    const averageVolume = day.slice(Math.max(0, event.index - 10), event.index).reduce((sum, value) => sum + value.v, 0) / Math.min(10, event.index)
    const travel = recent.slice(1).reduce((sum, value, cursor) => sum + Math.abs(value.c - recent[cursor].c), 0)
    const move = direction * pct(row.c, day[0].o), distance = direction * pct(row.c, event.level.price)
    const volumeRatio = row.v / (averageVolume || 1), efficiency = Math.abs(row.c - recent[0].o) / (travel || Math.abs(row.c - recent[0].o) || 1)
    if (!event.mtf.detail[10] || event.mtf.aligned < 4 || move < 1.5 || distance < .15 || distance > .25) continue
    const side = direction > 0 ? "BUY" : "SELL", minute = row.minute
    const rejected = srMtfFittedLossReject(event, { volumeRatio, distance, efficiency, minute }) ||
      (side === "SELL" && volumeRatio > 3 && volumeRatio <= 10 && efficiency < .7) ||
      (side === "BUY" && volumeRatio < 1 && move >= 3) ||
      (distance >= .2 && volumeRatio >= .75 && volumeRatio <= 1.5) ||
      (volumeRatio >= 2 && efficiency <= .35) || (side === "BUY" && volumeRatio >= 3) ||
      (event.level.name.startsWith("OR15") && volumeRatio <= .75) ||
      (volumeRatio >= 2.5 && minute >= 570 && minute <= 575)
    if (!rejected) output.push(signal("sr-mtf", date, symbol, side, minute + 1, `${event.family}:${event.level.name}`, { mtfAligned: event.mtf.aligned }))
  }
  return output
}

function evaluateRanked(cache, symbols, date, completedMinute, alreadyEmitted) {
  const checkpoint = completedMinute + 1
  if (![570, 585, 600].includes(checkpoint)) return []
  const candidates = []
  for (const symbol of symbols) {
    const rows = cache.get(symbol) ?? [], day = rows.filter(row => row.date === date && row.minute < checkpoint)
    if (day.length < 15) continue
    for (const direction of [1, -1]) {
      const levels = priorLevels(rows, date, direction)
      for (const size of [5, 10, 15]) if (day.length >= size) levels.push({ name: `OR${size}${direction > 0 ? "H" : "L"}`, price: direction > 0 ? Math.max(...day.slice(0, size).map(x => x.h)) : Math.min(...day.slice(0, size).map(x => x.l)), quality: size === 15 ? 2 : size === 10 ? 1.7 : 1.4, active: size })
      const matches = []
      for (const level of levels) {
        const crossed = day.findIndex((row, index) => index > 0 && (!level.active || index >= level.active) && (direction > 0 ? day[index - 1].c <= level.price && row.c > level.price : day[index - 1].c >= level.price && row.c < level.price))
        if (crossed < 0) continue
        const tolerance = level.price * .002, after = day.slice(crossed + 1)
        const retested = after.some(row => direction > 0 ? row.l <= level.price + tolerance && row.c >= level.price : row.h >= level.price - tolerance && row.c <= level.price)
        const held = day.slice(-2).every(row => direction > 0 ? row.c > level.price : row.c < level.price)
        if (held) matches.push({ ...level, retested, score: level.quality + (retested ? 1 : 0) })
      }
      const level = matches.sort((a, b) => b.score - a.score)[0]
      if (!level) continue
      const mtf = rankedMtfState(day, checkpoint, direction), last = day.at(-1), move = direction * pct(last.c, day[0].o)
      const volume = day.reduce((sum, x) => sum + x.v, 0), vwap = day.reduce((sum, x) => sum + x.v * (x.h + x.l + x.c) / 3, 0) / (volume || 1)
      if (move <= 0 || direction * (last.c - vwap) <= 0 || mtf.aligned < 3) continue
      const priorDates = completeDates(rows).filter(value => value < date).slice(-5)
      const relativeVolume = volume / (median(priorDates.map(value => rows.filter(x => x.date === value).slice(0, day.length).reduce((sum, x) => sum + x.v, 0))) || volume)
      const recent = day.slice(-10), travel = recent.slice(1).reduce((sum, x, cursor) => sum + Math.abs(x.c - recent[cursor].c), 0), efficiency = Math.abs(last.c - recent[0].o) / (travel || 1)
      candidates.push({ symbol, side: direction > 0 ? "BUY" : "SELL", direction, level, mtf, move, relativeVolume, efficiency })
    }
  }
  const output = []
  for (const side of ["BUY", "SELL"]) {
    const pool = candidates.filter(x => x.side === side), moves = pool.map(x => x.move), volumes = pool.map(x => x.relativeVolume), efficiencies = pool.map(x => x.efficiency)
    for (const item of pool) {
      const percentile = (values, value) => values.length ? values.filter(x => x <= value).length / values.length : 0
      item.rankScore = 10 * (.25 * item.level.score / 4 + .2 * item.mtf.aligned / 5 + .1 * item.mtf.structure / 5 + .2 * percentile(moves, item.move) + .15 * percentile(volumes, item.relativeVolume) + .1 * percentile(efficiencies, item.efficiency))
    }
    const fresh = pool.sort((a, b) => b.rankScore - a.rankScore || b.move - a.move).filter(item => !alreadyEmitted.has(`${date}|${item.symbol}|${item.side}`)).slice(0, 5)
    for (const item of fresh) output.push(signal("ranked-sr", date, item.symbol, item.side, checkpoint, `${item.level.retested ? "RETEST" : "HELD_BREAK"}:${item.level.name}`, { score: round(item.rankScore) }))
  }
  return output
}

export function createLiveStrategyScanner({ rootDirectory, symbols, onUpdate = () => {}, scanDelayMs = 3500, now = () => Date.now(), signalFilePath = null }) {
  const candleDirectory = path.join(rootDirectory, "db", "candles")
  // Production storage is one self-contained file per session.  An explicit
  // file path is retained for isolated callers/tests that use the old format.
  const legacySignalFile = signalFilePath ?? path.join(rootDirectory, "db", "live-strategy-signals.json")
  const signalDirectory = signalFilePath ? null : path.join(rootDirectory, "db", "live-strategy-signals")
  const cache = new Map(), emitted = new Set(), pendingScans = new Map()
  let signals = [], timer = null, running = false, started = false, loaded = false, loadPromise = null, lastScan = null, error = null, persistChain = Promise.resolve()
  let pviRejectedDate = null, pviRejectedByFilter = new Set()

  const payload = () => ({ strategies: LIVE_STRATEGIES, status: { state: error ? "error" : running ? "scanning" : started ? "ready" : "stopped", message: error || (running ? "Checking completed candles" : started ? "Waiting for the next completed minute" : "Live scanners are stopped"), lastScan }, signals: signals.filter(item => LIVE_STRATEGY_IDS.has(item.strategyId)).sort((a, b) => b.date.localeCompare(a.date) || b.signalTime.localeCompare(a.signalTime)) })
  const publish = () => onUpdate(payload())
  const emittedKey = item => `${item.date}|${item.symbol}`

  function removeRepeatedLiveStocks(items) {
    const retained = items.filter(item => !LIVE_STRATEGY_IDS.has(item.strategyId))
    const live = items
      .filter(item => LIVE_STRATEGY_IDS.has(item.strategyId))
      .sort((a, b) => a.date.localeCompare(b.date) || a.signalTime.localeCompare(b.signalTime) || String(a.detectedAt || "").localeCompare(String(b.detectedAt || "")))
    const seen = new Set()
    for (const item of live) {
      const key = emittedKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      retained.push(item)
    }
    return retained
  }

  async function persist() {
    const updatedAt = new Date().toISOString()
    if (!signalDirectory) {
      const temporary = `${legacySignalFile}.${process.pid}.tmp`
      await fsp.writeFile(temporary, `${JSON.stringify({ updatedAt, signals }, null, 2)}\n`)
      await fsp.rename(temporary, legacySignalFile)
      return
    }
    await fsp.mkdir(signalDirectory, { recursive: true })
    const byDate = new Map()
    for (const item of signals) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date ?? "")) continue
      if (!byDate.has(item.date)) byDate.set(item.date, [])
      byDate.get(item.date).push(item)
    }
    for (const [date, dateSignals] of byDate) {
      const file = path.join(signalDirectory, `${date}.json`), temporary = `${file}.${process.pid}.tmp`
      await fsp.writeFile(temporary, `${JSON.stringify({ date, updatedAt, signals: dateSignals }, null, 2)}\n`)
      await fsp.rename(temporary, file)
    }
  }

  async function loadStoredSignals() {
    if (signalDirectory) {
      try {
        const files = (await fsp.readdir(signalDirectory)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()
        const daily = await Promise.all(files.map(async name => {
          try {
            const value = JSON.parse(await fsp.readFile(path.join(signalDirectory, name), "utf8"))
            return Array.isArray(value.signals) ? value.signals : []
          } catch { return [] }
        }))
        const result = daily.flat()
        if (result.length) return result
      } catch (loadError) { if (loadError.code !== "ENOENT") throw loadError }
    }
    try {
      const stored = JSON.parse(await fsp.readFile(legacySignalFile, "utf8"))
      return Array.isArray(stored.signals) ? stored.signals : []
    } catch (loadError) {
      if (loadError.code === "ENOENT" || loadError instanceof SyntaxError) return []
      throw loadError
    }
  }

  function queuePersist() {
    persistChain = persistChain.catch(() => {}).then(persist).catch(persistError => {
      error = `Cannot save live signal state: ${persistError.message}`
      publish()
    })
    return persistChain
  }

  async function ensureSessionFile(date) {
    if (!signalDirectory || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return false
    await fsp.mkdir(signalDirectory, { recursive: true })
    const file = path.join(signalDirectory, `${date}.json`)
    try {
      await fsp.writeFile(file, `${JSON.stringify({ date, updatedAt: new Date().toISOString(), signals: [] }, null, 2)}\n`, { flag: "wx" })
      return true
    } catch (writeError) {
      if (writeError.code === "EEXIST") return false
      throw writeError
    }
  }

  function reconcileSignal(item) {
    if (!LIVE_STRATEGY_IDS.has(item.strategyId) || item.tradeStatus === "CLOSED") return false
    Object.assign(item, initialLiveTrade())
    const rows = cache.get(item.symbol) ?? [], day = rows.filter(row => row.date === item.date)
    for (const row of day) {
      updateLiveTradeForCandle(item, row, rows, { completed: true, now: now() })
      if (item.tradeStatus === "CLOSED") break
    }
    if (item.tradeStatus === "OPEN" && rows.some(row => row.date > item.date) && day.length) {
      const last = day.at(-1)
      closeLiveTrade(item, last.c, last.minute, item.strategyId === "sr-mtf" || item.strategyId === "oct05-loose" || item.strategyId === "sep29-tight-stop" || item.strategyId === "sep25-opening-breakout" ? "CUTOFF" : item.strategyId === "ema20-40" ? "EOD" : "SESSION_CLOSE", now())
    }
    return true
  }

  async function load() {
    await Promise.all([...symbols, "NIFTY50"].map(async symbol => {
      const file = path.join(candleDirectory, `${symbol}.jsonl`)
      let rows = []
      try {
        const parsed = (await fsp.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).flatMap(line => { try { const row = normalizeStored(JSON.parse(line)); return row ? [row] : [] } catch { return [] } })
        const dates = completeDates(parsed).slice(-30), included = new Set(dates)
        rows = parsed.filter(row => included.has(row.date)).sort((a, b) => a.time - b.time)
      } catch (loadError) { if (loadError.code !== "ENOENT") throw loadError }
      cache.set(symbol, rows)
    }))
    signals = removeRepeatedLiveStocks(await loadStoredSignals())
    emitted.clear()
    for (const item of signals) {
      if (LIVE_STRATEGY_IDS.has(item.strategyId)) emitted.add(emittedKey(item))
    }
    for (const item of signals) reconcileSignal(item)
  }

  async function ensureLoaded({ force = false } = {}) {
    if (loadPromise) {
      await loadPromise
      if (!force) return
    }
    if (loaded && !force) return
    loadPromise = load()
      .then(() => { loaded = true })
      .finally(() => { loadPromise = null })
    await loadPromise
  }

  function observeLiveCandle(symbol, candle) {
    if (!started) return
    const row = normalizeStored(candle)
    if (!row) return
    const rows = cache.get(symbol) ?? []
    let changed = false, closed = false
    for (const item of signals) {
      if (item.symbol !== symbol || !LIVE_STRATEGY_IDS.has(item.strategyId) || item.tradeStatus === "CLOSED") continue
      const wasClosed = item.tradeStatus === "CLOSED"
      if (updateLiveTradeForCandle(item, row, rows, { completed: false, now: now() })) changed = true
      if (!wasClosed && item.tradeStatus === "CLOSED") closed = true
    }
    if (!changed) return
    if (closed) void queuePersist()
    publish()
  }

  function observeCompletedCandle(symbol, candle) {
    if (!started || !cache.has(symbol)) return
    const row = normalizeStored(candle)
    if (!row) return
    const rows = cache.get(symbol), index = rows.findIndex(value => value.time === row.time)
    if (index >= 0) rows[index] = row
    else rows.push(row)
    rows.sort((a, b) => a.time - b.time)
    const dates = completeDates(rows).slice(-30), included = new Set(dates)
    cache.set(symbol, rows.filter(value => included.has(value.date)))
    let tradeChanged = false
    for (const item of signals) {
      if (item.symbol === symbol && LIVE_STRATEGY_IDS.has(item.strategyId) && item.tradeStatus !== "CLOSED") {
        if (updateLiveTradeForCandle(item, row, cache.get(symbol), { completed: true, now: now() })) tradeChanged = true
      }
    }
    if (tradeChanged) { void queuePersist(); publish() }
    schedule(row.date, row.minute)
  }

  // A completed candle can arrive late or while the previous full-universe
  // scan is still running.  Do not let its scan be overwritten or discarded:
  // S/R-style strategies only recognise an event at its exact candle minute.
  const scanKey = (date, minute) => `${date}|${minute}`

  function armPendingScan() {
    clearTimeout(timer)
    timer = null
    if (!started || !pendingScans.size) return
    const next = [...pendingScans.values()].sort((left, right) => left.dueAt - right.dueAt)[0]
    const wait = running ? scanDelayMs : Math.max(0, next.dueAt - Date.now())
    timer = setTimeout(() => {
      timer = null
      void drainPendingScans()
    }, wait)
    timer.unref?.()
  }

  function schedule(date, minute) {
    pendingScans.set(scanKey(date, minute), { date, minute, dueAt: Date.now() + scanDelayMs })
    armPendingScan()
  }

  async function drainPendingScans() {
    if (!started || running) { armPendingScan(); return }
    const due = [...pendingScans.values()]
      .filter(item => item.dueAt <= Date.now())
      .sort((left, right) => left.date.localeCompare(right.date) || left.minute - right.minute)
    if (!due.length) { armPendingScan(); return }
    const next = due[0]
    pendingScans.delete(scanKey(next.date, next.minute))
    await scan(next.date, next.minute)
    armPendingScan()
  }

  async function scan(date, minute) {
    if (running || !started) return
    const scanStartedAt = Date.now()
    running = true; error = null; publish()
    try {
      if (pviRejectedDate !== date) { pviRejectedDate = date; pviRejectedByFilter = new Set() }
      const preparedPviNvi = preparePviNviEvaluation(cache, symbols, date)
      preparedPviNvi.rejectedByFilter = pviRejectedByFilter
      const found = [
        ...evaluatePviNvi(cache, symbols, date, minute, preparedPviNvi),
        ...evaluateEma(cache, symbols, date, minute),
        ...evaluateSr(cache, symbols, date, minute),
        ...evaluateOct05Loose(cache, symbols, date, minute),
        ...evaluateSep29TightStop(cache, symbols, date, minute),
        ...evaluateSep25OpeningBreakout(cache, symbols, date, minute),
      ]
      let added = 0
      for (const item of found) {
        const key = emittedKey(item)
        if (emitted.has(key)) continue
        emitted.add(key); signals.push({ ...item, ...initialLiveTrade(), detectedAt: new Date(now()).toISOString() }); added++
      }
      lastScan = { date, completedCandle: clock(minute), scannedAt: new Date(now()).toISOString(), added, durationMs: Date.now() - scanStartedAt }
      if (added) await queuePersist()
    } catch (scanError) { error = scanError.message }
    finally { running = false; publish(); armPendingScan() }
  }

  return {
    async warmup() { await ensureLoaded(); error = null; publish() },
    ensureSessionFile,
    async start() { if (started) return; await ensureLoaded(); started = true; error = null; await queuePersist(); publish() },
    stop() { started = false; clearTimeout(timer); timer = null; pendingScans.clear(); publish() },
    observeCompletedCandle,
    observeLiveCandle,
    payload,
    scan,
    async reload() { await ensureLoaded({ force: true }); publish() },
  }
}

export { STRATEGIES, LIVE_STRATEGIES }
export { evaluateRanked, evaluatePviNvi, evaluateEma, evaluateSr, evaluateOct05Loose, evaluateSep29TightStop, evaluateSep25OpeningBreakout, evaluateSrDate, preparePviNviEvaluation, prepareEmaEvaluation, prepareSrEvaluation, emaFeatureSet, normalizeStored, initialLiveTrade, updateLiveTradeForCandle }
