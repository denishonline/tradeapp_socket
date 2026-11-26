import fs from 'node:fs'
import path from 'node:path'
import apiV3 from 'fyers-api-v3'
import { createCandleStore, normalizeCandle } from '../ui/candles.js'
import { toFyersSymbol } from '../ui/market-data.js'

const root = process.cwd()

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const [key, inline] = argv[i].slice(2).split('=', 2)
    out[key] = inline ?? argv[++i]
  }
  return out
}

function istToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const args = parseArgs(process.argv.slice(2))
if (process.argv.includes('--help')) {
  console.log(`Usage:
  node scripts/scan-opening-rank-filters.js --date 2026-11-11 --start 09:15 --cutoff 09:20
  node scripts/scan-opening-rank-filters.js --cutoff-datetime 2026-11-11T09:20

Options:
  --date YYYY-MM-DD              Default: current IST date
  --start HH:MM                  Default: 09:15
  --cutoff HH:MM                 Default: 09:20
  --cutoff-datetime DATE[T]HH:MM Sets both date and cutoff
  --lookback-sessions N          Default: 20, including selected date
  --max-volume-rank N            Default: 5
  --max-turnover-rank N          Default: 5
  --max-return-rank N            Default: 10
  --max-pvi-change-rank N        Default: 5
  --max-pvi-angle-rank N         Default: 5
  --refresh-history true|false   Refresh and merge today's FYERS 1m data first (default: true)
  --refresh-delay-ms N           Delay between FYERS requests (default: 400)
  --refresh-retries N            Retry count per failed symbol (default: 2)
  --format table|json            Default: table
  --progress true|false          Default: true for table output
`)
  process.exit(0)
}

const cutoffDateTime = args['cutoff-datetime']?.replace(' ', 'T')
const tradeDate = cutoffDateTime?.slice(0, 10) ?? args.date ?? istToday()
const startTime = args.start ?? '09:15'
const cutoffTime = cutoffDateTime?.slice(11, 16) ?? args.cutoff ?? '09:20'
const lookbackSessions = +(args['lookback-sessions'] ?? 20)
const maxVolumeRank = +(args['max-volume-rank'] ?? 5)
const maxTurnoverRank = +(args['max-turnover-rank'] ?? 5)
const maxReturnRank = +(args['max-return-rank'] ?? 10)
const maxPviChangeRank = +(args['max-pvi-change-rank'] ?? 5)
const maxPviAngleRank = +(args['max-pvi-angle-rank'] ?? 5)
const refreshHistoryEnabled = args['refresh-history'] !== 'false'
const refreshDelayMs = +(args['refresh-delay-ms'] ?? 400)
const refreshRetries = +(args['refresh-retries'] ?? 2)
const outputFormat = (args.format ?? 'table').toLowerCase()
const progressEnabled = args.progress === 'true' || (args.progress !== 'false' && outputFormat === 'table')

if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error('Use --date YYYY-MM-DD or --cutoff-datetime YYYY-MM-DDTHH:MM')
if (![startTime, cutoffTime].every(x => /^\d{2}:\d{2}$/.test(x)) || cutoffTime < startTime) throw new Error('Use ordered --start and --cutoff times in HH:MM')
if (!['table', 'json'].includes(outputFormat)) throw new Error('--format must be table or json')
if (![lookbackSessions, maxVolumeRank, maxTurnoverRank, maxReturnRank, maxPviChangeRank, maxPviAngleRank].every(x => Number.isInteger(x) && x > 0)) throw new Error('Session count and rank limits must be positive integers')
if (!Number.isInteger(refreshDelayMs) || refreshDelayMs < 0 || !Number.isInteger(refreshRetries) || refreshRetries < 0) throw new Error('Refresh delay and retries must be non-negative integers')

