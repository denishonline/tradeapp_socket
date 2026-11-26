#!/usr/bin/env node
/**
 * Chronological, strategy-agnostic candle replay.
 *
 * A strategy is an ES module exporting `onCandle(context)`.  It is called only
 * after a one-minute candle has completed, and `context.history` contains that
 * symbol's candles through that candle only.  Return one signal or an array:
 *   { side: 'BUY' | 'SELL' }
 * A strategy with exits can export `reportsReturn = true` and include
 * `returnPct` on its chronological exit event. Entry rows then have an empty
 * fourth column and exit rows contain the realized percentage return.
 *
 * Usage:
 *   node scripts/backTest.js --day 2026-10-16
 *   node scripts/backTest.js --strategy ./my-strategy.js --day 2026-10-16 12:00
 *   node scripts/backTest.js --strategy ./my-strategy.js --from 2026-10-16 09:15 --to 2026-10-16 15:30
 *
 * `--day DATE HH:mm` replays from the NSE session open and emits through the
 * supplied cutoff (inclusive). Without HH:mm it runs through the configured
 * intraday exit boundary at 15:00 IST.
 * The emitted columns are deliberately machine-friendly: STOCK<TAB>TIME<TAB>SIDE.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const IST = '+05:30'
const SESSION_OPEN = '09:15'
const SESSION_CLOSE = '15:00'
const MINUTE = 60

const fail = message => { process.stderr.write(`${message}\n`); process.exitCode = 1 }
const usage = () => fail('Usage: node scripts/backTest.js [--strategy <module>] (--day YYYY-MM-DD [HH:mm] | --from YYYY-MM-DD HH:mm --to YYYY-MM-DD HH:mm) [--symbols ABC,XYZ]')
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] }
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')
const epoch = (day, time) => Date.parse(`${day}T${time}:00${IST}`) / 1000
const formatTime = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const timeOf = seconds => formatTime(seconds).slice(11)

function options() {
  const strategy = argument('--strategy') ?? 'strategies/ema10-ema20-cross.js'
  const day = argument('--day'), fromDay = argument('--from'), toDay = argument('--to')
  if ((day && (fromDay || toDay)) || (!day && (!fromDay || !toDay))) return null
  if (day) {
    const dayIndex = process.argv.indexOf('--day'), suppliedTime = process.argv[dayIndex + 2]
    const hasTime = validTime(suppliedTime)
    if (!validDate(day) || (suppliedTime && suppliedTime.startsWith('--') === false && !hasTime)) return null
    const start = epoch(day, SESSION_OPEN)
    // Candle timestamps are opening times; signals are emitted at close.
    const end = hasTime ? epoch(day, suppliedTime) : epoch(day, SESSION_CLOSE)
    return { strategy, start, end, symbols: argument('--symbols'), replayStart: epoch(day, SESSION_OPEN) }
  }
  const fromTime = process.argv[process.argv.indexOf('--from') + 2]
  const toTime = process.argv[process.argv.indexOf('--to') + 2]
  if (!validDate(fromDay) || !validDate(toDay) || !validTime(fromTime) || !validTime(toTime)) return null
  const start = epoch(fromDay, fromTime), end = epoch(toDay, toTime)
  if (end < start) return null
  return { strategy, start, end, symbols: argument('--symbols'), replayStart: epoch(fromDay, SESSION_OPEN) }
}

function listedSymbols(raw) {
  if (raw) return [...new Set(raw.split(',').map(value => value.trim().toUpperCase()).filter(Boolean))]
  const file = path.join(ROOT, 'db', 'stocks')
  if (!fs.existsSync(file)) throw new Error('db/stocks is missing; pass --symbols instead.')
  return [...new Set(JSON.parse(fs.readFileSync(file, 'utf8')).map(value => String(value).trim().toUpperCase().replace(/-EQ$/, '')))]
}

function loadCandles(symbol, replayStart, end) {
  const file = path.join(ROOT, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const byTime = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line), time = Number(row.time)
      if (!Number.isInteger(time) || time < replayStart || time + MINUTE > end ||
        ![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)) continue
      // Do not replay pre-/post-market rows as cash-session strategy candles.
      const clock = timeOf(time)
      if (clock < SESSION_OPEN || clock >= SESSION_CLOSE) continue
      byTime.set(time, Object.freeze({ time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }))
    } catch { /* malformed historical line: ignore */ }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

async function loadStrategy(file) {
  const resolved = path.resolve(ROOT, file)
  const module = await import(pathToFileURL(resolved).href)
  if (typeof module.onCandle !== 'function') throw new Error(`${file} must export function onCandle(context).`)
  return module
}

