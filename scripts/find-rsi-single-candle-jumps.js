import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const tradeDate = process.argv[2] ?? '2026-11-11'
const fromRsi = +(process.argv[3] ?? 65)
const toRsi = +(process.argv[4] ?? 90)
const mode = process.argv[5] ?? 'crossing'
const minJump = Number.isFinite(+(process.argv[6] ?? '')) ? +(process.argv[6]) : 0
const maxJump = Number.isFinite(+(process.argv[7] ?? '')) ? +(process.argv[7]) : Infinity
const local = epoch => new Date(epoch * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const round = (x, p = 4) => Number.isFinite(x) ? Number(x.toFixed(p)) : null
const symbols = [...new Set(JSON.parse(fs.readFileSync(path.join(root, 'db', 'stocks'), 'utf8')).map(x => String(x).replace(/-EQ$/i, '').toUpperCase()))]

function scan(symbol) {
  const file = path.join(root, 'db', 'candles', `${symbol}.jsonl`)
  if (!fs.existsSync(file)) return []
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let x; try { x = JSON.parse(line) } catch { continue }
    const stamp = local(+x.time), date = stamp.slice(0, 10), minute = stamp.slice(11)
    if (date > tradeDate || minute < '09:15' || minute > '15:29') continue
    if (!Number.isFinite(+x.close)) continue
    rows.push({ stamp, date, minute, close: +x.close })
  }
  rows.sort((a, b) => a.stamp.localeCompare(b.stamp))
  if (rows.length < 16) return []
  let avgGain = null, avgLoss = null, previous = null
  const rsiRows = []
  for (const row of rows) {
    if (previous) {
      const change = row.close - previous.close, gain = Math.max(change, 0), loss = Math.max(-change, 0)
      if (avgGain === null) {
        const i = rows.indexOf(row)
        if (i >= 14) {
          let gains = 0, losses = 0
          for (let j = i - 13; j <= i; j++) {
            const d = rows[j].close - rows[j - 1].close
            gains += Math.max(d, 0); losses += Math.max(-d, 0)
          }
          avgGain = gains / 14; avgLoss = losses / 14
        }
      } else {
        avgGain = (avgGain * 13 + gain) / 14
        avgLoss = (avgLoss * 13 + loss) / 14
      }
      const rsi = avgGain === null ? null : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
      rsiRows.push({ ...row, rsi })
    }
    previous = row
  }
  const hits = []
  for (let i = 1; i < rsiRows.length; i++) {
    const before = rsiRows[i - 1], current = rsiRows[i]
    const qualifies = mode === 'reach' ? before.rsi >= fromRsi && current.rsi >= toRsi : before.rsi < fromRsi && current.rsi >= toRsi
    if (before.date === tradeDate && current.date === tradeDate && qualifies && current.rsi - before.rsi >= minJump && current.rsi - before.rsi <= maxJump) {
      hits.push({ symbol, time: current.stamp, previous_rsi: round(before.rsi), current_rsi: round(current.rsi), rsi_jump: round(current.rsi - before.rsi), previous_close: before.close, current_close: current.close, price_change_pct: round(100 * (current.close / before.close - 1)) })
    }
  }
  return hits
}

const hits = []
for (let i = 0; i < symbols.length; i++) {
  hits.push(...scan(symbols[i]))
  const width = 26, filled = Math.round(width * (i + 1) / symbols.length)
  process.stderr.write(`\r[${'='.repeat(filled)}${'-'.repeat(width - filled)}] ${i + 1}/${symbols.length}`)
}
process.stderr.write('\n')
hits.sort((a, b) => b.rsi_jump - a.rsi_jump)
const stem = `${tradeDate}-rsi-single-candle-${fromRsi}-to-${toRsi}`
let output = path.join(root, 'reports', `${stem}.csv`), n = 2
while (fs.existsSync(output)) output = path.join(root, 'reports', `${stem}-${n++}.csv`)
const columns = ['symbol', 'time', 'previous_rsi', 'current_rsi', 'rsi_jump', 'previous_close', 'current_close', 'price_change_pct']
fs.writeFileSync(output, [columns.join(','), ...hits.map(row => columns.map(c => row[c]).join(','))].join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ tradeDate, rsiPeriod: 14, mode, fromRsi, toRsi, minJump, maxJump: Number.isFinite(maxJump) ? maxJump : null, universe: symbols.length, hitCount: hits.length, hits, output }, null, 2))