const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const sum = xs => xs.reduce((a, b) => a + b, 0)
const mean = xs => xs.length ? sum(xs) / xs.length : NaN
const addMinutes = (hhmm, minutes) => {
  const [hour, minute] = hhmm.split(':').map(Number)
  const total = hour * 60 + minute + minutes
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
const rankDescending = (rows, key, targetDate) => {
  const target = rows.find(x => x.date === targetDate)?.[key]
  return Number.isFinite(target) ? 1 + rows.filter(x => x[key] > target).length : null
}
const trendAngle = values => {
  if (values.length < 2 || values.some(x => !(x > 0))) return NaN
  const ys = values.map(Math.log), mx = (values.length - 1) / 2, my = mean(ys)
  const denominator = sum(ys.map((_, i) => (i - mx) ** 2))
  const slope = sum(ys.map((y, i) => (i - mx) * (y - my))) / denominator
  return Math.atan(100 * slope) * 180 / Math.PI
}

const universe = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).replace(/-EQ$/i, '').toUpperCase()))]
const expectedCandles = Math.round((Date.parse(`2000-01-01T${cutoffTime}:00Z`) - Date.parse(`2000-01-01T${startTime}:00Z`)) / 60000) + 1
// Preserve established local filenames/history while following current NSE/FYERS
// symbols after corporate renames.
const fyersSymbolAliases = new Map([
  ['ICICIPRULI', 'ICICILIFE']
])
const fyersHistorySymbol = symbol => toFyersSymbol(fyersSymbolAliases.get(symbol) ?? symbol)

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const epochForIst = (date, hhmm) => {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = hhmm.split(':').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day, hour - 5, minute - 30) / 1000)
}

async function refreshTodayHistory() {
  if (!refreshHistoryEnabled) {
    if (progressEnabled) console.error('FYERS history refresh disabled; using stored candles.')
    return null
  }
  const today = istToday()
  if (tradeDate !== today) {
    if (progressEnabled) console.error(`Selected date ${tradeDate} is not today (${today}); using stored historical candles.`)
    return null
  }

  const sessionFrom = epochForIst(tradeDate, '09:15')
  const sessionClose = epochForIst(tradeDate, '15:30')
  const currentCompletedMinuteEnd = Math.floor(Date.now() / 60_000) * 60 - 1
  const rangeTo = Math.min(sessionClose - 1, currentCompletedMinuteEnd)
  const cutoffCompletedAt = epochForIst(tradeDate, cutoffTime) + 59
  if (rangeTo < cutoffCompletedAt) {
    throw new Error(`${tradeDate} ${cutoffTime} IST candle is not completed yet. FYERS refresh and business logic were not started.`)
  }

  const token = JSON.parse(fs.readFileSync(path.join(root, 'db', 'token'), 'utf8'))
  if (typeof token !== 'string' || !token.trim()) throw new Error('FYERS access token is missing. Run AutoLogin, then retry.')
  const { CONSTANT } = await import('../constant.js')
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token.trim())
  const store = await createCandleStore({ directory: path.join(root, 'db', 'candles'), symbols: universe })
  const failures = []
  let fetched = 0, added = 0, replaced = 0, duplicates = 0

  console.error(`Refreshing ${universe.length} stocks from FYERS for ${tradeDate} before rank calculations...`)
  for (let index = 0; index < universe.length; index++) {
    const symbol = universe[index]
    let completed = false, lastError
    for (let attempt = 0; attempt <= refreshRetries && !completed; attempt++) {
      try {
        const response = await client.getHistory({
          symbol: fyersHistorySymbol(symbol), resolution: '1', date_format: '0',
          range_from: String(sessionFrom), range_to: String(rangeTo), cont_flag: '1'
        })
        if (response?.s !== 'ok' || !Array.isArray(response.candles)) throw new Error(response?.message || response?.msg || 'FYERS returned no candle data')
        const incoming = response.candles.flatMap(row => {
          if (!Array.isArray(row) || row.length < 6) return []
          const candle = normalizeCandle({
            time: +row[0], open: +row[1], high: +row[2], low: +row[3], close: +row[4], volume: +row[5],
            source: 'fyers-history-refresh'
          })
          return candle && local(candle.time).slice(0, 10) === tradeDate && candle.time >= sessionFrom && candle.time <= rangeTo ? [candle] : []
        })
        const result = await store.mergeHistory(symbol, incoming, { replaceExisting: true })
        fetched += incoming.length
        added += result.added
        replaced += result.replaced
        duplicates += result.duplicate
        completed = true
      } catch (error) {
        lastError = error
        if (attempt < refreshRetries) await pause(Math.max(1000, refreshDelayMs * (attempt + 1)))
      }
    }
    if (!completed) failures.push({ symbol, message: lastError?.message ?? 'Unknown FYERS error' })
    const width = 28, fill = Math.round(width * (index + 1) / universe.length)
    process.stderr.write(`\rFYERS [${'='.repeat(fill)}${'-'.repeat(width - fill)}] ${index + 1}/${universe.length} ${symbol.padEnd(14).slice(0, 14)} added ${added} replaced ${replaced} failures ${failures.length}`)
    if (index < universe.length - 1 && refreshDelayMs) await pause(refreshDelayMs)
  }
  process.stderr.write('\n')
  if (failures.length) {
    const preview = failures.slice(0, 8).map(x => `${x.symbol}: ${x.message}`).join('; ')
    console.error(`Warning: FYERS refresh failed for ${failures.length}/${universe.length} stocks; continuing with their existing stored candles. ${preview}`)
  }
  console.error(`FYERS refresh complete: fetched ${fetched}, added ${added}, replaced ${replaced}, unchanged ${duplicates}, failed ${failures.length}. Starting business logic.`)
  return { fetched, added, replaced, duplicates, failed: failures.length, failureDetails: failures }
}

