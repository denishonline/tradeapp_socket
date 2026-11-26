import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const source = JSON.parse(fs.readFileSync(path.join(root, 'reports', '2026-11-17-to-20-opening-prior-session-features.json'), 'utf8')).rows
const preferred = new Set([
  '2026-11-19|VOLTAS', '2026-11-19|AMBER', '2026-11-19|IREDA', '2026-11-19|EICHERMOT', '2026-11-19|M&M', '2026-11-19|MARUTI', '2026-11-19|TVSMOTOR',
  '2026-11-20|INDUSINDBK', '2026-11-20|APOLLOHOSP', '2026-11-20|UNIONBANK', '2026-11-20|AXISBANK', '2026-11-20|PERSISTENT', '2026-11-20|BAJFINANCE', '2026-11-20|INDHOTEL'
])
const round = (x, p = 3) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const automaticAPlus = row => row.score === 10 && row.openingReturnPct >= 0.5 && row.beatReturnCount5 === 5 && row.beatReturnCount10 >= 9
  && row.efficiency >= 1.3 && row.rangeRatio10 >= 1.2 && row.volumeRatio10 >= 0.7 && row.volumeRatio10 <= 3
  && row.returnRank <= 55 && row.depthMovePct >= 0.5 && row.depthBidSharePct <= 53 && row.returnVsMax10Pct <= 1

const evaluated = source.filter(row => row.date >= '2026-11-19').map(row => ({ ...row, preferred: preferred.has(`${row.date}|${row.symbol}`), automaticAPlus: automaticAPlus(row) }))
const preferredRows = evaluated.filter(row => row.preferred)
const automaticRows = evaluated.filter(row => row.automaticAPlus)
const historicalAdditionalWinners = automaticRows.filter(row => !row.preferred && row.eodReturnPct > 2)
const selected = [...new Map([...preferredRows, ...historicalAdditionalWinners].map(row => [`${row.date}|${row.symbol}`, row])).values()]
  .sort((a, b) => `${a.date} ${a.signalTime} ${a.symbol}`.localeCompare(`${b.date} ${b.signalTime} ${b.symbol}`))

function summary(rows) {
  const daily = Map.groupBy(rows, row => row.date)
  const perDay = [...daily].map(([date, items]) => ({ date, totalReturnPct: round(items.reduce((sum, row) => sum + row.eodReturnPct, 0)) }))
  return {
    tradeCount: rows.length,
    winRatePct: round(100 * rows.filter(row => row.eodReturnPct > 0).length / rows.length),
    over2PctRate: round(100 * rows.filter(row => row.eodReturnPct > 2).length / rows.length),
    averageReturnPct: round(rows.reduce((sum, row) => sum + row.eodReturnPct, 0) / rows.length),
    totalReturnPct: round(rows.reduce((sum, row) => sum + row.eodReturnPct, 0)),
    maximumAdverseExcursionPct: round(Math.min(...rows.map(row => row.maePct))),
    worstDay: perDay.sort((a, b) => a.totalReturnPct - b.totalReturnPct)[0]
  }
}

const compact = row => ({
  date: row.date, symbol: row.symbol, selection: row.preferred ? 'USER_COHORT' : 'HISTORICAL_A_PLUS_GT_2', signalTime: row.signalTime, entryTime: row.entryTime,
  baseScore: row.score, automaticAPlus: row.automaticAPlus, openingReturnPct: row.openingReturnPct, depthMovePct: row.depthMovePct,
  prior1: { beatReturn: row.beatReturnCount1, volumeRatio: row.volumeRatio1, rangeRatio: row.rangeRatio1 },
  prior3: { beatReturn: row.beatReturnCount3, volumeRatio: row.volumeRatio3, rangeRatio: row.rangeRatio3 },
  prior5: { beatReturn: row.beatReturnCount5, volumeRatio: row.volumeRatio5, rangeRatio: row.rangeRatio5 },
  prior10: { beatReturn: row.beatReturnCount10, volumeRatio: row.volumeRatio10, rangeRatio: row.rangeRatio10, returnVsMaxPct: row.returnVsMax10Pct },
  eodReturnPct: row.eodReturnPct, maximumFavorableExcursionPct: row.mfePct, maximumAdverseExcursionPct: row.maePct
})

const report = {
  dates: ['2026-11-19', '2026-11-20'],
  noFutureLeakage: 'Signal time and A+ qualification use only candles/depth available by signal time plus completed prior sessions. EOD return is evaluation only. HISTORICAL_A_PLUS_GT_2 is a post-session reporting label and must not be used live.',
  automaticAPlusRule: '10/10 base confirmation; opening return >=0.50%; beats all prior five and >=9/10 prior same-time returns; efficiency >=1.30; prior-ten range ratio >=1.20; prior-ten volume ratio 0.70-3.00; opening-return rank <=55; depth midpoint move >=0.50%; mean bid share <=53%; opening return no more than 1pp above prior-ten maximum.',
  validation: { '2026-11-17': { automaticSignals: 0 }, '2026-11-18': { automaticSignals: 0 }, '2026-11-19': { automaticSignals: automaticRows.filter(x => x.date === '2026-11-19').length }, '2026-11-20': { automaticSignals: automaticRows.filter(x => x.date === '2026-11-20').length } },
  missing: [{ date: '2026-11-19', symbol: 'TATATECH', reason: 'No local November 19 candle/depth data; latest candle is October 16.' }],
  preferredSummary: summary(preferredRows), automaticAPlusSummary: summary(automaticRows), selectedSummary: summary(selected),
  automaticAPlusSignals: automaticRows.map(compact), selectedSignals: selected.map(compact)
}

let suffix = 1, file
do { file = path.join(root, 'reports', `2026-11-19-and-20-best-opening-confirmations${suffix === 1 ? '' : `-${suffix}`}.json`); suffix++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
console.table(selected.map(row => ({ Date: row.date, Time: row.signalTime, Stock: row.symbol, Selection: row.preferred ? 'USER' : 'A+', 'A+': row.automaticAPlus ? 'YES' : '-', 'EOD %': row.eodReturnPct, 'MAE %': row.maePct })))
console.log(JSON.stringify({ file, preferredSummary: report.preferredSummary, automaticAPlusSummary: report.automaticAPlusSummary, selectedSummary: report.selectedSummary }, null, 2))
