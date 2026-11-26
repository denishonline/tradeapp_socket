import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const singleDate = process.argv.slice(2).length === 1
const dates = process.argv.slice(2).length >= 1 ? process.argv.slice(2) : ['2026-11-03', '2026-11-04']
const IST = 330 * 60_000
const local = t => { const d = new Date(t * 1000 + IST); return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) } }
const pct = (a, b) => 100 * (a / b - 1)
const round = x => Number.isFinite(x) ? Number(x.toFixed(3)) : null
const rows = []

for (const file of fs.readdirSync(path.join(root, 'db/candles')).filter(x => x.endsWith('.jsonl'))) {
  const symbol = file.replace(/\.jsonl$/, '')
  if (/^NIFTY|^BANK|^FINNIFTY|^MIDCPNIFTY/i.test(symbol)) continue
  const byDate = Object.fromEntries(dates.map(d => [d, []]))
  for (const line of fs.readFileSync(path.join(root, 'db/candles', file), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const t = local(Number(x.time))
    if (byDate[t.date] && ['09:15', '09:16', '09:17'].includes(t.hm)) byDate[t.date].push({ ...x, hm: t.hm })
  }
  if (dates.some(d => byDate[d].length !== 3)) continue
  const [a, b] = dates.map(d => byDate[d].sort((x, y) => x.time - y.time))
  if (singleDate) {
    const c = a
    const rejection = c[0].close < c[0].open && (c[0].open - c[0].close) / Math.max(0.01, c[0].high - c[0].low) > 0.25
    const recovery = c[1].close > c[0].close && c[2].close >= c[1].close
    const higherHigh = c[2].high > c[1].high
    const bullishContinuation = c[2].close > c[1].open
    if (rejection && recovery && higherHigh && bullishContinuation) rows.push({ symbol, rejectionCandle: '09:15', recoveryThrough: '09:17', low: round(Math.min(...c.map(x => x.low))), high: round(Math.max(...c.map(x => x.high))), returnPct: round(pct(c[2].close, c[0].open)), volume: c.reduce((s, x) => s + x.volume, 0) })
    continue
  }
  const lowA = Math.min(...a.map(x => x.low)), lowB = Math.min(...b.map(x => x.low))
  const sharedSupport = Math.abs(pct(lowB, lowA)) <= 0.8
  const rejectionA = a[0].close > a[0].low && (a[0].high - a[0].close) / Math.max(0.01, a[0].high - a[0].low) < 0.35
  const rejectionB = (a[0].close - a[0].low) / Math.max(0.01, a[0].high - a[0].low) > 0.25 && b[0].close < b[0].open
  const recoveryA = a[1].close > a[0].close && a[2].close > a[1].close
  const recoveryB = b[1].close > b[0].close && b[2].close > b[1].close
  const bullishConfirmA = a[2].close > a[0].high
  const higherHighB = b[2].high > b[1].high
  const volumeAbsorption = b[0].volume > b[1].volume && b[1].close > b[1].open
  if (sharedSupport && rejectionA && rejectionB && recoveryA && recoveryB && bullishConfirmA && higherHighB && volumeAbsorption) rows.push({ symbol, support3: round(lowA), support4: round(lowB), supportDiffPct: round(pct(lowB, lowA)), nov3ReturnPct: round(pct(a[2].close, a[0].open)), nov4ReturnPct: round(pct(b[2].close, b[0].open)), nov3Volume: a.reduce((s, x) => s + x.volume, 0), nov4Volume: b.reduce((s, x) => s + x.volume, 0), nov4High: b[2].high })
}
rows.sort((a, b) => b.nov4ReturnPct - a.nov4ReturnPct)
const outFile = path.join(root, 'reports', '2026-11-03-04-0917-repeated-absorption-stocks.json')
fs.writeFileSync(outFile, JSON.stringify({ dates, cutoff: '09:17', criteria: 'shared support within 0.8%; opening rejection; recovery; Nov 3 close above 09:15 high; Nov 4 higher high; lower-volume bullish absorption candle', stocks: rows }, null, 2) + '\n')
console.table(rows)
console.log(`JSON: ${outFile}`)
