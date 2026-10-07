import fs from "node:fs"
import path from "node:path"

const date = process.argv[2]
const symbol = String(process.argv[3] || "").toUpperCase().replace(/-EQ$/, "")
const periods = process.argv.slice(4)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !symbol || !periods.length) {
  throw new Error("Usage: node scripts/analyze-candle-regime.js YYYY-MM-DD SYMBOL HH:MM-HH:MM [...]")
}

const indiaDate = (timestamp) => new Date(timestamp + 330 * 60_000).toISOString().slice(0, 10)
const timestamp = (clock) => Date.parse(`${date}T${clock}:00+05:30`)
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const round = (value, digits = 3) => Number(value.toFixed(digits))

const candles = fs.readFileSync(path.join(process.cwd(), "db", "candles", `${symbol}.jsonl`), "utf8")
  .split(/\r?\n/).filter(Boolean).map(JSON.parse)
  .map((row) => ({ ...row, timestamp: Number(row.time) * 1000 }))
  .filter((row) => indiaDate(row.timestamp) === date)
  .sort((a, b) => a.timestamp - b.timestamp)

function rollingChoppiness14(rows) {
  const values = []
  for (let end = 13; end < rows.length; end++) {
    const window = rows.slice(end - 13, end + 1)
    if (window.some((row, index) => index > 0 && row.time !== window[index - 1].time + 60)) continue
    let trueRange = 0
    for (let index = 0; index < window.length; index++) {
      const previousClose = index ? window[index - 1].close : window[index].open
      trueRange += Math.max(window[index].high - window[index].low,
        Math.abs(window[index].high - previousClose), Math.abs(window[index].low - previousClose))
    }
    const high = Math.max(...window.map((row) => row.high))
    const low = Math.min(...window.map((row) => row.low))
    if (high > low) values.push(100 * Math.log10(trueRange / (high - low)) / Math.log10(14))
  }
  return values
}

function summarize(period) {
  const [start, end] = period.split("-")
  const startAt = timestamp(start)
  const endAt = timestamp(end)
  const rows = candles.filter((row) => row.timestamp >= startAt && row.timestamp < endAt)
  const changes = rows.slice(1).map((row, index) => row.close / rows[index].close - 1)
  const changeMean = changes.length ? mean(changes) : 0
  const realizedVolatility = changes.length
    ? Math.sqrt(Math.max(0, mean(changes.map((value) => value ** 2)) - changeMean ** 2)) * 10_000 : 0
  let trueRange = 0
  let travel = 0
  for (let index = 0; index < rows.length; index++) {
    const previousClose = index ? rows[index - 1].close : rows[index].open
    trueRange += Math.max(rows[index].high - rows[index].low,
      Math.abs(rows[index].high - previousClose), Math.abs(rows[index].low - previousClose))
    travel += Math.abs(rows[index].close - previousClose)
  }
  const x = rows.map((row) => (row.timestamp - startAt) / 60_000)
  const y = rows.map((row) => row.close)
  const xMean = mean(x)
  const yMean = mean(y)
  const covariance = mean(x.map((value, index) => (value - xMean) * (y[index] - yMean)))
  const xVariance = mean(x.map((value) => (value - xMean) ** 2))
  const yVariance = mean(y.map((value) => (value - yMean) ** 2))
  const slope = covariance / xVariance
  const choppiness = rollingChoppiness14(rows)
  let directionPairs = 0
  let directionFlips = 0
  let previousDirection = 0
  for (const row of rows) {
    const direction = Math.sign(row.close - row.open)
    if (!direction) continue
    if (previousDirection) {
      directionPairs++
      if (direction !== previousDirection) directionFlips++
    }
    previousDirection = direction
  }
  const averagePrice = mean(y)
  const trailing = candles.filter((row) => row.timestamp < endAt)
  const latest = trailing.at(-1)
  const trailingReturn = (bars) => trailing.length > bars &&
    latest.time === trailing.at(-bars - 1).time + bars * 60
    ? round((latest.close / trailing.at(-bars - 1).close - 1) * 100) : null
  const rsiRows = trailing.slice(-15)
  let rsi14 = null
  if (rsiRows.length === 15 && rsiRows.every((row, index) =>
    index === 0 || row.time === rsiRows[index - 1].time + 60)) {
    let gains = 0
    let losses = 0
    for (let index = 1; index < rsiRows.length; index++) {
      const change = rsiRows[index].close - rsiRows[index - 1].close
      gains += Math.max(change, 0)
      losses += Math.max(-change, 0)
    }
    rsi14 = round(losses ? 100 - 100 / (1 + gains / losses) : 100, 1)
  }
  return {
    period, bars: rows.length,
    gaps: rows.slice(1).filter((row, index) => row.time !== rows[index].time + 60).length,
    open: rows[0].open, close: rows.at(-1).close,
    returnPct: round((rows.at(-1).close / rows[0].open - 1) * 100),
    rangePct: round((Math.max(...rows.map((row) => row.high)) /
      Math.min(...rows.map((row) => row.low)) - 1) * 100),
    averageBarRangePct: round(mean(rows.map((row) => (row.high - row.low) / row.open * 100))),
    realizedVolatilityBps: round(realizedVolatility, 2),
    atrPct: round(trueRange / rows.length / averagePrice * 100),
    efficiency: round(Math.abs(rows.at(-1).close - rows[0].open) / (travel || 1)),
    averageChoppiness14: choppiness.length ? round(mean(choppiness), 1) : null,
    slopeBpsPerMinute: round(slope / averagePrice * 10_000, 2),
    trendR2: round(yVariance ? covariance ** 2 / (xVariance * yVariance) : 0),
    green: rows.filter((row) => row.close > row.open).length,
    red: rows.filter((row) => row.close < row.open).length,
    directionFlipPct: directionPairs ? round(directionFlips / directionPairs * 100, 1) : null,
    averageVolume: Math.round(mean(rows.map((row) => row.volume))),
    medianVolume: median(rows.map((row) => row.volume)),
    momentum5Pct: trailingReturn(5), momentum10Pct: trailingReturn(10),
    momentum20Pct: trailingReturn(20), rsi14,
  }
}

console.table(periods.map(summarize))