async function main() {
  const config = options()
  if (!config || process.argv.includes('--help')) return usage()
  const interactiveProgress = Boolean(process.stderr.isTTY)
  const startupProgress = 'Running backtest | loading strategy and candles...'
  process.stderr.write(interactiveProgress ? `\r${startupProgress}` : `${startupProgress}\n`)
  const strategy = await loadStrategy(config.strategy)
  const includeReturn = strategy.reportsReturn === true
  const symbols = listedSymbols(config.symbols)
  const events = []
  for (const symbol of symbols) {
    for (const candle of loadCandles(symbol, config.replayStart, config.end)) events.push({ symbol, candle })
  }
  // Same close time is ordered by symbol only for deterministic output. Neither
  // strategy receives another symbol's current/future bar in its context.
  events.sort((a, b) => a.candle.time - b.candle.time || a.symbol.localeCompare(b.symbol))
  const histories = new Map()
  let outputRows = 0, progressText = interactiveProgress ? startupProgress : '', lastPercent = -1
  const clearProgress = () => {
    if (!interactiveProgress || !progressText) return
    process.stderr.write(`\r${' '.repeat(progressText.length)}\r`)
    progressText = ''
  }
  const tableColumns = [
    { key: 'stock', title: 'STOCK', width: 18 },
    { key: 'signalAt', title: 'SIGNAL AT', width: 16 },
    { key: 'entryAt', title: 'ENTRY AT', width: 8 },
    { key: 'exitAt', title: 'EXIT AT', width: 8 },
    { key: 'slAt', title: 'SL AT', width: 8 },
    { key: 'side', title: 'SIDE', width: 4 },
    ...(includeReturn ? [{ key: 'return', title: 'RETURN', width: 12 }] : [])
  ]
  const tableBorder = `+${tableColumns.map(column => '-'.repeat(column.width + 2)).join('+')}+`
  const tableRow = values => `|${tableColumns.map(column => ` ${String(values[column.key] ?? '').slice(0, column.width).padEnd(column.width)} `).join('|')}|`
  const showProgress = (checked, completedTime, force = false) => {
    if (!interactiveProgress) {
      return
    }
    const percent = events.length ? Math.floor(100 * checked / events.length) : 100
    if (!force && percent === lastPercent) return
    lastPercent = percent
    const text = `Checking ${completedTime ?? '-'} | ${percent}% | ${checked}/${events.length} candles | ${outputRows} rows`
    process.stderr.write(`\r${text.padEnd(progressText.length)}`)
    progressText = text
  }
  clearProgress()
  process.stdout.write(`${tableBorder}\n${tableRow(Object.fromEntries(tableColumns.map(column => [column.key, column.title])))}\n${tableBorder}\n`)
  showProgress(0, events[0] ? formatTime(events[0].candle.time + MINUTE) : null, true)
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const { symbol, candle } = events[eventIndex]
    const history = histories.get(symbol) ?? []
    history.push(candle)
    histories.set(symbol, history)
    const completedAt = candle.time + MINUTE
    const context = Object.freeze({
      symbol,
      candle,
      completedAt,
      completedTime: formatTime(completedAt),
      history: Object.freeze([...history]),
      nextEntryAt: completedAt + MINUTE,
      isSessionExit: timeOf(completedAt) === SESSION_CLOSE,
      sessionExitTime: SESSION_CLOSE
    })
    const found = await strategy.onCandle(context)
    if (completedAt >= config.start && completedAt <= config.end && found != null) {
      for (const signal of (Array.isArray(found) ? found : [found])) {
        const side = String(signal?.side ?? '').toUpperCase()
        if (side !== 'BUY' && side !== 'SELL') throw new Error(`${config.strategy} returned an invalid side for ${symbol} at ${context.completedTime}.`)
        const returnPct = signal?.returnPct
        if (returnPct != null && !Number.isFinite(returnPct)) throw new Error(`${config.strategy} returned an invalid returnPct for ${symbol} at ${context.completedTime}.`)
        clearProgress()
        const action = String(signal?.action ?? (returnPct == null ? 'SIGNAL' : 'EXIT')).toUpperCase()
        const clockOnly = value => value ? String(value).slice(-5) : ''
        const values = {
          stock: symbol,
          signalAt: signal?.signalAt ?? '',
          entryAt: clockOnly(signal?.entryAt),
          exitAt: clockOnly(signal?.exitAt ?? (action === 'EXIT' ? context.completedTime : '')),
          slAt: clockOnly(signal?.slAt),
          side
        }
        if (!values.entryAt) continue
        if (includeReturn) values.return = returnPct == null ? '' : `${Number(returnPct.toFixed(4))}%`
        // Write synchronously in event order: the signal becomes visible immediately.
        process.stdout.write(`${tableRow(values)}\n`)
        outputRows++
        showProgress(eventIndex + 1, context.completedTime, true)
      }
    }
    showProgress(eventIndex + 1, context.completedTime)
  }
  clearProgress()
  process.stdout.write(`${tableBorder}\n`)
  process.stderr.write(`Backtest complete: ${outputRows} rows; ${events.length} completed candles replayed chronologically.\n`)
}

main().catch(error => fail(`Backtest failed: ${error.message}`))
