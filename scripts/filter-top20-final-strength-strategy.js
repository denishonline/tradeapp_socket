import { execFileSync } from 'node:child_process'

// Existing callers retain this entry point; filtering is implemented by the
// top-20 ADX/CMF/3-minute-ATR14 research runner.
const date = process.argv[2] ?? '2026-10-22'
execFileSync(process.execPath, ['scripts/filter-top20-adx-cmf-atr.cjs', date], { stdio: 'inherit' })
