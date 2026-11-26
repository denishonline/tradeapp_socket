import fs from "node:fs"
import path from "node:path"

const IST_SECONDS = 330 * 60
const SESSION_OPEN_MINUTE = 9 * 60 + 15
const SESSION_LAST_MINUTE = 15 * 60 + 29
const BARS_PER_SESSION_15M = 25

export const DEFAULT_PARAMS = Object.freeze({
  supertrendAtrPeriod: 10,
  supertrendMultiplier: 3,
  pviEmaPeriod: 255,
  priorPviSessions: 2,
  minPriorGreenSupertrendBarsExclusive: 50,
  minOpeningGapPctExclusive: 0,
  maxOpeningGapPctInclusive: 2,
  ema20StartTime: "09:25",
  ema20EndTime: "09:29",
  minEma20ChangePctInclusive: -0.005,
  minFyers15mVwapGapPctInclusive: 0.04,
})

export const FILTER_NAMES = Object.freeze([
  "First 15m candle is red and closes above Fyers 15m session VWAP",
  "First 15m candle closes above green Supertrend",
  "PVI-EMA is continuously rising through both prior completed sessions",
  "Prior consecutive green 15m Supertrend bars exceed the configured threshold",
  "Opening gap is positive and 1m EMA20 change meets the configured minimum",
  "Opening gap is within the maximum and the 15m VWAP clearance meets the minimum",
])

const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const dayNumber = (seconds) => Math.floor((seconds + IST_SECONDS) / 86400)
const minuteOfDay = (seconds) => Math.floor(((seconds + IST_SECONDS) % 86400) / 60)
const dateToDayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000)
const minuteFromTime = (time) => {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`Invalid time: ${time}`)
  const [hour, minute] = time.split(":").map(Number)
  if (hour > 23 || minute > 59) throw new Error(`Invalid time: ${time}`)
  return hour * 60 + minute
}

export function normalizeSymbol(value) {
  return String(value).trim().toUpperCase().replace(/^NSE:/, "").replace(/-EQ$/, "")
}

export function loadSymbols(root, supplied = null) {
  if (supplied?.length) return [...new Set(supplied.map(normalizeSymbol).filter(Boolean))]
  const stocksFile = path.join(root, "db", "stocks")
  if (fs.existsSync(stocksFile)) {
    const rows = JSON.parse(fs.readFileSync(stocksFile, "utf8"))
    return [...new Set(rows.map(normalizeSymbol).filter(Boolean))]
  }
  return fs.readdirSync(path.join(root, "db", "candles"))
    .filter((file) => file.endsWith(".jsonl") && file !== "NIFTY50.jsonl")
    .map((file) => file.slice(0, -6))
    .sort()
}