const historyRefresh = await refreshTodayHistory()

function analyze(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return { error: 'missing-file' }
  const unique = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const stamp = local(+x.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
    if (date > tradeDate || minute < '09:15' || minute > '15:29') continue
    if (![x.open, x.high, x.low, x.close, x.volume].every(v => Number.isFinite(+v))) continue
    unique.set(stamp, { stamp, date, minute, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume })
  }
  const all = [...unique.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))
  const dates = [...new Set(all.map(x => x.date))].filter(x => x <= tradeDate).sort().slice(-lookbackSessions)
  if (dates.length !== lookbackSessions || !dates.includes(tradeDate)) return { error: 'insufficient-sessions' }

  let pvi = 1000, nvi = 1000, previous = null
  for (const row of all) {
    if (previous && row.volume > previous.volume) pvi *= row.close / previous.close
    if (previous && row.volume < previous.volume) nvi *= row.close / previous.close
    row.pvi = pvi
    row.nvi = nvi
    previous = row
  }

  const sessions = []
  for (const date of dates) {
    const rows = all.filter(x => x.date === date && x.minute >= startTime && x.minute <= cutoffTime)
    if (rows.length !== expectedCandles) return { error: 'incomplete-window' }
    const volume = sum(rows.map(x => x.volume))
    const turnover = sum(rows.map(x => ((x.high + x.low + x.close) / 3) * x.volume))
    const returnPct = 100 * (rows.at(-1).close / rows[0].open - 1)
    const pviChangePct = 100 * (rows.at(-1).pvi / rows[0].pvi - 1)
    const pviAngleDeg = trendAngle(rows.map(x => x.pvi))
    sessions.push({ date, volume, turnover, returnPct, pviChangePct, pviAngleDeg })
  }

  const target = sessions.find(x => x.date === tradeDate)
  const fourthCandleTime = addMinutes(startTime, 3)
  const firstFourRows = cutoffTime >= fourthCandleTime
    ? all.filter(x => x.date === tradeDate && x.minute >= startTime && x.minute <= fourthCandleTime)
    : []
  const priorThreeDates = dates.slice(-4, -1)
  const priorThreeRows = all.filter(x => priorThreeDates.includes(x.date))
  const risingCloseTransitions = firstFourRows.length === 4
    ? firstFourRows.slice(1).filter((x, index) => x.close > firstFourRows[index].close).length
    : NaN
  const priorThreeHigh = priorThreeRows.length ? Math.max(...priorThreeRows.map(x => x.high)) : NaN
  const closeVsPriorThreeHighPct = firstFourRows.length === 4 && Number.isFinite(priorThreeHigh)
    ? 100 * (firstFourRows.at(-1).close / priorThreeHigh - 1)
    : NaN
  const firstFourVolume = firstFourRows.length === 4 ? sum(firstFourRows.map(x => x.volume)) : NaN
  const firstFourTurnover = firstFourRows.length === 4
    ? sum(firstFourRows.map(x => ((x.high + x.low + x.close) / 3) * x.volume))
    : NaN
  const firstFourPviChangePct = firstFourRows.length === 4
    ? 100 * (firstFourRows.at(-1).pvi / firstFourRows[0].pvi - 1)
    : NaN
  const firstFourNviAngleDeg = firstFourRows.length === 4
    ? trendAngle(firstFourRows.map(x => x.nvi))
    : NaN
  const qualityRows = all.filter(x => x.date === tradeDate && x.minute >= startTime && x.minute <= cutoffTime)
  const previousDate = dates.at(-2)
  const previousSession = all.filter(x => x.date === previousDate)
  let quality = {
    closeLocationPct: NaN,
    nviChangePct: NaN,
    closeVsVwapPct: NaN,
    previousSessionReturnPct: NaN
  }
  if (qualityRows.length === expectedCandles && previousSession.length) {
    const openingHigh = Math.max(...qualityRows.map(x => x.high))
    const openingLow = Math.min(...qualityRows.map(x => x.low))
    const openingClose = qualityRows.at(-1).close
    const openingRange = openingHigh - openingLow
    const sessionVolume = sum(qualityRows.map(x => x.volume))
    const sessionVwap = sessionVolume > 0
      ? sum(qualityRows.map(x => ((x.high + x.low + x.close) / 3) * x.volume)) / sessionVolume
      : NaN
    quality = {
      closeLocationPct: openingRange > 0 ? 100 * (openingClose - openingLow) / openingRange : 50,
      nviChangePct: 100 * (qualityRows.at(-1).nvi / qualityRows[0].nvi - 1),
      closeVsVwapPct: 100 * (openingClose / sessionVwap - 1),
      previousSessionReturnPct: 100 * (previousSession.at(-1).close / previousSession[0].open - 1)
    }
  }
  const ranks = {
    volumeRank: rankDescending(sessions, 'volume', tradeDate),
    turnoverRank: rankDescending(sessions, 'turnover', tradeDate),
    returnRank: rankDescending(sessions, 'returnPct', tradeDate),
    pviChangeRank: rankDescending(sessions, 'pviChangePct', tradeDate),
    pviAngleRank: rankDescending(sessions, 'pviAngleDeg', tradeDate)
  }
  const eligible = ranks.volumeRank <= maxVolumeRank && ranks.turnoverRank <= maxTurnoverRank && ranks.returnRank <= maxReturnRank && ranks.pviChangeRank <= maxPviChangeRank && ranks.pviAngleRank <= maxPviAngleRank
  const averageRank = mean(Object.values(ranks))
  return {
    row: {
      symbol, eligible: eligible ? 'yes' : 'no',
      average_rank: round(averageRank, 2),
      volume_rank: ranks.volumeRank, volume: target.volume,
      turnover_rank: ranks.turnoverRank, turnover_crore: round(target.turnover / 1e7),
      return_rank: ranks.returnRank, gap_excluded_return_pct: round(target.returnPct),
      pvi_change_rank: ranks.pviChangeRank, pvi_change_pct: round(target.pviChangePct),
      pvi_angle_rank: ranks.pviAngleRank, pvi_angle_deg: round(target.pviAngleDeg),
      close_location_pct: round(quality.closeLocationPct),
      nvi_change_pct: round(quality.nviChangePct),
      close_vs_vwap_pct: round(quality.closeVsVwapPct),
      previous_session_return_pct: round(quality.previousSessionReturnPct),
      rising_close_transitions: risingCloseTransitions,
      close_vs_prior3_high_pct: round(closeVsPriorThreeHighPct),
      first_four_volume: firstFourVolume,
      first_four_turnover_crore: round(firstFourTurnover / 1e7),
      first_four_pvi_change_pct: round(firstFourPviChangePct),
      first_four_nvi_angle_deg: round(firstFourNviAngleDeg)
    }
  }
}

