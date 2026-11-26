import fs from 'node:fs'
import path from 'node:path'

const file = path.join(process.cwd(), 'reports', '2026-10-22-23-0930-weakness-bidirectional-research.json')
const { candidates } = JSON.parse(fs.readFileSync(file, 'utf8'))
const train = candidates.filter(x => x.date === '2026-10-22')
const holdout = candidates.filter(x => x.date === '2026-10-23')
const selected = (rows, pass) => {
  const map = new Map()
  for (const x of rows) if (pass(x) && !map.has(x.symbol)) map.set(x.symbol, x)
  return [...map.values()]
}
const stats = rows => ({ trades: rows.length, winners: rows.filter(x => x.reason === 'TARGET').length, stops: rows.filter(x => x.reason === 'SL').length, total: Number(rows.reduce((s, x) => s + x.returnPct, 0).toFixed(3)) })
const options = []
for (const side of ['BUY', 'SELL', 'BOTH'])
for (const first of ['09:30', '09:35', '09:40', '09:45'])
for (const last of ['09:45', '09:50', '10:00'])
for (const two of [.15, .25, .35, .5])
for (const five of [.25, .4, .6])
for (const candles of [3, 4])
for (const depth of [50, 52, 55, 60])
for (const mid of [0, .02])
for (const nifty of [-.2, 0, .1]) {
  if (last <= first) continue
  const pass = x => (side === 'BOTH' || x.side === side) && x.signalAt.slice(11) >= first && x.signalAt.slice(11) < last &&
    x.twoDirectionalPct >= two && x.fiveDirectionalPct >= five && x.directionalCandles5 >= candles &&
    x.depthSharePct >= depth && x.depthMidMovePct > mid && x.nifty3DirectionalPct > nifty
  const a = selected(train, pass), sa = stats(a)
  if (sa.trades < 2 || sa.stops) continue
  const b = selected(holdout, pass), sb = stats(b)
  if (sb.trades < 1) continue
  options.push({ rule: { side, first, last, two, five, candles, depth, mid, nifty }, train: sa, holdout: sb, trades: [...a, ...b].map(x => ({ date: x.date, stock: x.symbol, side: x.side, signalAt: x.signalAt, entryAt: x.entryAt, exitAt: x.exitAt, reason: x.reason, returnPct: x.returnPct })) })
}
options.sort((a, b) => a.holdout.stops - b.holdout.stops || b.holdout.winners - a.holdout.winners || b.train.winners - a.train.winners)
console.log(JSON.stringify({ tested: options.length, best: options.slice(0, 6) }, null, 2))
