import { readFile, writeFile } from 'node:fs/promises'

const DATE = '2026-11-25'
const MINUTE = 60
const at = time => Date.parse(`${DATE}T${time}:00+05:30`) / 1000
const OPEN = at('09:15')
const SIGNAL = at('12:30')
const ENTRY = SIGNAL + MINUTE
const EXIT = at('13:30')
const avg = values => values.reduce((a, b) => a + b, 0) / values.length
const pct = (value, base) => 100 * (value / base - 1)
const hi = bars => Math.max(...bars.map(bar => bar.high))
const lo = bars => Math.min(...bars.map(bar => bar.low))
const tr = (bar, prev) => Math.max(bar.high - bar.low,
  prev ? Math.abs(bar.high - prev.close) : 0, prev ? Math.abs(bar.low - prev.close) : 0)
const relClose = bar => bar.high > bar.low ? (bar.close - bar.low) / (bar.high - bar.low) : 0.5
const body = bar => Math.abs(bar.close - bar.open)
const clock = time => new Date((time + 19800) * 1000).toISOString().slice(11, 16)

async function readSession(symbol, until) {
  const byTime = new Map()
  const raw = await readFile(`db/candles/${symbol}.jsonl`, 'utf8')
  for (const match of raw.matchAll(/^\{"time":(\d+),.*$/gm)) {
    const time = Number(match[1])
    if (time < OPEN || time >= until) continue
    byTime.set(time, JSON.parse(match[0]))
  }
  return byTime
}

function* completedBars(byTime, until) {
  let previous
  for (let time = OPEN; time + MINUTE <= until; time += MINUTE) {
    const bar = byTime.get(time) ?? (previous && {
      time, open: previous.close, high: previous.close, low: previous.close,
      close: previous.close, volume: 0, carried: true,
    })
    if (!bar) throw new Error(`Missing opening candle at ${clock(time)}`)
    previous = bar
    yield bar
  }
}

function aggregate(bars, size) {
  const output = []
  for (let i = 0; i + size <= bars.length; i += size) {
    const chunk = bars.slice(i, i + size)
    output.push({
      open: chunk[0].open, close: chunk.at(-1).close,
      high: hi(chunk), low: lo(chunk), volume: chunk.reduce((sum, bar) => sum + bar.volume, 0),
    })
  }
  return output
}

function ema(values, length) {
  const alpha = 2 / (length + 1)
  return values.reduce((output, value) => {
    output.push(output.length ? output.at(-1) + alpha * (value - output.at(-1)) : value)
    return output
  }, [])
}

function features(bars) {
  const last = bars.at(-1)
  const result = { sessionReturn: pct(last.close, bars[0].open) }
  for (const n of [5, 10, 15, 30, 45, 60, 90, 120, 195]) {
    const window = bars.slice(-n)
    const prior = bars.slice(-n - 15, -n)
    const high = hi(window), low = lo(window)
    const volume = window.reduce((sum, b) => sum + b.volume, 0)
    const vwap = window.reduce((sum, b) => sum + (b.high + b.low + b.close) / 3 * b.volume, 0) / volume
    result[`return_${n}`] = pct(last.close, window[0].open)
    result[`range_${n}`] = pct(high, low)
    result[`fromHigh_${n}`] = pct(last.close, high)
    result[`fromLow_${n}`] = pct(last.close, low)
    result[`closeLocation_${n}`] = high > low ? (last.close - low) / (high - low) : 0.5
    result[`vwapDistance_${n}`] = pct(last.close, vwap)
    result[`downVolumeShare_${n}`] = window.filter(b => b.close < b.open).reduce((sum, b) => sum + b.volume, 0) / volume
    if (prior.length) {
      result[`supportDistance_${n}`] = pct(last.close, lo(prior))
      result[`resistanceDistance_${n}`] = pct(last.close, hi(prior))
      result[`volumeRatio_${n}`] = volume / window.length / avg(prior.map(b => b.volume))
    }
  }
  for (const size of [1, 3, 5, 10, 15]) {
    const frame = aggregate(bars, size)
    const close = frame.map(bar => bar.close)
    const current = frame.at(-1), prev = frame.at(-2)
    const atr = avg(frame.slice(-10).map((bar, i, window) => tr(bar, window[i - 1])))
    result[`closeLocationFrame_${size}`] = relClose(current)
    result[`lowerLowFrame_${size}`] = pct(current.low, prev.low)
    result[`lowerHighFrame_${size}`] = pct(current.high, prev.high)
    result[`bodyAtr_${size}`] = (current.close - current.open) / atr
    result[`upperWickAtr_${size}`] = (current.high - Math.max(current.close, current.open)) / atr
    result[`lowerWickAtr_${size}`] = (Math.min(current.close, current.open) - current.low) / atr
    result[`bodyExpansion_${size}`] = body(current) / avg(frame.slice(-7, -1).map(body))
    result[`atrPct_${size}`] = atr / current.close
    const changes = close.slice(-11).slice(1).map((c, i) => c - close.slice(-11)[i])
    const gain = avg(changes.map(x => Math.max(x, 0)))
    const loss = avg(changes.map(x => Math.max(-x, 0)))
    result[`rsi_${size}`] = gain + loss ? 100 * gain / (gain + loss) : 50
    for (const length of [5, 10, 20, 45]) {
      if (frame.length < length + 3) continue
      const line = ema(close, length)
      result[`emaSlope_${size}_${length}`] = pct(line.at(-1), line.at(-4))
      result[`emaDistance_${size}_${length}`] = pct(current.close, line.at(-1))
    }
    const pivots = frame.slice(2, -2).filter((b, i) => b.low < frame[i].low &&
      b.low < frame[i + 1].low && b.low <= frame[i + 3].low && b.low <= frame[i + 4].low)
    if (pivots.length) result[`confirmedPivotLowDistance_${size}`] = pct(current.close, pivots.at(-1).low)
  }
  for (const size of [1, 3, 5]) {
    const frame = aggregate(bars, size)
    for (const lookback of [15, 30, 45]) {
      const recent = frame.slice(-Math.floor(lookback / size))
      const prior = frame.slice(-Math.floor((lookback + 15) / size), -Math.floor(lookback / size))
      const support = lo(prior)
      const resistance = hi(prior)
      const breakIndex = recent.findIndex(bar => bar.close < support)
      const failedRetest = breakIndex >= 0 && recent.slice(breakIndex + 1).some((bar, i) =>
        recent[breakIndex + i].close < support && bar.high >= support && bar.close < support)
      result[`supportRetest_${size}_${lookback}`] = Number(failedRetest && last.close < support)
      const failedResistance = recent.some((bar, i) => i > 0 &&
        recent[i - 1].close < resistance && bar.high >= resistance && bar.close < resistance)
      result[`resistanceRejection_${size}_${lookback}`] = Number(failedResistance && last.close < resistance)
    }
  }
  return result
}

const prefix = `reports/${DATE}`
const gate = JSON.parse(await readFile(`${prefix}-1215-to-1230-depth-rule-eligibility.json`, 'utf8'))
const depth = JSON.parse(await readFile(`${prefix}-1215-to-1230-138-eligible-depth-research-features.json`, 'utf8'))
const depthByStock = new Map(depth.results.map(row => [row.stock, row]))
const candidates = []
for (const stock of gate.eligible) {
  const bars = await readSession(stock, SIGNAL)
  const known = [...completedBars(bars, SIGNAL)]
  const { spread5minMove, imb5, imb2, ofiPct, askHeavyPct, bidQty5minMove, askQty5minMove, minutes } = depthByStock.get(stock)
  const late = minutes.slice(-5)
  const early = minutes.slice(0, 5)
  const lateImb5 = avg(late.map(m => m.imb5))
  const lateImb2 = avg(late.map(m => m.imb2))
  candidates.push({ stock, carriedMinutes: known.filter(bar => bar.carried).length,
    ...features(known), spread5minMove, imb5, imb2, ofiPct,
    askHeavyPct, bidQty5minMove, askQty5minMove, lateImb5, lateImb2,
    lateImb5Change: lateImb5 - avg(early.map(m => m.imb5)),
    lateImb2Change: lateImb2 - avg(early.map(m => m.imb2)),
    lateBidMove: pct(late.at(-1).bid, late[0].bid),
    lateAskMove: pct(late.at(-1).ask, late[0].ask),
    lateMidMove: pct(late.at(-1).mid, late[0].mid) })
}

const featureReport = { date: DATE, signalTime: clock(SIGNAL), candidates }

if (process.argv.includes('--features') || process.argv.includes('--extended-features')) {
  const suffix = process.argv.includes('--extended-features') ? 'extended-candle-depth-features' : 'causal-candle-features'
  await writeFile(`${prefix}-1230-${suffix}.json`, JSON.stringify(featureReport, null, 2) + '\n', { flag: 'wx' })
} else {
  const ruleArg = process.argv.indexOf('--rules')
  if (ruleArg < 0) throw new Error('Pass --features or --rules <path>')
  const rules = JSON.parse(await readFile(process.argv[ruleArg + 1], 'utf8'))
  const branches = Array.isArray(rules) ? [{ name: 'Original candle filter', conditions: rules }] : rules.branches
  const signals = candidates.flatMap(row => {
    const setups = branches.filter(branch => branch.conditions.every(({ key, direction, threshold }) =>
      Number.isFinite(row[key]) && direction * (row[key] - threshold) >= 0)).map(branch => branch.name)
    return setups.length ? [{ stock: row.stock, signalTime: clock(SIGNAL), side: 'SELL', setups }] : []
  })
  console.log(JSON.stringify({ date: DATE, signals }))
  if (process.argv.includes('--scan-only')) process.exit(0)
  const ranking = JSON.parse(await readFile(`${prefix}-1230-to-1330-stock-declines.json`, 'utf8')).rows
  const outcomes = new Map(ranking.map((row, index) => [row.stock, { rank: index + 1, changePct: row.changePct }]))
  const trades = await Promise.all(signals.map(async signal => {
    const bars = await readSession(signal.stock, EXIT)
    const entry = bars.get(ENTRY - MINUTE).close
    const exit = bars.get(EXIT - MINUTE).close
    const path = [...bars.values()].filter(bar => bar.time >= ENTRY && bar.time < EXIT)
    return { ...signal, ...outcomes.get(signal.stock), entryTime: clock(ENTRY), exitTime: clock(EXIT), entry, exit,
      grossShortReturnPct: 100 * (entry - exit) / entry,
      maePct: Math.max(0, pct(hi(path), entry)) }
  }))
  const summary = { trades: trades.length, top10Hits: trades.filter(t => t.rank <= 10).length,
    winRatePct: 100 * trades.filter(t => t.grossShortReturnPct > 0).length / trades.length,
    averageReturnPct: avg(trades.map(t => t.grossShortReturnPct)),
    totalReturnPct: trades.reduce((sum, t) => sum + t.grossShortReturnPct, 0),
    maxMaePct: Math.max(...trades.map(t => t.maePct)), worstDay: DATE }
  const suffix = Array.isArray(rules) ? 'causal-candle-scanner-replay' : 'two-setup-candle-depth-replay'
  await writeFile(`${prefix}-1230-${suffix}.json`, JSON.stringify({
    date: DATE, rules, summary, signals, trades,
    note: 'Same-session rule selection. Gross returns exclude costs and slippage. Total return is the sum of individual gross returns.',
  }, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ summary, targets: trades.filter(t => t.rank <= 10).sort((a, b) => a.rank - b.rank) }, null, 2))
}
