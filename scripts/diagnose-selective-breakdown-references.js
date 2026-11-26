import { barsBySymbol, outcome } from "./research-selective-breakdown-candidates.js"

const targets = [
  ["ICICIPRULI", "11:32"], ["HINDPETRO", "11:30"], ["SRF", "11:06"],
  ["KEI", "10:10"], ["IIFL", "09:43"]
]
const pct = (a, b) => 100 * (a / b - 1)
const round = n => Number(n.toFixed(3))
const rangePct = xs => pct(Math.max(...xs), Math.min(...xs))
const result = []
for (const [symbol, clock] of targets) {
  const rows = barsBySymbol.get(symbol)
  const index = rows.findIndex(row => row.time.endsWith(` ${clock}`))
  if (index < 10 || index + 1 >= rows.length) { result.push({ symbol, clock, missing: true }); continue }
  const row = rows[index], prev = rows[index - 1], pre = rows.slice(index - 10, index)
  const stack = x => x.close < x.ema9 && x.ema9 < x.ema45 && x.ema45 < x.vwap
  const prior5 = pre.slice(-5), volBase = prior5.reduce((sum, x) => sum + x.volume, 0) / 5
  const exit = outcome(rows, index + 1)
  result.push({ symbol, time: row.time, previousStack: stack(prev), currentStack: stack(row),
    bearish: row.close < row.open && row.close < prev.close,
    pre10RangesPct: { ema9: round(rangePct(pre.map(x => x.ema9))),
      ema45: round(rangePct(pre.map(x => x.ema45))), vwap: round(rangePct(pre.map(x => x.vwap))) },
    downwardCount: ["ema9", "ema45", "vwap"].filter(key => pre.at(-1)[key] < pre[0][key]).length,
    signalBodyPct: round(-pct(row.close, row.open)),
    volumeMultiple: round(row.volume / volBase),
    fiveMinuteMovePct: round(pct(row.close, prior5[0].close)),
    sessionMovePct: round(pct(row.close, rows[0].open)),
    belowVwapPct: round(-pct(row.close, row.vwap)),
    laterOutcome: { entryTime: rows[index + 1].time, exitReason: exit.reason, exitTime: exit.exitTime,
      returnPct: round(exit.returnPct) } })
}
console.log(JSON.stringify(result, null, 2))
