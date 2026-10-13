import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const input = path.join(root, 'csv', '2026-10-06-to-09-balanced-failed-bid-absorption.csv')

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  const columns = lines[0].split(',')
  return lines.slice(1).map((line) => {
    const values = line.split(',')
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]))
  })
}

const round = (n, d = 3) => Number.isFinite(n) ? Number(n.toFixed(d)) : null
const ema = (values, length) => {
  const alpha = 2 / (length + 1)
  return values.reduce((value, current, index) => index ? alpha * current + (1 - alpha) * value : current, NaN)
}
function rsi(values, length = 14) {
  if (values.length < length + 1) return NaN
  const selected = values.slice(-length - 1)
  let gains = 0; let losses = 0
  for (let i = 1; i < selected.length; i += 1) {
    const change = selected[i] - selected[i - 1]
    if (change >= 0) gains += change
    else losses -= change
  }
  if (!losses) return 100
  return 100 - 100 / (1 + gains / losses)
}

const signals = parseCsv(fs.readFileSync(input, 'utf8'))
const output = []
for (const signal of signals) {
  const file = path.join(root, 'db', 'candles', `${signal.symbol}.jsonl`)
  const candles = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse).map((row) => ({
    at: new Date(Number(row.time) * 1000 + 330 * 60_000).toISOString(),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  })).filter((row) => row.at.slice(0, 10) === signal.date && row.at.slice(11, 16) < signal.confirmationTime)
  const closes = candles.map((row) => row.close)
  const current = candles.at(-1)
  const ret = (minutes) => candles.length > minutes ? 100 * (current.close / candles.at(-minutes - 1).close - 1) : NaN
  const value = candles.reduce((total, row) => total + ((row.high + row.low + row.close) / 3) * row.volume, 0)
  const volume = candles.reduce((total, row) => total + row.volume, 0)
  const trueRanges = candles.map((row, index) => Math.max(row.high - row.low, index ? Math.abs(row.high - candles[index - 1].close) : 0, index ? Math.abs(row.low - candles[index - 1].close) : 0))
  const latest5 = candles.slice(-5)
  output.push({
    date: signal.date, symbol: signal.symbol, result: signal.result,
    time: signal.confirmationTime, dayReturn: round(100 * (Number(signal.entryPrice) / candles[0].open - 1)),
    return5: round(ret(5)), return15: round(ret(15)), return30: round(ret(30)),
    rsi14: round(rsi(closes)), vwapGap: round(100 * (current.close / (value / volume) - 1)),
    ema9Gap20: round(100 * (ema(closes, 9) / ema(closes, 20) - 1)),
    atr14Pct: round(100 * (trueRanges.slice(-14).reduce((a, b) => a + b, 0) / 14) / current.close),
    green5VolumePct: round(100 * latest5.filter((row) => row.close > row.open).reduce((a, row) => a + row.volume, 0) / latest5.reduce((a, row) => a + row.volume, 0)),
    closeReturn: Number(signal.closeReturnPct), maxLater: Number(signal.maxLaterReturnPct), maxAdverse: Number(signal.maxAdversePct),
  })
}
console.table(output)
