import test from 'node:test'
import assert from 'node:assert/strict'
import { positionStartedAt, sellPositionExitStatus } from '../ui/position-exit.js'

test('derives a live short position start from filled orders', () => {
  const position = { symbol: 'NSE:RVNL-EQ', productType: 'INTRADAY', quantity: -10 }
  const startedAt = positionStartedAt(position, [
    { symbol: 'NSE:RVNL-EQ', productType: 'INTRADAY', side: -1, filledQty: 10, orderDateTime: '23-Nov-2026 09:21:00' },
  ])
  assert.equal(new Date(startedAt).toISOString(), '2026-11-23T03:51:00.000Z')
})

test('marks the sell stop before any EMA exit', () => {
  const startedAt = Date.parse('2026-11-23T03:51:00.000Z')
  const status = sellPositionExitStatus({
    position: { averagePrice: 100, lastPrice: 100.7 },
    candles: [],
    startedAt,
    now: startedAt + 60_000,
  })
  assert.equal(status.state, 'SL_TRIGGERED')
  assert.ok(Math.abs(status.stop - 100.7) < 1e-9)
})

test('does not arm the EMA exit until the short first reaches two percent profit', () => {
  const startedAt = Date.parse('2026-11-23T03:51:00.000Z')
  const candles = Array.from({ length: 55 }, (_, index) => ({
    time: Math.floor((Date.parse('2026-11-23T03:45:00.000Z') + index * 60_000) / 1000),
    open: 100, high: 100.2, low: 99.5, close: 100,
  }))
  const status = sellPositionExitStatus({
    position: { averagePrice: 100, lastPrice: 99.9 }, candles, startedAt,
    now: Date.parse('2026-11-23T05:00:00.000Z'),
  })
  assert.equal(status.state, 'ACTIVE')
  assert.match(status.label, /waiting for \+2%/)
})
