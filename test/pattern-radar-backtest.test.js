import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { backtestPatternRadar } from '../scripts/backtest-pattern-radar.js'

it('replays a date in minute order, accounts for resolved trades, and never overwrites reports', async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'pattern-radar-replay-'))
  try {
    await mkdir(path.join(rootDirectory, 'db', 'candles'), { recursive: true })
    await mkdir(path.join(rootDirectory, 'reports'))
    const rules = Array.from({ length: 27 }, (_, i) => ({ id: `P${String(i + 1).padStart(2, '0')}`,
      delay: 0, conditions: [{ feature: i ? 'missingFeature' : 'ret1', op: '>', value: -1000 }] }))
    await writeFile(path.join(rootDirectory, 'db', 'stocks'), JSON.stringify(['SBIN']))
    await writeFile(path.join(rootDirectory, 'db', 'sector_indices'), '[]')
    await writeFile(path.join(rootDirectory, 'db', 'stocks_sector_wise'), '{}')
    await writeFile(path.join(rootDirectory, 'reports', '2026-10-05-to-2026-10-16-ema-coverage-audit-sector-pure60-results.json'),
      JSON.stringify({ retrospective: { rules } }))
    const open = Date.parse('2026-10-05T09:15:00+05:30') / 1000
    const prices = Array.from({ length: 26 }, (_, i) => i < 20 ? 100 + i * .1 : i < 23 ? 80 - (i - 20) : 115)
    const candles = prices.map((price, i) => JSON.stringify({ time: open + i * 60, open: price,
      high: price, low: price, close: price, volume: 100, source: 'test' })).join('\n') + '\n'
    await writeFile(path.join(rootDirectory, 'db', 'candles', 'SBIN.jsonl'), candles)
    const first = await backtestPatternRadar('2026-10-05', { rootDirectory })
    assert.equal(first.summary.trades, 1)
    assert.equal(first.summary.wins, 0)
    assert.equal(first.summary.losses, 1)
    assert.equal(first.signals[0].pattern, 'P01')
    assert.equal(first.signals[0].direction, 'SELL')
    assert.equal(first.signals[0].entryPrice, 79)
    assert.equal(first.signals[0].exitReason, 'OPPOSITE_CROSS')
    assert.ok(first.summary.maximumAdverseExcursionPct < 0)
    const second = await backtestPatternRadar('2026-10-05', { rootDirectory })
    assert.notEqual(first.files.jsonFile, second.files.jsonFile)
    assert.equal(JSON.parse(await readFile(first.files.jsonFile, 'utf8')).summary.trades, 1)
  } finally {
    await rm(rootDirectory, { recursive: true, force: true })
  }
})

it('rejects an invalid session date before reading files', async () => {
  await assert.rejects(backtestPatternRadar('2026-10-18', { save: false }), /not a weekday/)
})
