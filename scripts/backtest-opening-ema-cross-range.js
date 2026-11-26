import { execFileSync } from 'node:child_process'
const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1] }
const from = arg('--from') || arg('--date')
const to = arg('--to') || from
if (!from) throw new Error('Usage: node scripts/backtest-opening-ema-cross-range.js --from YYYY-MM-DD --to YYYY-MM-DD [--time HH:MM] [--sl 0.8] [--min-return 2]')
const t = arg('--time') || '09:17', sl = arg('--sl') || '0.8', min = arg('--min-return') || '2', side = arg('--side') || 'BOTH'
for (let d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
  const date = d.toISOString().slice(0, 10)
  try {
    execFileSync(process.execPath, ['scripts/scan-two-session-0917-absorption.js', date], { stdio: 'ignore' })
    execFileSync(process.execPath, ['scripts/filter-0917-ema-cross-returns.js', '--date', date, '--time', t, '--sl', sl, '--min-return', min, '--side', side], { stdio: 'inherit' })
  } catch { /* weekends/holidays or missing data */ }
}
