import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd(), symbol = (process.argv[2] ?? 'ULTRACEMCO').replace(/-EQ$/i, '').toUpperCase()
const targetDate = process.argv[3] ?? '2026-10-19', cutoff = process.argv[4] ?? 'latest', window = 300
const IST = 330 * 60_000, cutoffValue = cutoff === 'latest' ? Infinity : Number(cutoff.slice(0, 2)) * 60 + Number(cutoff.slice(3))
const round = (x, p = 6) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const local = t => { const d = new Date(t * 1000 + IST); return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() } }
const file = path.join(root, 'db/candles', `${symbol}.jsonl`)
if (!fs.existsSync(file)) throw new Error(`Missing candle file for ${symbol}`)
const unique = new Map()
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let row
  try { row = JSON.parse(line) } catch { continue }
  const time = Number(row.time), close = Number(row.close), volume = Number(row.volume), at = local(time)
  if (!Number.isFinite(time) || !Number.isFinite(close) || !Number.isFinite(volume) || close <= 0 || at.date > targetDate || at.minute < 555 || at.minute >= 930 || (at.date === targetDate && at.minute >= cutoffValue)) continue
  if (!unique.has(time)) unique.set(time, { time, close, volume })
}
const candles = [...unique.values()].sort((a, b) => a.time - b.time)
if (candles.length < window) throw new Error(`Only ${candles.length} usable candles; need ${window}`)
const pvi = [1000]
for (let i = 1; i < candles.length; i++) {
  const previous = candles[i - 1], current = candles[i]
  pvi.push(current.volume > previous.volume ? pvi[i - 1] * current.close / previous.close : pvi[i - 1])
}
const ema = period => { const alpha = 2 / (period + 1); const out = [pvi[0]]; for (const value of pvi.slice(1)) out.push(alpha * value + (1 - alpha) * out.at(-1)); return out }
const angle = values => { const ys = values.map(Math.log), n = ys.length, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n; let cov = 0, xx = 0; ys.forEach((y, i) => { cov += (i - mx) * (y - my); xx += (i - mx) ** 2 }); const slope = cov / xx; return { slopePctPerCandle: 100 * slope, angleDeg: Math.atan(100 * slope) * 180 / Math.PI } }
const ema9 = ema(9), ema45 = ema(45), ema255 = ema(255), start = candles.length - window, current = candles.at(-1), currentLocal = local(current.time)
const a9 = angle(ema9.slice(start)), a45 = angle(ema45.slice(start)), a255 = angle(ema255.slice(start))
const output = { symbol, targetDate, cutoffIST: cutoff, currentCandleIST: `${currentLocal.date} ${String(Math.floor(currentLocal.minute / 60)).padStart(2, '0')}:${String(currentLocal.minute % 60).padStart(2, '0')}`, candlesUsedForPVI: candles.length, angleWindowCandles: window,
  method: 'PVI starts at 1000. On each candle with higher volume than the previous candle, PVI is multiplied by current close / previous close; otherwise it is unchanged. EMA angles use a least-squares regression of log(PVI-EMA) over the latest 300 candles: angle = atan(100 × slope) in degrees.',
  current: { pvi: round(pvi.at(-1), 6), pviEma9: round(ema9.at(-1), 6), pviEma45: round(ema45.at(-1), 6), pviEma255: round(ema255.at(-1), 6), emaDistance: round(ema9.at(-1) - ema45.at(-1), 6), emaDistancePct: round(100 * (ema9.at(-1) / ema45.at(-1) - 1), 6), pviEma9AngleDeg: round(a9.angleDeg, 6), pviEma45AngleDeg: round(a45.angleDeg, 6), pviEma255AngleDeg: round(a255.angleDeg, 6), pviEma9SlopePctPerCandle: round(a9.slopePctPerCandle, 8), pviEma45SlopePctPerCandle: round(a45.slopePctPerCandle, 8), pviEma255SlopePctPerCandle: round(a255.slopePctPerCandle, 8) } }
let n = 1, outFile
do { outFile = path.join(root, 'reports', `${targetDate}-${symbol}-pvi-ema-angle${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(outFile))
fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(output, null, 2)); console.log(`JSON: ${outFile}`)