function readCandles(root, symbol) {
  const file = path.join(root, "db", "candles", `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const unique = new Map()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const raw = JSON.parse(line)
      const row = {
        time: Number(raw.time),
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
        volume: Number(raw.volume),
      }
      if ([row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)) unique.set(row.time, row)
    } catch {
      // Ignore malformed JSONL rows and continue with the remaining source data.
    }
  }
  return [...unique.values()].sort((a, b) => a.time - b.time)
}

function buildFifteenMinuteBars(candles) {
  const grouped = new Map()
  for (const row of candles) {
    const minute = minuteOfDay(row.time)
    if (minute < SESSION_OPEN_MINUTE || minute > SESSION_LAST_MINUTE) continue
    const day = dayNumber(row.time)
    const bucket = Math.floor((minute - SESSION_OPEN_MINUTE) / 15)
    const key = `${day}/${bucket}`
    let bar = grouped.get(key)
    if (!bar) {
      bar = {
        day,
        bucket,
        time: row.time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: 0,
        minuteCount: 0,
      }
      grouped.set(key, bar)
    }
    bar.high = Math.max(bar.high, row.high)
    bar.low = Math.min(bar.low, row.low)
    bar.close = row.close
    bar.volume += row.volume
    bar.minuteCount += 1
  }
  return [...grouped.values()]
    .filter((bar) => bar.minuteCount === 15)
    .sort((a, b) => a.day - b.day || a.bucket - b.bucket)
}

function addFifteenMinuteIndicators(bars, params) {
  let atr = null
  let pvi = 1000
  let pviEma = 1000
  const pviAlpha = 2 / (params.pviEmaPeriod + 1)

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]
    const previous = bars[index - 1]
    const trueRange = previous
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close))
      : bar.high - bar.low
    atr = atr === null ? trueRange : ((params.supertrendAtrPeriod - 1) * atr + trueRange) / params.supertrendAtrPeriod

    const midpoint = (bar.high + bar.low) / 2
    const basicUpper = midpoint + params.supertrendMultiplier * atr
    const basicLower = midpoint - params.supertrendMultiplier * atr
    if (!previous) {
      bar.finalUpper = basicUpper
      bar.finalLower = basicLower
      bar.supertrend = basicUpper
      bar.supertrendGreen = false
    } else {
      bar.finalUpper = basicUpper < previous.finalUpper || previous.close > previous.finalUpper ? basicUpper : previous.finalUpper
      bar.finalLower = basicLower > previous.finalLower || previous.close < previous.finalLower ? basicLower : previous.finalLower
      bar.supertrend = previous.supertrend === previous.finalUpper
        ? (bar.close <= bar.finalUpper ? bar.finalUpper : bar.finalLower)
        : (bar.close >= bar.finalLower ? bar.finalLower : bar.finalUpper)
      bar.supertrendGreen = bar.supertrend === bar.finalLower

      if (bar.volume > previous.volume) pvi *= bar.close / previous.close
      pviEma = pviAlpha * pvi + (1 - pviAlpha) * pviEma
    }
    bar.pvi = pvi
    bar.pviEma = pviEma
  }
}

function buildOneMinuteEma(candles, period) {
  const alpha = 2 / (period + 1)
  const values = new Map()
  let current = null
  for (const row of candles) {
    current = current === null ? row.close : alpha * row.close + (1 - alpha) * current
    values.set(row.time, current)
  }
  return values
}

function stageSummary() {
  return FILTER_NAMES.map((filter, index) => ({ stage: index + 1, filter, count: 0 }))
}

function targetMinute(candles, targetDay, minute) {
  return candles.find((row) => dayNumber(row.time) === targetDay && minuteOfDay(row.time) === minute)
}

function prepareSymbol(root, symbol, params) {
  const candles = readCandles(root, symbol)
  if (!candles.length) return null
  const bars15m = buildFifteenMinuteBars(candles)
  addFifteenMinuteIndicators(bars15m, params)
  const ema20 = buildOneMinuteEma(candles, 20)
  const completeSessionDays = [...new Set(bars15m.map((bar) => bar.day))]
    .filter((day) => bars15m.filter((bar) => bar.day === day).length === BARS_PER_SESSION_15M)
    .sort((a, b) => a - b)
  return { candles, bars15m, ema20, completeSessionDays }
}

function evaluatePrepared(symbol, prepared, date, params) {
  const targetDay = dateToDayNumber(date)
  const openingIndex = prepared.bars15m.findIndex((bar) => bar.day === targetDay && bar.bucket === 0)
  if (openingIndex < 0) return { evaluable: false }
  const opening = prepared.bars15m[openingIndex]
  const fyers15mVwap = (opening.high + opening.low + opening.close) / 3
  const stagePass = []

  stagePass[0] = opening.close < opening.open && opening.close > fyers15mVwap
  if (!stagePass[0]) return { evaluable: true, stagePass }

  stagePass[1] = opening.supertrendGreen && opening.close > opening.supertrend
  if (!stagePass[1]) return { evaluable: true, stagePass }

  const priorDays = prepared.completeSessionDays.filter((day) => day < targetDay).slice(-params.priorPviSessions)
  const priorBars = prepared.bars15m.filter((bar) => priorDays.includes(bar.day))
  stagePass[2] = priorDays.length === params.priorPviSessions
    && priorBars.length === params.priorPviSessions * BARS_PER_SESSION_15M
    && priorBars.every((bar, index) => index === 0 || bar.pviEma > priorBars[index - 1].pviEma)
  if (!stagePass[2]) return { evaluable: true, stagePass }

  let priorGreenSupertrendBars = 0
  for (let index = openingIndex - 1; index >= 0 && prepared.bars15m[index].supertrendGreen; index -= 1) priorGreenSupertrendBars += 1
  stagePass[3] = priorGreenSupertrendBars > params.minPriorGreenSupertrendBarsExclusive
  if (!stagePass[3]) return { evaluable: true, stagePass }

  const previousSessionBar = prepared.bars15m[openingIndex - 1]
  const openingGapPct = previousSessionBar ? 100 * (opening.open / previousSessionBar.close - 1) : null
  const emaStartMinute = minuteFromTime(params.ema20StartTime)
  const emaEndMinute = minuteFromTime(params.ema20EndTime)
  const emaStartCandle = targetMinute(prepared.candles, targetDay, emaStartMinute)
  const emaEndCandle = targetMinute(prepared.candles, targetDay, emaEndMinute)
  const emaStart = emaStartCandle ? prepared.ema20.get(emaStartCandle.time) : null
  const emaEnd = emaEndCandle ? prepared.ema20.get(emaEndCandle.time) : null
  const ema20ChangePct = Number.isFinite(emaStart) && Number.isFinite(emaEnd) ? 100 * (emaEnd / emaStart - 1) : null
  stagePass[4] = Number.isFinite(openingGapPct)
    && openingGapPct > params.minOpeningGapPctExclusive
    && Number.isFinite(ema20ChangePct)
    && ema20ChangePct >= params.minEma20ChangePctInclusive
  if (!stagePass[4]) return { evaluable: true, stagePass }

  const fyers15mVwapGapPct = 100 * (opening.close / fyers15mVwap - 1)
  stagePass[5] = openingGapPct <= params.maxOpeningGapPctInclusive
    && fyers15mVwapGapPct >= params.minFyers15mVwapGapPctInclusive
  if (!stagePass[5]) return { evaluable: true, stagePass }

  return {
    evaluable: true,
    stagePass,
    match: {
      date,
      symbol,
      first15mOpen: round(opening.open),
      first15mHigh: round(opening.high),
      first15mLow: round(opening.low),
      first15mClose: round(opening.close),
      fyers15mVwap: round(fyers15mVwap),
      fyers15mVwapGapPct: round(fyers15mVwapGapPct, 6),
      supertrend: round(opening.supertrend),
      priorPviSessions: priorDays.map((day) => new Date(day * 86400000).toISOString().slice(0, 10)),
      priorPviEmaStart: round(priorBars[0].pviEma, 6),
      priorPviEmaEnd: round(priorBars.at(-1).pviEma, 6),
      priorGreenSupertrendBars,
      previousSessionClose: round(previousSessionBar.close),
      openingGapPct: round(openingGapPct, 6),
      ema20StartTime: params.ema20StartTime,
      ema20EndTime: params.ema20EndTime,
      ema20ChangePct: round(ema20ChangePct, 6),
    },
  }
}

export function scanOpeningSixFilters({ root = process.cwd(), dates, symbols = null, params = {} }) {
  const effectiveParams = { ...DEFAULT_PARAMS, ...params }
  const universe = loadSymbols(root, symbols)
  const sessions = new Map(dates.map((date) => [date, { date, evaluableSymbols: 0, stages: stageSummary(), matches: [] }]))
  const missingSymbols = []

  for (const symbol of universe) {
    const prepared = prepareSymbol(root, symbol, effectiveParams)
    if (!prepared) {
      missingSymbols.push(symbol)
      continue
    }
    for (const date of dates) {
      const session = sessions.get(date)
      const result = evaluatePrepared(symbol, prepared, date, effectiveParams)
      if (!result.evaluable) continue
      session.evaluableSymbols += 1
      for (let index = 0; index < result.stagePass.length && result.stagePass[index]; index += 1) session.stages[index].count += 1
      if (result.match) session.matches.push(result.match)
    }
  }

  const sessionRows = [...sessions.values()]
  for (const session of sessionRows) session.matches.sort((a, b) => a.symbol.localeCompare(b.symbol))
  return {
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Kolkata",
    signalKnownAt: "09:29 IST after the first 15-minute candle completes",
    mode: "historical filter scan; no P&L because no exit rule is defined",
    params: effectiveParams,
    universeSize: universe.length,
    missingSymbols,
    sessions: sessionRows,
  }
}

export function datesInclusive(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error(`Invalid date range: ${from} to ${to}`)
  const dates = []
  for (let time = start; time <= end; time += 86400000) dates.push(new Date(time).toISOString().slice(0, 10))
  return dates
}

export function uniqueReportPath(root, baseName, extension) {
  const reports = path.join(root, "reports")
  fs.mkdirSync(reports, { recursive: true })
  let index = 1
  let file
  do {
    file = path.join(reports, `${baseName}${index === 1 ? "" : `-${index}`}.${extension}`)
    index += 1
  } while (fs.existsSync(file))
  return file
}

function csvCell(value) {
  if (Array.isArray(value)) value = value.join("|")
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function matchesCsv(result) {
  const columns = [
    "date", "symbol", "first15mOpen", "first15mHigh", "first15mLow", "first15mClose",
    "fyers15mVwap", "fyers15mVwapGapPct", "supertrend", "priorPviSessions",
    "priorPviEmaStart", "priorPviEmaEnd", "priorGreenSupertrendBars", "previousSessionClose",
    "openingGapPct", "ema20StartTime", "ema20EndTime", "ema20ChangePct",
  ]
  const rows = result.sessions.flatMap((session) => session.matches)
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}${rows.length ? "\n" : ""}`
}

