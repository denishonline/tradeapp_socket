import fs from 'node:fs'
import path from 'node:path'
import { analyzeDepthSession } from './report-oct16-0930-six-stock-depth-behavior.js'

const root = process.cwd()
const dates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
const symbols = ['TECHM', 'WIPRO', 'KPITTECH', 'TCS', 'DALBHARAT', 'INFY']
const round = (n, d = 2) => Number.isFinite(n) ? Number(n.toFixed(d)) : null
const mean = values => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null

function extract(result) {
  if (!result.available) return { available: false, observedMinutes: result.observedMinutes ?? 0 }
  const minutes = result.minutes.filter(row => row.minute >= '09:16' && row.minute <= '09:29')
  const early = minutes.filter(row => row.minute < '09:23')
  const late = minutes.filter(row => row.minute >= '09:23')
  const earlyBidSharePct = round(mean(early.map(row => row.bidSharePct)))
  const lateBidSharePct = round(mean(late.map(row => row.bidSharePct)))
  return { available: true, observedMinutes: minutes.length, firstBookAt: minutes[0]?.lastBookAt,
    lastBookAt: minutes.at(-1)?.lastBookAt, meanBidSharePct: round(mean(minutes.map(row => row.bidSharePct))),
    bidDominantMinutePct: round(100 * minutes.filter(row => row.bidSharePct > 50).length / minutes.length),
    earlyBidSharePct, lateBidSharePct,
    lateMinusEarlyBidSharePoints: round(lateBidSharePct - earlyBidSharePct),
    meanSpreadBps: round(mean(minutes.map(row => row.spreadBps))),
    quoteMidMovePct: round(100 * (minutes.at(-1).mid / minutes[0].mid - 1), 3),
    meanDisplayedBidSize: round(mean(minutes.map(row => row.bidSize))),
    meanDisplayedAskSize: round(mean(minutes.map(row => row.askSize))),
    lastBidSize: minutes.at(-1).bidSize, lastAskSize: minutes.at(-1).askSize,
    depthEvents: result.depthEvents }
}

const results = symbols.map(symbol => {
  const sessions = Object.fromEntries(dates.map(date => [date, extract(analyzeDepthSession(symbol, date))]))
  const prior = dates.slice(0, 4).map(date => sessions[date])
  const current = sessions['2026-10-16']
  const metrics = ['meanBidSharePct', 'bidDominantMinutePct', 'lateMinusEarlyBidSharePoints',
    'meanSpreadBps', 'quoteMidMovePct', 'meanDisplayedBidSize', 'meanDisplayedAskSize']
  const previous4Average = Object.fromEntries(metrics.map(metric => [metric, round(mean(prior.map(row => row[metric]).filter(Number.isFinite)))]))
  const october16MinusAverage = Object.fromEntries(metrics.map(metric => [metric, round(current[metric] - previous4Average[metric])]))
  return { symbol, sessions, previous4Average, october16MinusAverage,
    allSessionsHave14AlignedMinutes: dates.every(date => sessions[date].observedMinutes === 14) }
})

const output = { windowIST: '09:16:00–09:29:59', previousDates: dates.slice(0, 4), targetDate: dates[4],
  method: 'Align all sessions to 09:16–09:29 IST, the fourteen minutes observed on October 16. For each minute take the last valid five-level cash-depth book. Compute each day’s equal-minute mean bid share, bid-dominant minute percentage, late-minus-early bid-share change (09:23 split), spread, displayed sizes, and 09:16-minute-end to 09:29-minute-end quote midpoint move. Previous-four-session values are arithmetic means of daily metrics. Deltas are October 16 minus that mean; bid-share and quote changes are percentage points, spread changes are basis points.',
  caveat: 'Displayed depth is quoted size, not executed volume or a measure of actual buyer/seller trades. All five dates have fourteen aligned minute-end snapshots for each stock; the 09:15 minute is excluded because October 16 depth begins at 09:16.',
  source: 'db/cash-depth/<YYYY-MM-DD>/<SYMBOL>/<SYMBOL>.jsonl', results }
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-16-0930-six-stock-depth-vs-previous-four-sessions${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, results: results.map(({ sessions, ...rest }) => ({ ...rest, october16: sessions['2026-10-16'] })) }, null, 2))
