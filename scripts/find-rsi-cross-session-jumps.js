import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const fromDate = process.argv[2] ?? '2026-11-01'
const toDate = process.argv[3] ?? '2026-11-11'
const minPreviousRsi = +(process.argv[4] ?? 65)
const minFirstRsi = +(process.argv[5] ?? 90)
const minJump = +(process.argv[6] ?? 20)
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
    if (date > toDate || minute < '09:15' || minute > '15:29' || !Number.isFinite(+x.close)) continue
    rows.push({ stamp, date, minute, open: +x.open, close: +x.close })
  }
  rows.sort((a, b) => a.stamp.localeCompare(b.stamp))
  if (rows.length < 16) return []
  let avgGain = null, avgLoss = null, previous = null, index = 0
  const rsiRows = []
  for (const row of rows) {
    if (previous) {
      const change = row.close - previous.close, gain = Math.max(change, 0), loss = Math.max(-change, 0)
      if (avgGain === null) {
        if (index >= 14) {
          let gains = 0, losses = 0
          for (let j = index - 13; j <= index; j++) {
            const d = rows[j].close - rows[j - 1].close
            gains += Math.max(d, 0); losses += Math.max(-d, 0)
          }
          avgGain = gains / 14; avgLoss = losses / 14
        }
      } else {
        avgGain = (avgGain * 13 + gain) / 14
        avgLoss = (avgLoss * 13 + loss) / 14
      }
      rsiRows.push({ ...row, rsi: avgGain === null ? null : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) })
    }
    previous = row
    index++
  }
  const byDate = new Map()
  for (const row of rsiRows) { if (!byDate.has(row.date)) byDate.set(row.date, []); byDate.get(row.date).push(row) }
  const dates = [...byDate.keys()].sort(), hits = []
  for (let i = 1; i < dates.length; i++) {
    const date = dates[i]
    if (date < fromDate || date > toDate) continue
    const prior = byDate.get(dates[i - 1]).at(-1), first = byDate.get(date).find(x => x.minute === '09:15')
    if (!prior || !first || prior.rsi == null || first.rsi == null) continue
    const jump = first.rsi - prior.rsi
    if (prior.rsi >= minPreviousRsi && first.rsi >= minFirstRsi && jump >= minJump) {
      hits.push({ symbol, date, prior_time: prior.stamp, first_time: first.stamp, prior_rsi: round(prior.rsi), first_rsi: round(first.rsi), rsi_jump: round(jump), prior_close: prior.close, first_open: first.open, first_close: first.close, close_change_pct: round(100 * (first.close / prior.close - 1)) })
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
const stem = `${fromDate}-to-${toDate}-rsi-cross-session-jumps`
let output = path.join(root, 'reports', `${stem}.csv`), n = 2
while (fs.existsSync(output)) output = path.join(root, 'reports', `${stem}-${n++}.csv`)
const columns = ['symbol', 'date', 'prior_time', 'first_time', 'prior_rsi', 'first_rsi', 'rsi_jump', 'prior_close', 'first_open', 'first_close', 'close_change_pct']
fs.writeFileSync(output, [columns.join(','), ...hits.map(row => columns.map(c => row[c] ?? '').join(','))].join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ fromDate, toDate, rsiPeriod: 14, minPreviousRsi, minFirstRsi, minJump, universe: symbols.length, hitCount: hits.length, hits, output }, null, 2))
