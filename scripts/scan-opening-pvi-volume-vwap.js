import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
function cli(argv) {
  const values = {}, positional = []
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue }
    const [rawKey, inline] = argv[i].slice(2).split('=', 2)
    values[rawKey] = inline ?? argv[++i]
  }
  return { values, positional }
}
const { values: args, positional } = cli(process.argv.slice(2))
if (args.help === undefined && process.argv.slice(2).includes('--help')) {
  console.log(`Usage:
  node scripts/scan-opening-pvi-volume-vwap.js --date 2026-11-05 --start 09:15 --end 09:25
  node scripts/scan-opening-pvi-volume-vwap.js --from-date 2026-11-05 --to-date 2026-11-11

Options:
  --date YYYY-MM-DD             Trade date (positional date is also supported)
  --from-date YYYY-MM-DD        First date for multi-session backtest
  --to-date YYYY-MM-DD          Last date for multi-session backtest
  --start HH:MM                 Signal-window start; default 09:15
  --end HH:MM                   Signal-window end; default 09:25
  --prior-sessions N            Volume lookback; default 20
  --min-volume-percentile N     Default 85
  --min-pvi-angle N             Default 0
  --min-pviema-angle N          Default 0.95
  --moderate-pvi-max N          Default 4.7
  --min-second5-return N        Default 0.63
  --max-first5-volume-share N   Default 48
  --stop-loss-pct N             Trade stop loss; default 0.8
  --side buy|sell|both          Direction to scan; default both
  --inspect SYMBOL              Print one stock's audit without writing a report
  --format table|json           Console output format; default table
  --progress true|false         Show live stock progress; default true
`)
  process.exit(0)
}
const tradeDate = args.date ?? positional[0] ?? '2026-11-11'
const fromDate = args['from-date'] ?? null
const toDate = args['to-date'] ?? null
const startTime = args.start ?? '09:15'
const endTime = args.end ?? '09:25'
const priorSessionCount = +(args['prior-sessions'] ?? 20)
const minVolumePercentile = +(args['min-volume-percentile'] ?? 85)
const minPviAngle = +(args['min-pvi-angle'] ?? 0)
const minPviEmaAngle = +(args['min-pviema-angle'] ?? 0.95)
const moderatePviMax = +(args['moderate-pvi-max'] ?? 4.7)
const minSecondFiveReturn = +(args['min-second5-return'] ?? 0.63)
const maxFirstFiveVolumeShare = +(args['max-first5-volume-share'] ?? 48)
const stopLossPct = +(args['stop-loss-pct'] ?? 0.8)
const scanSide = (args.side ?? 'both').toLowerCase()
const outputFormat = (args.format ?? 'table').toLowerCase()
const progressEnabled = args.progress === 'true' || (args.progress !== 'false' && outputFormat === 'table')
const inspectSymbol = (args.inspect ?? positional[1])?.replace(/-EQ$/i, '').toUpperCase() ?? null
if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || endTime < startTime) {
  throw new Error('Use --date YYYY-MM-DD and an ordered --start/--end in HH:MM format')
}
if ((fromDate == null) !== (toDate == null) || (fromDate && (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || toDate < fromDate))) {
  throw new Error('Range mode requires an ordered --from-date and --to-date in YYYY-MM-DD format')
}
if (!['table', 'json'].includes(outputFormat)) throw new Error('--format must be table or json')
if (!['buy', 'sell', 'both'].includes(scanSide)) throw new Error('--side must be buy, sell, or both')
const universe = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8'))
  .map(x => String(x).replace(/-EQ$/i, '').toUpperCase()))]
const symbols = inspectSymbol ? [inspectSymbol] : universe
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const sum = xs => xs.reduce((a, b) => a + b, 0)
const mean = xs => xs.length ? sum(xs) / xs.length : NaN
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')

function trendAngle(values) {
  if (values.length < 2 || values.some(x => !(x > 0))) return NaN
  const ys = values.map(Math.log), mx = (values.length - 1) / 2, my = mean(ys)
  const denominator = sum(ys.map((_, i) => (i - mx) ** 2))
  const slope = sum(ys.map((y, i) => (i - mx) * (y - my))) / denominator
  return Math.atan(100 * slope) * 180 / Math.PI
}

