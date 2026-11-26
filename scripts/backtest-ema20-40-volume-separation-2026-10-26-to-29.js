#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const START = '2026-10-26'
const END = '2026-10-29'
const DATES = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']
const IST = 330 * 60_000
const CANDLE_ROOT = path.join(ROOT, 'db', 'candles')
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null
const dateAt = milliseconds => new Date(milliseconds + IST).toISOString().slice(0, 10)
const timeAt = milliseconds => new Date(milliseconds + IST).toISOString().slice(11, 16)
const pct = (value, base) => 100 * (value / base - 1)
const csvValue = value => /[",\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '')
const unique = (stem, extension) => {
  let number = 1, filename
  do {
    filename = path.join(ROOT, 'reports', `${stem}${number === 1 ? '' : `-${number}`}.${extension}`)
    number++
  } while (fs.existsSync(filename))
  return filename
}

const symbols = fs.readdirSync(CANDLE_ROOT)
  .filter(filename => filename.endsWith('.jsonl'))
  .map(filename => filename.slice(0, -6))
  .filter(symbol => symbol !== 'NIFTY50')
  .sort()

function loadAndCalculate(symbol) {
  const filename = path.join(CANDLE_ROOT, `${symbol}.jsonl`)
  const rows = fs.readFileSync(filename, 'utf8').split(/\r?\n/).flatMap(line => {
    if (!line) return []
    try {
      const value = JSON.parse(line), at = Number(value.time) * 1000
      const row = { at, date: dateAt(at), open: +value.open, high: +value.high, low: +value.low, close: +value.close, volume: +value.volume }
      return row.date <= END && Object.values(row).every(value => typeof value === 'string' || Number.isFinite(value)) ? [row] : []
    } catch { return [] }
  }).sort((left, right) => left.at - right.at)

  let ema20, ema40
  for (const row of rows) {
    ema20 = ema20 == null ? row.close : ema20 + 2 / 21 * (row.close - ema20)
    ema40 = ema40 == null ? row.close : ema40 + 2 / 41 * (row.close - ema40)
    row.ema20 = ema20
    row.ema40 = ema40
    row.sign = Math.sign(ema20 - ema40)
  }
  return rows
}

const trades = []
let symbolsWithData = 0
let rawCrosses = 0

for (const symbol of symbols) {
  const allRows = loadAndCalculate(symbol)
  let hasTestData = false
  for (const date of DATES) {
    const rows = allRows.filter(row => row.date === date)
    if (rows.length < 2) continue
    hasTestData = true
    for (let index = 1; index < rows.length - 1; index++) {
      const previous = rows[index - 1], signal = rows[index]
      if (!previous.sign || !signal.sign || previous.sign === signal.sign) continue
      rawCrosses++

      const prior20 = rows.slice(Math.max(0, index - 20), index)
      if (!prior20.length) continue
      const averageVolume = prior20.reduce((sum, row) => sum + row.volume, 0) / prior20.length
      const closeDistancePct = Math.abs(pct(signal.close, signal.ema20))
      const volumeRatio = averageVolume > 0 ? signal.volume / averageVolume : 0
      if (closeDistancePct < 0.40 || volumeRatio < 10) continue

      const side = signal.sign > 0 ? 'BUY' : 'SELL'
      const direction = side === 'BUY' ? 1 : -1
      const entryIndex = index + 1, entry = rows[entryIndex]
      let exitIndex = rows.length - 1, exitReason = 'EOD'
      for (let cursor = entryIndex; cursor < rows.length; cursor++) {
        if (rows[cursor - 1].sign && rows[cursor].sign && rows[cursor - 1].sign !== rows[cursor].sign) {
          exitIndex = cursor
          exitReason = 'OPPOSITE_CROSS_CLOSE'
          break
        }
      }
      const exit = rows[exitIndex]
      const holdingRows = rows.slice(entryIndex, exitIndex + 1)
      const returnPct = direction * pct(exit.close, entry.open)
      const maximumFavorableExcursionPct = direction > 0
        ? Math.max(...holdingRows.map(row => pct(row.high, entry.open)))
        : Math.max(...holdingRows.map(row => pct(entry.open, row.low)))
      const maximumAdverseExcursionPct = direction > 0
        ? Math.min(...holdingRows.map(row => pct(row.low, entry.open)))
        : Math.min(...holdingRows.map(row => pct(entry.open, row.high)))

      trades.push({
        date, symbol, side,
        signalTime: timeAt(signal.at),
        entryTime: timeAt(entry.at), entryPrice: round(entry.open),
        exitTime: timeAt(exit.at), exitPrice: round(exit.close), exitReason,
        holdMinutes: exitIndex - index,
        returnPct: round(returnPct),
        maximumFavorableExcursionPct: round(maximumFavorableExcursionPct),
        maximumAdverseExcursionPct: round(maximumAdverseExcursionPct),
        signalCloseVsEma20Pct: round(pct(signal.close, signal.ema20)),
        absoluteSignalCloseVsEma20Pct: round(closeDistancePct),
        signalVolumeVsPrior20: round(volumeRatio, 2),
      })
    }
  }
  if (hasTestData) symbolsWithData++
}

trades.sort((left, right) => left.date.localeCompare(right.date) || left.signalTime.localeCompare(right.signalTime) || left.symbol.localeCompare(right.symbol))
const returns = trades.map(trade => trade.returnPct)
const daily = DATES.map(date => {
  const rows = trades.filter(trade => trade.date === date), values = rows.map(row => row.returnPct)
  return {
    date,
    tradeCount: rows.length,
    winRatePct: round(100 * rows.filter(row => row.returnPct > 0).length / (rows.length || 1)),
    winnersOver1Pct: rows.filter(row => row.returnPct > 1).length,
    averageReturnPct: round(values.reduce((sum, value) => sum + value, 0) / (values.length || 1)),
    totalReturnPct: round(values.reduce((sum, value) => sum + value, 0)),
    maximumAdverseExcursionPct: rows.length ? round(Math.min(...rows.map(row => row.maximumAdverseExcursionPct))) : null,
  }
})
const worstDay = [...daily].sort((left, right) => left.totalReturnPct - right.totalReturnPct)[0]
const summary = {
  tradeCount: trades.length,
  buyCount: trades.filter(trade => trade.side === 'BUY').length,
  sellCount: trades.filter(trade => trade.side === 'SELL').length,
  profitableTradeCount: trades.filter(trade => trade.returnPct > 0).length,
  winnersOver1Pct: trades.filter(trade => trade.returnPct > 1).length,
  winRatePct: round(100 * trades.filter(trade => trade.returnPct > 0).length / (trades.length || 1)),
  averageReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / (returns.length || 1)),
  totalReturnPct: round(returns.reduce((sum, value) => sum + value, 0)),
  maximumAdverseExcursionPct: trades.length ? round(Math.min(...trades.map(trade => trade.maximumAdverseExcursionPct))) : null,
  worstDay,
}