const analyzed = [], errors = {}
for (let i = 0; i < universe.length; i++) {
  const result = analyze(universe[i])
  if (result.row) analyzed.push(result.row)
  else errors[result.error] = (errors[result.error] ?? 0) + 1
  if (progressEnabled) {
    const width = 28, filled = Math.round(width * (i + 1) / universe.length)
    process.stderr.write(`\r[${'='.repeat(filled)}${'-'.repeat(width - filled)}] ${i + 1}/${universe.length} ${universe[i].padEnd(14).slice(0, 14)}`)
  }
}
if (progressEnabled) process.stderr.write('\n')

const eligible = analyzed.filter(x => x.eligible === 'yes').sort((a, b) => a.volume_rank - b.volume_rank || a.turnover_rank - b.turnover_rank || a.symbol.localeCompare(b.symbol))
const lowestAverageRanks = [...analyzed].sort((a, b) => a.average_rank - b.average_rank || a.symbol.localeCompare(b.symbol)).slice(0, 20)
const threeOfThreeEligible = lowestAverageRanks.filter(x =>
  x.rising_close_transitions === 3 &&
  x.close_vs_prior3_high_pct >= -1.71 &&
  x.first_four_volume >= 45_000 &&
  x.first_four_pvi_change_pct <= 0.73 &&
  x.first_four_nvi_angle_deg >= 3
)
const columns = Object.keys(eligible[0] ?? analyzed[0] ?? { symbol: '' })
const csv = [columns.join(','), ...eligible.map(row => columns.map(c => row[c] ?? '').join(','))].join('\n') + '\n'
const stem = `${tradeDate}-${startTime.replace(':', '')}-${cutoffTime.replace(':', '')}-opening-rank-filter`
let report = path.join(root, 'reports', `${stem}.csv`), version = 2
while (fs.existsSync(report)) report = path.join(root, 'reports', `${stem}-${version++}.csv`)
fs.writeFileSync(report, csv, { flag: 'wx' })
const allColumns = Object.keys(analyzed[0] ?? { symbol: '' })
const allCsv = [allColumns.join(','), ...analyzed.map(row => allColumns.map(c => row[c] ?? '').join(','))].join('\n') + '\n'
let rankingReport = path.join(root, 'reports', `${stem}-all-ranks.csv`), rankingVersion = 2
while (fs.existsSync(rankingReport)) rankingReport = path.join(root, 'reports', `${stem}-all-ranks-${rankingVersion++}.csv`)
fs.writeFileSync(rankingReport, allCsv, { flag: 'wx' })

