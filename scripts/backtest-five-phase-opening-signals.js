import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function parseArgs(argv) {
  const out = {}, positional = []
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue }
    const [key, inline] = argv[i].slice(2).split('=', 2)
    out[key] = inline ?? argv[++i]
  }
  return { out, positional }
}

const { out: args, positional } = parseArgs(process.argv.slice(2))
if (process.argv.includes('--help')) {
  console.log(`Usage:
  node scripts/backtest-five-phase-opening-signals.js --date 2026-11-11 --start 09:15 --cutoff 09:40
  node scripts/backtest-five-phase-opening-signals.js --from-date 2026-11-05 --to-date 2026-11-11 --start 09:15 --cutoff 09:40

Options:
  --date YYYY-MM-DD            Single-session scan
  --from-date YYYY-MM-DD       First session for range backtest
  --to-date YYYY-MM-DD         Last session for range backtest
  --start HH:MM                Pattern-window start; default 09:15
  --cutoff HH:MM               Signal cutoff; default 09:40
  --signal-mode rolling|cutoff Default rolling; cutoff preserves snapshot mode
  --live true|false            Single date defaults true; date range defaults false
  --side buy|sell|both         Default both
  --stop-loss-pct N            Default 0.7
  --min-opening-body N         Default 0.10 percent
  --min-opening-excursion N    Default 0.20 percent
  --min-impulse N              Default 0.30 percent
  --min-pullback N             Default 0.15 percent
  --min-renewed N              Default 0.15 percent
  --close-location N           Default 80 percent (top/bottom 20%)
  --quality-filter true|false  Participation/trend gate; default true
  --min-relative-volume N      Default 1.5
  --min-volume-percentile N    Default 85
  --min-10m-body N             Directional body percent; default 0.30
  --min-ema20-angle N          Directional angle degrees; default 2.0
  --format table|json          Default table
  --progress true|false        Default true for table output
`)
  process.exit(0)
}

const singleDate = args.date ?? positional[0] ?? null
const fromDate = args['from-date'] ?? singleDate
const toDate = args['to-date'] ?? singleDate
const startTime = args.start ?? '09:15'
const cutoffTime = args.cutoff ?? args.end ?? '09:40'
const signalMode = (args['signal-mode'] ?? 'rolling').toLowerCase()
const liveMode = args.live == null ? fromDate === toDate : args.live === 'true'
const scanSide = (args.side ?? 'both').toLowerCase()
const stopLossPct = +(args['stop-loss-pct'] ?? 0.7)
const minOpeningBodyPct = +(args['min-opening-body'] ?? 0.10)
const minOpeningExcursionPct = +(args['min-opening-excursion'] ?? 0.20)
const minImpulsePct = +(args['min-impulse'] ?? 0.30)
const minPullbackPct = +(args['min-pullback'] ?? 0.15)
const minRenewedPct = +(args['min-renewed'] ?? 0.15)
const minCloseLocationPct = +(args['close-location'] ?? 80)
const qualityFilterEnabled = args['quality-filter'] !== 'false'
const minRelativeVolume = +(args['min-relative-volume'] ?? 1.5)
const minVolumePercentile = +(args['min-volume-percentile'] ?? 85)
const min10mBodyPct = +(args['min-10m-body'] ?? 0.30)
const minEma20AngleDeg = +(args['min-ema20-angle'] ?? 2.0)
const outputFormat = (args.format ?? 'table').toLowerCase()
const progressEnabled = args.progress === 'true' || (args.progress !== 'false' && outputFormat === 'table')

if (!fromDate || !toDate) throw new Error('Provide --date or both --from-date and --to-date')
if (![fromDate, toDate].every(x => /^\d{4}-\d{2}-\d{2}$/.test(x)) || toDate < fromDate) throw new Error('Invalid or unordered date range')
if (![startTime, cutoffTime].every(x => /^\d{2}:\d{2}$/.test(x)) || cutoffTime <= startTime) throw new Error('Use ordered --start/--cutoff times in HH:MM')
if (!['buy', 'sell', 'both'].includes(scanSide)) throw new Error('--side must be buy, sell, or both')
if (!['rolling', 'cutoff'].includes(signalMode)) throw new Error('--signal-mode must be rolling or cutoff')
if (!['table', 'json'].includes(outputFormat)) throw new Error('--format must be table or json')
if (args.live != null && !['true', 'false'].includes(args.live)) throw new Error('--live must be true or false')
if (args['quality-filter'] != null && !['true', 'false'].includes(args['quality-filter'])) throw new Error('--quality-filter must be true or false')
if (liveMode && fromDate !== toDate) throw new Error('--live true requires a single --date')

