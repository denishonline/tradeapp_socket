import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const date = '2026-10-28'
const depthReport = JSON.parse(fs.readFileSync(path.join(root, 'reports', '2026-10-28-depth-rules-retain-at-least5-targets-2.json'), 'utf8'))
const overlapReport = JSON.parse(fs.readFileSync(path.join(root, 'reports', '2026-10-28-all-stocks-11-of-12-next15-to-ema-downcross-overlap.json'), 'utf8'))
const selected = depthReport.bestAtLeastFiveTargetRule.selected
const selectedKeys = new Set(selected.map(x => `${x.symbol}|${x.originTime}|${x.signalTime}`))
const candidates = overlapReport.trades
  .filter(x => selectedKeys.has(`${x.symbol}|${x.originTime}|${x.signalTime}`))
  .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.signalTime.localeCompare(b.signalTime))

// Consecutive qualifying confirmations in the same stock are one signal cluster.
// Keep the earliest actionable confirmation and suppress later duplicates until exit.
const signals = []
for (const row of candidates) {
  const prior = signals.find(x => x.symbol === row.symbol && row.entryTime <= x.exitTime)
  if (!prior) signals.push(row)
}

const returns = signals.map(x => x.returnPct)
const round = x => Number.isFinite(x) ? +x.toFixed(3) : null
const total = returns.reduce((a, b) => a + b, 0)
const output = {
  date,
  warning: 'This rule was optimized on the same 28 October targets and is in-sample overfit. Validate unchanged on other sessions before any live use.',
  baseRule: 'At least 11 of 12 candle/indicator confirmation rules pass.',
  depthRules: depthReport.bestAtLeastFiveTargetRule.rules,
  deduplication: 'For the same stock, keep the earliest qualifying signal and suppress subsequent qualifying windows until that trade exits.',
  rawQualifyingWindows: candidates.length,
  distinctSignals: signals.length,
  summary: {
    tradeCount: signals.length,
    winRatePct: round(100 * signals.filter(x => x.returnPct > 0).length / (signals.length || 1)),
    averageReturnPct: round(total / (signals.length || 1)),
    totalReturnPct: round(total),
    maximumAdverseExcursionPct: round(Math.min(...signals.map(x => x.maximumAdverseExcursionPct))),
    worstDay: { date, summedReturnPct: round(total) },
  },
  signals,
}

let n = 1, file
do {
  file = path.join(root, 'reports', `${date}-11-of-12-plus-depth-five-signals${n === 1 ? '' : `-${n}`}.json`)
  n++
} while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({
  file,
  rawQualifyingWindows: output.rawQualifyingWindows,
  summary: output.summary,
  signals: signals.map(x => ({ symbol: x.symbol, signalTime: x.signalTime, entryTime: x.entryTime, exitTime: x.exitTime, returnPct: x.returnPct })),
}, null, 2))