const result = {
  parameters: {
    tradeDate, startTime, cutoffTime, lookbackSessions, ranksAreDescending: true,
    historyRefresh: historyRefresh ? { enabled: true, source: 'FYERS History API', merge: 'replace matching timestamps and add missing timestamps', ...historyRefresh } : { enabled: false },
    maxVolumeRank, maxTurnoverRank, maxReturnRank, maxPviChangeRank, maxPviAngleRank,
    threeOfThreeFilter: {
      firstCandleTime: startTime,
      fourthCandleTime: addMinutes(startTime, 3),
      risingCloseTransitions: 3,
      closeVsPriorThreeSessionHighPctMin: -1.71,
      firstFourVolumeMin: 45_000,
      firstFourPviChangePctMax: 0.73,
      firstFourNviAngleDegMin: 3
    }
  },
  universe: universe.length, analyzed: analyzed.length, errors, eligibleCount: eligible.length, eligible,
  lowestAverageRanks, threeOfThreeEligible, report, rankingReport
}
if (outputFormat === 'json') console.log(JSON.stringify(result, null, 2))
else {
  console.log(`\n${tradeDate} ${startTime}-${cutoffTime} | Analyzed: ${analyzed.length}/${universe.length}`)
  const rankTable = rows => rows.map(x => ({ Stock: x.symbol, 'Average rank': x.average_rank, 'Vol rank': x.volume_rank, 'Turnover rank': x.turnover_rank, 'Return rank': x.return_rank, 'PVI change rank': x.pvi_change_rank, 'PVI angle rank': x.pvi_angle_rank }))
  const threeOfThreeTable = rows => rows.map(x => ({
    Stock: `NSE:${x.symbol}-EQ`,
    'Average rank': x.average_rank,
    'Rising close transitions': `${x.rising_close_transitions}/3`,
    'Fourth close vs prior 3-session high %': x.close_vs_prior3_high_pct,
    'First-four volume': x.first_four_volume,
    'First-four PVI change %': x.first_four_pvi_change_pct,
    'First-four NVI angle': x.first_four_nvi_angle_deg
  }))
  const nseList = rows => rows.map(x => `NSE:${x.symbol}-EQ`).join(', ')
  console.log('\nTop 20 lowest average ranks (strongest overall):')
  console.table(rankTable(lowestAverageRanks))
  console.log(`Stocks: ${nseList(lowestAverageRanks)}`)
  console.log('\nStocks produced 3/3 rising closes and remained within 1.71% of the prior 3-session high:')
  if (threeOfThreeEligible.length) console.table(threeOfThreeTable(threeOfThreeEligible))
  else console.log('No stocks from the strongest 20 passed the 3/3 filter.')
  console.log(`Stocks: ${nseList(threeOfThreeEligible)}`)
  console.log(`Report: ${report}`)
  console.log(`All ranks: ${rankingReport}`)
}