function loadCandles(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const stamp = local(+x.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
    if (date > tradeDate || minute < '09:15' || minute > '15:29') continue
    if (![x.open, x.high, x.low, x.close, x.volume].every(v => Number.isFinite(+v))) continue
    unique.set(stamp, { stamp, date, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
  }
  return [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
}

function analyze(symbol) {
  const all = loadCandles(symbol)
  const dates = [...new Set(all.map(x => x.date))]
  const priorDates = dates.filter(x => x < tradeDate).slice(-priorSessionCount)
  const today = all.filter(x => x.date === tradeDate)
  const opening = today.filter(x => x.minute >= startTime && x.minute <= endTime)
  if (priorDates.length < priorSessionCount || opening.length < 10) return null
  const priorLast = all.filter(x => x.date === priorDates.at(-1)).at(-1)
  if (!priorLast) return null

  const priorVolumes = priorDates.map(date => {
    const rows = all.filter(x => x.date === date && x.minute >= startTime && x.minute <= endTime)
    return rows.length === opening.length ? sum(rows.map(x => x.volume)) : NaN
  })
  if (priorVolumes.some(x => !Number.isFinite(x))) return null

  // PVI and its EMA are continuous across sessions; only the signal window is sliced afterward.
  let pvi = 1000, pviEma = 1000, ema20 = all[0].close, ema40 = all[0].close, previous = null
  const alpha = 2 / 256, alpha20 = 2 / 21, alpha40 = 2 / 41, indicator = new Map()
  for (const row of all) {
    if (previous && row.volume > previous.volume) pvi *= row.close / previous.close
    pviEma = alpha * pvi + (1 - alpha) * pviEma
    ema20 = alpha20 * row.close + (1 - alpha20) * ema20
    ema40 = alpha40 * row.close + (1 - alpha40) * ema40
    indicator.set(row.stamp, { pvi, pviEma, ema20, ema40 })
    previous = row
  }
  const pviValues = opening.map(x => indicator.get(x.stamp).pvi)
  const pviEmaValues = opening.map(x => indicator.get(x.stamp).pviEma)
  const currentVolume = sum(opening.map(x => x.volume))
  const firstFiveVolume = sum(opening.slice(0, 5).map(x => x.volume))
  const secondFive = opening.slice(5, 10)
  const sessionVwap = sum(opening.map(x => ((x.high + x.low + x.close) / 3) * x.volume)) / currentVolume
  const volumePercentile = 100 * priorVolumes.filter(x => x < currentVolume).length / priorVolumes.length
  const gapPct = 100 * (opening[0].open / priorLast.close - 1)
  const pviAngle = trendAngle(pviValues), pviEmaAngle = trendAngle(pviEmaValues)
  const secondFiveReturn = 100 * (secondFive.at(-1).close / secondFive[0].open - 1)
  const firstFiveVolumeShare = 100 * firstFiveVolume / currentVolume
  const closeVsVwap = 100 * (opening.at(-1).close / sessionVwap - 1)
  const commonPass = volumePercentile >= minVolumePercentile
  const buyBasePass = commonPass && gapPct > 0 && pviAngle > minPviAngle && pviEmaAngle >= minPviEmaAngle && opening.at(-1).close > sessionVwap
  const sellBasePass = commonPass && gapPct < 0 && pviAngle < -minPviAngle && pviEmaAngle <= -minPviEmaAngle && opening.at(-1).close < sessionVwap
  const buyRefinementPass = pviAngle <= moderatePviMax || (secondFiveReturn > minSecondFiveReturn && firstFiveVolumeShare <= maxFirstFiveVolumeShare)
  const sellRefinementPass = pviAngle >= -moderatePviMax || (secondFiveReturn < -minSecondFiveReturn && firstFiveVolumeShare <= maxFirstFiveVolumeShare)
  const buyEligible = scanSide !== 'sell' && buyBasePass && buyRefinementPass
  const sellEligible = scanSide !== 'buy' && sellBasePass && sellRefinementPass
  const side = buyEligible ? 'BUY' : sellEligible ? 'SELL' : ''
  const basePass = scanSide === 'buy' ? buyBasePass : scanSide === 'sell' ? sellBasePass : buyBasePass || sellBasePass
  const refinementPass = side === 'BUY' ? buyRefinementPass : side === 'SELL' ? sellRefinementPass : false
  const eligible = Boolean(side)
  let trade = { entry_time: '', entry_price: '', stop_price: '', exit_time: '', exit_price: '', exit_reason: '', return_pct: '', maximum_adverse_excursion_pct: '' }
  if (eligible) {
    const entryIndex = today.findIndex(x => x.minute > endTime)
    if (entryIndex >= 0) {
      const direction = side === 'BUY' ? 1 : -1
      const entry = today[entryIndex], entryPrice = entry.close, stopPrice = entryPrice * (1 - direction * stopLossPct / 100)
      let exit = null, mae = 0
      for (let i = entryIndex + 1; i < today.length; i++) {
        const candle = today[i]
        const adverse = side === 'BUY' ? 100 * (candle.low / entryPrice - 1) : 100 * (1 - candle.high / entryPrice)
        mae = Math.min(mae, adverse)
        const stopGap = side === 'BUY' ? candle.open <= stopPrice : candle.open >= stopPrice
        const stopTouched = side === 'BUY' ? candle.low <= stopPrice : candle.high >= stopPrice
        if (stopGap) { exit = { time: candle.stamp, price: candle.open, reason: 'stop-gap' }; break }
        if (stopTouched) { exit = { time: candle.stamp, price: stopPrice, reason: 'stop-loss' }; break }
        const previousIndicator = indicator.get(today[i - 1].stamp), currentIndicator = indicator.get(candle.stamp)
        const crossedDown = previousIndicator.ema20 >= previousIndicator.ema40 && currentIndicator.ema20 < currentIndicator.ema40
        const crossedUp = previousIndicator.ema20 <= previousIndicator.ema40 && currentIndicator.ema20 > currentIndicator.ema40
        if ((side === 'BUY' && crossedDown) || (side === 'SELL' && crossedUp)) {
          const next = today[i + 1]
          const reason = side === 'BUY' ? 'EMA20-cross-below-EMA40' : 'EMA20-cross-above-EMA40'
          exit = next ? { time: next.stamp, price: next.open, reason } : { time: candle.stamp, price: candle.close, reason: `${reason}-EOD` }
          break
        }
      }
      if (!exit) { const last = today.at(-1); exit = { time: last.stamp, price: last.close, reason: 'end-of-day' } }
      trade = {
        entry_time: entry.stamp, entry_price: round(entryPrice), stop_price: round(stopPrice), exit_time: exit.time,
        exit_price: round(exit.price), exit_reason: exit.reason, return_pct: round(100 * direction * (exit.price / entryPrice - 1)),
        maximum_adverse_excursion_pct: round(mae)
      }
    }
  }
  return {
    symbol, side, gap_pct: round(gapPct), opening_volume: currentVolume, volume_percentile: round(volumePercentile, 1),
    pvi_angle_deg: round(pviAngle), pviema255_angle_deg: round(pviEmaAngle), close_at_end: opening.at(-1).close,
    vwap_at_end: round(sessionVwap), close_vs_vwap_pct: round(closeVsVwap), second_completed_5m_return_pct: round(secondFiveReturn),
    first_5m_volume_share_pct: round(firstFiveVolumeShare), base_pass: basePass ? 'yes' : 'no',
    refinement_pass: refinementPass ? 'yes' : 'no', eligible: eligible ? 'yes' : 'no', ...trade
  }
}

function showProgress(current, total, label = '') {
  if (!progressEnabled) return
  const width = 30, filled = Math.round(width * current / total)
  const bar = `${'='.repeat(filled)}${'-'.repeat(width - filled)}`
  const percent = Math.round(100 * current / total).toString().padStart(3)
  process.stderr.write(`\r[${bar}] ${percent}% ${current}/${total} ${label.padEnd(14).slice(0, 14)}`)
  if (current === total) process.stderr.write('\n')
}

function runRange() {
  const benchmark = path.join(root, 'db', 'candles', 'NIFTY50.jsonl')
  if (!fs.existsSync(benchmark)) throw new Error(`Missing session calendar source: ${benchmark}`)
  const sessionDates = [...new Set(fs.readFileSync(benchmark, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return local(+JSON.parse(line).time).slice(0, 10) } catch { return null }
  }).filter(date => date && date >= fromDate && date <= toDate))].sort()
  if (!sessionDates.length) throw new Error(`No NSE sessions found from ${fromDate} to ${toDate}`)

  const childArgs = [
    '--start', startTime, '--end', endTime,
    '--prior-sessions', String(priorSessionCount),
    '--min-volume-percentile', String(minVolumePercentile),
    '--min-pvi-angle', String(minPviAngle),
    '--min-pviema-angle', String(minPviEmaAngle),
    '--moderate-pvi-max', String(moderatePviMax),
    '--min-second5-return', String(minSecondFiveReturn),
    '--max-first5-volume-share', String(maxFirstFiveVolumeShare),
    '--stop-loss-pct', String(stopLossPct), '--side', scanSide, '--format', 'json', '--progress', String(progressEnabled)
  ]
  const dailyResults = []
  for (const date of sessionDates) {
    if (outputFormat === 'table') console.log(`Scanning ${date}...`)
    const child = spawnSync(process.execPath, [process.argv[1], '--date', date, ...childArgs], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })
    if (child.status !== 0) throw new Error(`Scan failed for ${date}: ${child.error?.message || child.stdout}`)
    try { dailyResults.push(JSON.parse(child.stdout)) } catch { throw new Error(`Invalid scan output for ${date}: ${child.stdout}`) }
  }
  const trades = dailyResults.flatMap(day => day.eligible.map(row => ({ trade_date: day.parameters.tradeDate, ...row })))
  const returns = trades.map(x => x.return_pct).filter(Number.isFinite)
  const dailyTotals = dailyResults.map(day => ({ date: day.parameters.tradeDate, return_pct: day.performance.total_return_pct, trades: day.performance.trade_count }))
  const worstDay = dailyTotals.filter(day => day.trades > 0).reduce((worst, day) => worst == null || day.return_pct < worst.return_pct ? day : worst, null)
  const performance = {
    sessions: sessionDates.length,
    trade_count: returns.length,
    win_rate_pct: returns.length ? round(100 * returns.filter(x => x > 0).length / returns.length) : null,
    average_return_pct: returns.length ? round(mean(returns)) : null,
    total_return_pct: round(sum(returns)),
    maximum_adverse_excursion_pct: returns.length ? round(Math.min(...trades.map(x => x.maximum_adverse_excursion_pct))) : null,
    worst_day: worstDay ? `${worstDay.date}: ${round(worstDay.return_pct)}% (${worstDay.trades} trades)` : null
  }
  const columns = Object.keys(trades[0] ?? { trade_date: '', symbol: '', entry_time: '', entry_price: '', exit_time: '', exit_price: '', exit_reason: '', return_pct: '', maximum_adverse_excursion_pct: '' })
  const csv = [columns.join(','), ...trades.map(row => columns.map(c => row[c] ?? '').join(','))].join('\n') + '\n'
  const stem = `${fromDate}-to-${toDate}-${startTime.replace(':', '')}-${endTime.replace(':', '')}-pvi-volume-vwap-backtest`
  let report = path.join(root, 'reports', `${stem}.csv`), version = 2
  while (fs.existsSync(report)) report = path.join(root, 'reports', `${stem}-${version++}.csv`)
  fs.writeFileSync(report, csv, { flag: 'wx' })
  const result = { parameters: { fromDate, toDate, startTime, endTime, priorSessionCount, minVolumePercentile, minPviAngle, minPviEmaAngle, moderatePviMax, minSecondFiveReturn, maxFirstFiveVolumeShare, stopLossPct, scanSide }, sessionDates, performance, daily: dailyTotals, trades, report }
  if (outputFormat === 'json') console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`\n${fromDate} to ${toDate} | ${sessionDates.length} NSE sessions`)
    if (trades.length) console.table(trades.map(row => ({ Date: row.trade_date, Stock: row.symbol, Side: row.side, Entry: row.entry_price, Exit: row.exit_price, 'Exit reason': row.exit_reason, 'Return %': row.return_pct, 'MAE %': row.maximum_adverse_excursion_pct })))
    else console.log('No stocks passed all conditions in this range.')
    console.table([performance])
    console.table(dailyTotals)
    console.log(`Report: ${report}`)
  }
}

