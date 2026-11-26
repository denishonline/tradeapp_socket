import fs from 'node:fs'
import readline from 'node:readline'

const date = process.argv[2] || '2026-11-20'
const excluded = new Set(['INDUSINDBK', 'APOLLOHOSP', 'UNIONBANK', 'AXISBANK', 'PERSISTENT', 'BAJFINANCE', 'INDHOTEL'])
const universeFile = 'db/stocks_sector_wise'
const universe = JSON.parse(fs.readFileSync(universeFile, 'utf8'))
const symbols = [...new Set(Object.entries(universe).filter(([k]) => k !== '_meta').flatMap(([, v]) => v).map((x) => String(typeof x === 'string' ? x : (x.symbol || x.name || x.ticker || '')).replace(/^NSE:/i, '').replace(/-EQ$/i, '')).filter(Boolean))]
const stamp = (time) => new Date(Number(time) * 1000 + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const scan = async (symbol) => {
  const file = `db/candles/${symbol}.jsonl`
  if (!fs.existsSync(file)) return null
  const rows = []
  const input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of input) { try { if (!line.trim()) continue; const x = JSON.parse(line), local = stamp(x.time); if (local >= `${date} 09:15` && local < `${date} 09:30`) rows.push({ ...x, local }) } catch {} }
  for (let i = 0; i < rows.length - 1; i++) {
    const ob = rows[i]
    if (!(ob.close < ob.open)) continue
    for (let j = i + 2; j < rows.length; j++) {
      const candle = rows[j], prior = rows.slice(i + 1, j), level = Math.max(...prior.map((x) => x.high)), range = candle.high - candle.low || 1
      if (candle.close > candle.open && candle.close > level && (candle.close - candle.open) / range >= 0.35) return { Symbol: symbol, 'OB origin': ob.local.slice(11), 'BOS candle': candle.local.slice(11), 'Confirmed at': stamp(Number(candle.time) + 60).slice(11), 'BOS level': +level.toFixed(2), Close: +candle.close.toFixed(2) }
    }
  }
  return null
}
const rows = []
for (const symbol of symbols) { const result = await scan(symbol); if (result && !excluded.has(result.Symbol)) rows.push(result) }
rows.sort((a, b) => a['BOS candle'].localeCompare(b['BOS candle']) || a.Symbol.localeCompare(b.Symbol))
console.log(JSON.stringify({ date, universe: symbols.length, excluded: [...excluded], signalCount: rows.length, rows }, null, 2))