const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const sum = xs => xs.reduce((a, b) => a + b, 0)
const mean = xs => xs.length ? sum(xs) / xs.length : NaN
const ema = (xs, period) => {
  if (!xs.length) return []
  const alpha = 2 / (period + 1), out = []; let value = xs[0]
  for (const x of xs) { value = alpha * x + (1 - alpha) * value; out.push(value) }
  return out
}
const trendAngle = values => {
  if (values.length < 2 || values.some(x => !(x > 0))) return NaN
  const ys = values.map(Math.log), mx = (values.length - 1) / 2, my = mean(ys)
  const denominator = sum(ys.map((_, i) => (i - mx) ** 2))
  const slope = sum(ys.map((y, i) => (i - mx) * (y - my))) / denominator
  return Math.atan(100 * slope) * 180 / Math.PI
}
const universe = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).replace(/-EQ$/i, '').toUpperCase()))]

function sessionCalendar() {
  const file = path.join(root, 'db', 'candles', 'NIFTY50.jsonl')
  const dates = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const date = local(+JSON.parse(line).time).slice(0, 10)
      if (date >= fromDate && date <= toDate) dates.add(date)
    } catch {}
  }
  return [...dates].sort()
}

function loadSymbol(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const stamp = local(+x.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
    if (date > toDate || minute < '09:15' || minute > '15:29') continue
    if (![x.open, x.high, x.low, x.close, x.volume].every(v => Number.isFinite(+v))) continue
    unique.set(stamp, { stamp, date, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
  }
  const rows = [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
  if (!rows.length) return rows
  let ema20 = rows[0].close, ema40 = rows[0].close
  const a20 = 2 / 21, a40 = 2 / 41
  for (const row of rows) {
    ema20 = a20 * row.close + (1 - a20) * ema20
    ema40 = a40 * row.close + (1 - a40) * ema40
    row.ema20 = ema20; row.ema40 = ema40
  }
  return rows
}

function detectPattern(window, side) {
  const n = window.length
  if (n < 10) return null
  const first = window[0], last = window.at(-1), direction = side === 'BUY' ? 1 : -1
  const openingBodyPct = 100 * direction * (first.close / first.open - 1)
  const earlyExtreme = side === 'BUY' ? Math.min(window[0].low, window[1].low) : Math.max(window[0].high, window[1].high)
  const openingExcursionPct = 100 * direction * (earlyExtreme / first.open - 1)
  const reverseOpening = openingBodyPct <= -minOpeningBodyPct && openingExcursionPct <= -minOpeningExcursionPct
  const impulseEnd = Math.max(3, Math.min(n - 5, Math.floor((n - 1) * 0.58)))
  let impulseIndex = 2
  for (let i = 3; i <= impulseEnd; i++) {
    if ((side === 'BUY' && window[i].close > window[impulseIndex].close) || (side === 'SELL' && window[i].close < window[impulseIndex].close)) impulseIndex = i
  }
  const impulsePct = 100 * direction * (window[impulseIndex].close / first.close - 1)
  const strongImpulse = impulsePct >= minImpulsePct
  const pullbackEnd = n - 4
  let pullbackIndex = impulseIndex + 2
  if (pullbackIndex > pullbackEnd) return null
  for (let i = pullbackIndex + 1; i <= pullbackEnd; i++) {
    if ((side === 'BUY' && window[i].close < window[pullbackIndex].close) || (side === 'SELL' && window[i].close > window[pullbackIndex].close)) pullbackIndex = i
  }
  const pullbackPct = 100 * -direction * (window[pullbackIndex].close / window[impulseIndex].close - 1)
  const hasPullback = pullbackPct >= minPullbackPct
  const renewedPct = 100 * direction * (last.close / window[pullbackIndex].close - 1)
  const renewed = renewedPct >= minRenewedPct
  const high = Math.max(...window.map(x => x.high)), low = Math.min(...window.map(x => x.low))
  const closeLocationPct = 100 * (last.close - low) / (high - low || 1)
  const finalBodyPct = 100 * direction * (last.close / last.open - 1)
  const locatedAtExtreme = side === 'BUY' ? closeLocationPct >= minCloseLocationPct : closeLocationPct <= 100 - minCloseLocationPct
  const finalPush = side === 'BUY'
    ? last.close > window.at(-2).close && last.close >= window.at(-4).close
    : last.close < window.at(-2).close && last.close <= window.at(-4).close
  const freshPush = renewed && locatedAtExtreme && finalPush
  const eligible = reverseOpening && strongImpulse && hasPullback && renewed && freshPush
  return { eligible, openingBodyPct, openingExcursionPct, impulseIndex, impulsePct, pullbackIndex, pullbackPct, renewedPct, closeLocationPct, finalBodyPct }
}

function qualityGate(all, signalWindow, side) {
  const date = signalWindow[0].date, signalMinute = signalWindow.at(-1).minute, direction = side === 'BUY' ? 1 : -1
  const priorDates = [...new Set(all.filter(x => x.date < date).map(x => x.date))].slice(-20)
  const currentVolume = sum(signalWindow.map(x => x.volume))
  const priorVolumes = priorDates.map(priorDate => {
    const rows = all.filter(x => x.date === priorDate && x.minute >= startTime && x.minute <= signalMinute)
    return rows.length === signalWindow.length ? sum(rows.map(x => x.volume)) : NaN
  })
  const volumeCoverage = priorDates.length === 20 && priorVolumes.every(Number.isFinite)
  const relativeVolume = volumeCoverage ? currentVolume / mean(priorVolumes) : NaN
  const volumePercentile = volumeCoverage ? 100 * priorVolumes.filter(x => x < currentVolume).length / priorVolumes.length : NaN
  const completed10mCount = Math.floor(signalWindow.length / 10)
  const last10m = completed10mCount ? signalWindow.slice((completed10mCount - 1) * 10, completed10mCount * 10) : []
  const directional10mBodyPct = last10m.length === 10 ? 100 * direction * (last10m.at(-1).close / last10m[0].open - 1) : NaN
  const ema20AngleDeg = trendAngle(ema(signalWindow.map(x => x.close), 20))
  const directionalEma20AngleDeg = direction * ema20AngleDeg
  const passed = volumeCoverage && relativeVolume >= minRelativeVolume && volumePercentile >= minVolumePercentile && directional10mBodyPct >= min10mBodyPct && directionalEma20AngleDeg >= minEma20AngleDeg
  return { passed, relativeVolume, volumePercentile, directional10mBodyPct, directionalEma20AngleDeg }
}

function simulateTrade(day, entryIndex, side) {
  const direction = side === 'BUY' ? 1 : -1
  const entry = day[entryIndex], entryPrice = entry.close
  const stopPrice = entryPrice * (1 - direction * stopLossPct / 100)
  let exit = null, mae = 0
  for (let i = entryIndex + 1; i < day.length; i++) {
    const candle = day[i]
    const adverse = side === 'BUY' ? 100 * (candle.low / entryPrice - 1) : 100 * (1 - candle.high / entryPrice)
    mae = Math.min(mae, adverse)
    const stopGap = side === 'BUY' ? candle.open <= stopPrice : candle.open >= stopPrice
    const stopTouched = side === 'BUY' ? candle.low <= stopPrice : candle.high >= stopPrice
    if (stopGap) { exit = { time: candle.stamp, price: candle.open, reason: 'stop-gap' }; break }
    if (stopTouched) { exit = { time: candle.stamp, price: stopPrice, reason: 'stop-loss' }; break }
    const prev = day[i - 1], current = candle
    const adverseCross = side === 'BUY'
      ? prev.ema20 >= prev.ema40 && current.ema20 < current.ema40
      : prev.ema20 <= prev.ema40 && current.ema20 > current.ema40
    if (adverseCross) {
      const next = day[i + 1]
      const reason = side === 'BUY' ? 'EMA20-cross-below-EMA40' : 'EMA20-cross-above-EMA40'
      exit = next ? { time: next.stamp, price: next.open, reason } : { time: candle.stamp, price: candle.close, reason: `${reason}-EOD` }
      break
    }
  }
  if (!exit) { const last = day.at(-1); exit = { time: last.stamp, price: last.close, reason: 'end-of-day' } }
  return {
    entry_time: entry.stamp, entry_price: round(entryPrice), stop_price: round(stopPrice),
    exit_time: exit.time, exit_price: round(exit.price), exit_reason: exit.reason,
    return_pct: round(100 * direction * (exit.price / entryPrice - 1)), maximum_adverse_excursion_pct: round(mae)
  }
}

function liveTrade(day, entryIndex, side) {
  const entryKnown = entryIndex >= 0 && entryIndex < day.length && day[entryIndex].minute <= cutoffTime
  if (!entryKnown) return { entry_time: '', entry_price: '', stop_price: '', exit_time: '', exit_price: '', exit_reason: 'awaiting-next-candle-entry', return_pct: '', maximum_adverse_excursion_pct: '' }
  const entry = day[entryIndex], direction = side === 'BUY' ? 1 : -1
  return {
    entry_time: entry.stamp, entry_price: round(entry.close), stop_price: round(entry.close * (1 - direction * stopLossPct / 100)),
    exit_time: '', exit_price: '', exit_reason: 'live-position-unresolved', return_pct: '', maximum_adverse_excursion_pct: ''
  }
}

const sessions = sessionCalendar(), signals = [], coverage = { universe: universe.length, symbolsWithData: 0, completeWindows: 0 }
for (let s = 0; s < universe.length; s++) {
  const symbol = universe[s], all = loadSymbol(symbol)
  if (all.length) coverage.symbolsWithData++
  for (const date of sessions) {
    const day = all.filter(x => x.date === date)
    const window = day.filter(x => x.minute >= startTime && x.minute <= cutoffTime)
    const expected = Math.round((Date.parse(`2000-01-01T${cutoffTime}:00Z`) - Date.parse(`2000-01-01T${startTime}:00Z`)) / 60000) + 1
    if (window.length !== expected) continue
    coverage.completeWindows++
    for (const side of ['BUY', 'SELL']) {
      if (scanSide !== 'both' && scanSide !== side.toLowerCase()) continue
      let signalWindow = null, pattern = null
      if (signalMode === 'cutoff') {
        signalWindow = window
        pattern = detectPattern(signalWindow, side)
      } else {
        for (let end = 9; end < window.length; end++) {
          const candidate = window.slice(0, end + 1), candidatePattern = detectPattern(candidate, side)
          if (candidatePattern?.eligible) { signalWindow = candidate; pattern = candidatePattern; break }
        }
      }
      if (!pattern?.eligible) continue
      const quality = qualityGate(all, signalWindow, side)
      if (qualityFilterEnabled && !quality.passed) continue
      const signalCandle = signalWindow.at(-1)
      const signalIndex = day.findIndex(x => x.stamp === signalCandle.stamp)
      const entryIndex = signalIndex + 1
      if (signalIndex < 0 || (!liveMode && entryIndex >= day.length)) continue
      let pv = 0, vol = 0
      for (const x of signalWindow) { pv += ((x.high + x.low + x.close) / 3) * x.volume; vol += x.volume }
      const vwap = pv / vol, trade = liveMode ? liveTrade(day, entryIndex, side) : simulateTrade(day, entryIndex, side)
      signals.push({
        signal_time: signalCandle.stamp, symbol, side,
        impulse_time: signalWindow[pattern.impulseIndex].stamp, impulse_pct: round(pattern.impulsePct),
        pullback_time: signalWindow[pattern.pullbackIndex].stamp, pullback_pct: round(pattern.pullbackPct),
        renewed_pct: round(pattern.renewedPct), close_location_pct: round(pattern.closeLocationPct),
        quality_pass: quality.passed ? 'yes' : 'no', relative_volume: round(quality.relativeVolume), volume_percentile: round(quality.volumePercentile, 1),
        directional_10m_body_pct: round(quality.directional10mBodyPct), directional_ema20_angle_deg: round(quality.directionalEma20AngleDeg),
        signal_close: signalCandle.close, signal_vwap: round(vwap), directional_vwap_gap_pct: round(100 * (side === 'BUY' ? 1 : -1) * (signalCandle.close / vwap - 1)),
        ...trade
      })
    }
  }
  if (progressEnabled) {
    const width = 28, filled = Math.round(width * (s + 1) / universe.length)
    process.stderr.write(`\r[${'='.repeat(filled)}${'-'.repeat(width - filled)}] ${s + 1}/${universe.length} ${symbol.padEnd(14).slice(0, 14)}`)
  }
}
if (progressEnabled) process.stderr.write('\n')

signals.sort((a, b) => a.signal_time.localeCompare(b.signal_time) || a.side.localeCompare(b.side) || a.symbol.localeCompare(b.symbol))
const returns = signals.map(x => x.return_pct).filter(Number.isFinite)
const perDay = sessions.map(date => {
  const trades = signals.filter(x => x.signal_time.startsWith(date)), values = trades.map(x => x.return_pct).filter(Number.isFinite)
  return { date, signals: trades.length, closed_trades: values.length, total_return_pct: values.length ? round(sum(values)) : null }
})
const tradedDays = perDay.filter(x => x.closed_trades > 0)
const worstDay = tradedDays.reduce((a, b) => a == null || b.total_return_pct < a.total_return_pct ? b : a, null)
const performance = {
  sessions: sessions.length, signal_count: signals.length, closed_trade_count: returns.length,
  win_rate_pct: returns.length ? round(100 * returns.filter(x => x > 0).length / returns.length) : null,
  average_return_pct: returns.length ? round(mean(returns)) : null,
  total_return_pct: returns.length ? round(sum(returns)) : null,
  maximum_adverse_excursion_pct: returns.length ? round(Math.min(...signals.map(x => x.maximum_adverse_excursion_pct).filter(Number.isFinite))) : null,
  worst_day: worstDay ? `${worstDay.date}: ${worstDay.total_return_pct}% (${worstDay.closed_trades} trades)` : null
}

const columns = Object.keys(signals[0] ?? { signal_time: '', symbol: '', side: '', entry_time: '', entry_price: '', exit_time: '', exit_price: '', exit_reason: '', return_pct: '', maximum_adverse_excursion_pct: '' })
const csv = [columns.join(','), ...signals.map(row => columns.map(c => row[c] ?? '').join(','))].join('\n') + '\n'
const scope = fromDate === toDate ? fromDate : `${fromDate}-to-${toDate}`
const stem = `${scope}-${startTime.replace(':', '')}-${cutoffTime.replace(':', '')}-${signalMode}${liveMode ? '-live' : ''}-five-phase-signals`
let report = path.join(root, 'reports', `${stem}.csv`), version = 2
while (fs.existsSync(report)) report = path.join(root, 'reports', `${stem}-${version++}.csv`)
fs.writeFileSync(report, csv, { flag: 'wx' })

const result = { parameters: { fromDate, toDate, startTime, cutoffTime, signalMode, liveMode, scanSide, stopLossPct, entry: 'next completed 1m candle close', exit: `${stopLossPct}% stop or adverse EMA20/EMA40 cross at next candle open`, minOpeningBodyPct, minOpeningExcursionPct, minImpulsePct, minPullbackPct, minRenewedPct, minCloseLocationPct, qualityFilterEnabled, minRelativeVolume, minVolumePercentile, min10mBodyPct, minEma20AngleDeg }, sessions, coverage, performance, perDay, signals, report }
if (outputFormat === 'json') console.log(JSON.stringify(result, null, 2))
else {
  console.log(`\n${fromDate} to ${toDate} | ${startTime}-${cutoffTime} | ${signalMode.toUpperCase()}${liveMode ? ' LIVE' : ''} | ${scanSide.toUpperCase()} | ${signals.length} signals`)
  if (signals.length) console.table(signals.map(x => ({ Signal: x.signal_time, Stock: x.symbol, Side: x.side, RVOL: x.relative_volume, 'Vol pctile': x.volume_percentile, '10m body %': x.directional_10m_body_pct, 'EMA20 angle': x.directional_ema20_angle_deg, Entry: x.entry_price, Exit: x.exit_price, 'Exit time': x.exit_time, 'Exit reason': x.exit_reason, 'Return %': x.return_pct, 'MAE %': x.maximum_adverse_excursion_pct })))
  else console.log('No signals matched all five phases.')
  console.table([performance])
  console.table(perDay)
  console.log(`Report: ${report}`)
}