if (fromDate && toDate) {
  runRange()
  process.exit(0)
}
const analyzed = []
for (let i = 0; i < symbols.length; i++) {
  const row = analyze(symbols[i])
  if (row) analyzed.push(row)
  showProgress(i + 1, symbols.length, symbols[i])
}
const eligible = analyzed.filter(x => x.eligible === 'yes').sort((a, b) => a.side.localeCompare(b.side) || Math.abs(b.pviema255_angle_deg) - Math.abs(a.pviema255_angle_deg))
if (inspectSymbol) {
  const inspected = analyzed.find(x => x.symbol === inspectSymbol) ?? { symbol: inspectSymbol, error: 'not analyzed' }
  if (outputFormat === 'json') console.log(JSON.stringify(inspected, null, 2))
  else console.table([inspected])
  process.exit(0)
}
const columns = Object.keys(eligible[0] ?? analyzed[0] ?? { symbol: '' })
const csv = [columns.join(','), ...eligible.map(row => columns.map(c => row[c]).join(','))].join('\n') + '\n'
const stem = `${tradeDate}-${startTime.replace(':', '')}-${endTime.replace(':', '')}-six-condition-pvi-volume-vwap-screen`
let output = path.join(root, 'reports', `${stem}.csv`), version = 2
while (fs.existsSync(output)) output = path.join(root, 'reports', `${stem}-${version++}.csv`)
fs.writeFileSync(output, csv, { flag: 'wx' })
const returns = eligible.map(x => x.return_pct).filter(Number.isFinite)
const performance = {
  trade_count: returns.length,
  win_rate_pct: returns.length ? round(100 * returns.filter(x => x > 0).length / returns.length) : null,
  average_return_pct: returns.length ? round(mean(returns)) : null,
  total_return_pct: round(sum(returns)),
  maximum_adverse_excursion_pct: returns.length ? round(Math.min(...eligible.map(x => x.maximum_adverse_excursion_pct))) : null,
  worst_day: returns.length ? `${tradeDate}: ${round(sum(returns))}%` : null
}
const result = { parameters: { tradeDate, startTime, endTime, priorSessionCount, minVolumePercentile, minPviAngle, minPviEmaAngle, moderatePviMax, minSecondFiveReturn, maxFirstFiveVolumeShare, stopLossPct, scanSide, entry: 'next completed 1m candle close', exit: `${stopLossPct}% stop or adverse EMA20/EMA40 cross; EMA cross executes next candle open` }, universe: universe.length, analyzed: analyzed.length, basePass: analyzed.filter(x => x.base_pass === 'yes').length, eligibleCount: eligible.length, performance, eligible, output }
if (outputFormat === 'json') {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`\n${tradeDate} ${startTime}-${endTime} | Eligible: ${eligible.length} | Base pass: ${result.basePass} | Analyzed: ${analyzed.length}/${universe.length}`)
  if (eligible.length) console.table(eligible.map(row => ({
    Stock: row.symbol,
    Side: row.side,
    'Gap %': row.gap_pct,
    'Volume pctile': row.volume_percentile,
    'PVI angle': row.pvi_angle_deg,
    'PVI-EMA255 angle': row.pviema255_angle_deg,
    'Close-VWAP %': row.close_vs_vwap_pct,
    'Second 5m %': row.second_completed_5m_return_pct,
    'First 5m vol %': row.first_5m_volume_share_pct,
    Entry: row.entry_price,
    Exit: row.exit_price,
    'Exit reason': row.exit_reason,
    'Return %': row.return_pct
  })))
  else console.log('No stocks passed all conditions.')
  console.table([performance])
  console.log(`Report: ${output}`)
}