const methodology = {
  universe: `All ${symbolsWithData} individual-stock candle files with data during ${START} to ${END}; NIFTY50 excluded.`,
  rule: 'Completed EMA20/EMA40 cross in either direction; absolute signal close distance from EMA20 >= 0.40%; signal volume >= 10.00x the mean volume of up to 20 preceding completed candles in the same session.',
  ema: 'Continuous one-minute EMA20 and EMA40, seeded from each symbol\'s first locally available candle. The 09:15 candle is not compared directly with the prior session close for crossover detection, matching the frozen 28 October audit.',
  execution: 'Enter at the next one-minute candle open. Exit at the close of the first completed opposite EMA20/EMA40 cross, otherwise at the final session close. Gross returns; no fees or slippage.',
  chronology: 'Every selection input is known at the completed signal candle. No future candle is used to create a signal.',
}

const stem = `${START}-to-${END}-ema20-ema40-volume10-separation040-full-universe`
const jsonFile = unique(stem, 'json')
const csvFile = unique(stem, 'csv')
const mdFile = unique(stem, 'md')
fs.writeFileSync(jsonFile, JSON.stringify({ startDate: START, endDate: END, symbolsWithData, rawCrosses, methodology, summary, daily, trades }, null, 2) + '\n', { flag: 'wx' })
const fields = Object.keys(trades[0] ?? { date: '', symbol: '', side: '', signalTime: '' })
fs.writeFileSync(csvFile, [fields.join(','), ...trades.map(row => fields.map(field => csvValue(row[field])).join(','))].join('\n') + '\n', { flag: 'wx' })
const tradeTable = trades.length ? [
  '| Date | Symbol | Side | Signal | Entry | Exit | Return | MFE | MAE | Vol ratio | Close vs EMA20 |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...trades.map(row => `| ${row.date} | ${row.symbol} | ${row.side} | ${row.signalTime} | ${row.entryTime} @ ${row.entryPrice} | ${row.exitTime} @ ${row.exitPrice} | ${row.returnPct}% | ${row.maximumFavorableExcursionPct}% | ${row.maximumAdverseExcursionPct}% | ${row.signalVolumeVsPrior20}x | ${row.signalCloseVsEma20Pct}% |`),
].join('\n') : '_No signals._'
const dailyTable = [
  '| Date | Trades | Win rate | >1% winners | Average | Total | Worst MAE |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...daily.map(row => `| ${row.date} | ${row.tradeCount} | ${row.winRatePct}% | ${row.winnersOver1Pct} | ${row.averageReturnPct}% | ${row.totalReturnPct}% | ${row.maximumAdverseExcursionPct ?? 'n/a'}% |`),
].join('\n')
const markdown = [
  `# EMA20/EMA40 frozen-rule chronological backtest: ${START} to ${END}`,
  '', '## Result', '',
  `- Universe: ${symbolsWithData} stocks`,
  `- Raw EMA20/40 crosses: ${rawCrosses}`,
  `- Signals: ${summary.tradeCount} (${summary.buyCount} BUY, ${summary.sellCount} SELL)`,
  `- Win rate: ${summary.winRatePct}%`,
  `- Winners above 1%: ${summary.winnersOver1Pct}`,
  `- Average / summed return: ${summary.averageReturnPct}% / ${summary.totalReturnPct}%`,
  `- Worst MAE: ${summary.maximumAdverseExcursionPct}%`,
  `- Worst day: ${summary.worstDay.date}, ${summary.worstDay.totalReturnPct}%`,
  '', '## Frozen rule', '', methodology.rule, '', methodology.execution,
  '', '## Daily results', '', dailyTable,
  '', '## Signals', '', tradeTable,
  '', '## Notes', '', methodology.chronology, methodology.ema,
  '', `JSON: ${jsonFile}`, `CSV: ${csvFile}`,
].join('\n')
fs.writeFileSync(mdFile, markdown + '\n', { flag: 'wx' })

console.log(JSON.stringify({ jsonFile, csvFile, mdFile, symbolsWithData, rawCrosses, summary, daily, trades }, null, 2))
