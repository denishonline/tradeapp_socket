import assert from "node:assert/strict"
import { it } from "node:test"
import { createDepthTrend, baselineMetrics, bookMetrics, continuousDepthMetrics } from "../ui/trading/depth-trend.js"

export function depth(price = 100, buy = 100, sell = 100, symbol = "NSE:SBIN-EQ") {
  const data = { type: "dp", symbol }
  for (let n = 1; n <= 5; n++) {
    data[`bid_price${n}`] = price - n * 0.01
    data[`ask_price${n}`] = price + n * 0.01
    data[`bid_size${n}`] = buy
    data[`ask_size${n}`] = sell
  }
  return data
}

it("validates complete depth and rejects crossed, malformed or incomplete books", () => {
  assert.equal(bookMetrics({ bid_price1: 100 }), null)
  assert.ok(bookMetrics(depth()))
  assert.equal(bookMetrics({ ...depth(), bid_price1: 101 }), null)
  assert.equal(bookMetrics({ ...depth(), bid_size2: -1 }), null)
})

it("distinguishes directional price movement from choppiness", () => {
  const trend = Array.from({ length: 100 }, (_, n) => ({ open: 100 + n, high: 101 + n, low: 100 + n, close: 101 + n, volume: 100, depthCount: 1, imbalanceSum: 0 }))
  const chop = trend.map((b, n) => ({ ...b, open: 100, high: 101, low: 99, close: n % 2 ? 99 : 101 }))
  assert.ok(baselineMetrics(trend).choppiness < 10)
  assert.ok(baselineMetrics(chop).choppiness > 80)
})

function simulation(overrides = {}) {
  const signals = []
  let active = false
  const engine = createDepthTrend({ config: { baselineMinutes: 100, ...overrides }, onSignal: (s) => signals.push(s), hasExposure: () => active })
  const start = Date.parse("2026-10-05T03:45:00Z")
  let volume = 1000
  function tick(second, strong = false) {
    const now = start + second * 1000
    const price = 100 + second * (strong ? 0 : 0.0001) + (strong ? 0.606 + (second - 6060) * 0.003 : 0)
    volume += strong ? 3 : 1
    engine.observe("price", { symbol: "NSE:SBIN-EQ", type: "sf", ltp: price, vol_traded_today: volume, exch_feed_time: now / 1000 }, now)
    engine.observe("depth", depth(price, strong ? 400 : 100), now)
  }
  return { engine, signals, tick, start, activate: () => { active = true } }
}

it("requires 100 complete minutes, persistent smooth depth shift, and avoids duplicate entries", () => {
  const s = simulation()
  for (let sec = 0; sec < 6060; sec++) s.tick(sec)
  assert.equal(s.signals.length, 0)
  assert.equal(s.engine.status()["NSE:SBIN-EQ"].completedMinutes, 99)
  for (let sec = 6060; sec < 6130; sec++) s.tick(sec, true)
  assert.equal(s.signals.filter((x) => x.action === "ENTRY").length, 1)
  assert.ok(s.signals[0].metrics.imbalanceShift > 0.15)
  s.engine.reset()
  s.tick(6131, true)
  assert.equal(s.engine.status()["NSE:SBIN-EQ"].completedMinutes, 0)
})

it("rejects transient depth spikes and stale source prices", () => {
  const s = simulation()
  for (let sec = 0; sec <= 6060; sec++) s.tick(sec)
  for (let sec = 6061; sec < 6064; sec++) s.tick(sec, true)
  for (let sec = 6064; sec < 6100; sec++) s.tick(sec)
  assert.equal(s.signals.length, 0)
  s.engine.observe("price", { symbol: "NSE:OLD-EQ", ltp: 10, vol_traded_today: 10, exch_feed_time: 1 }, s.start)
  assert.equal(s.engine.status()["NSE:OLD-EQ"].completedMinutes, 0)
})

it("measures bid/ask steps and separates disappearing asks from corroborating trades", () => {
  const snapshots = Array.from({ length: 5 }, (_, n) => ({
    second: n, price: 100 + n * 0.1, bid: 99.95 + n * 0.1, ask: 100.05 + n * 0.1,
    nearBidQty: 200 + n * 10, volume: 1000,
    asks: [{ price: 100.05 + n * 0.1, qty: 100 }],
  }))
  const disappearing = continuousDepthMetrics(snapshots, 100)
  assert.equal(disappearing.bidUpMoves, 4)
  assert.equal(disappearing.askUpMoves, 4)
  assert.equal(disappearing.askReductionEvents, 4)
  assert.equal(disappearing.tradeCorroboratedAskReductions, 0)
  assert.ok(disappearing.nearBidStrength > 2)
  assert.equal(disappearing.upTickRatio, 1)
  snapshots.forEach((x, n) => { x.volume += n * n })
  const traded = continuousDepthMetrics(snapshots, 100)
  assert.equal(traded.tradeCorroboratedAskReductions, 4)
  assert.ok(traded.volumeAcceleration > 1)
})

it("does not treat deep asks sliding out of the visible book as consumption", () => {
  const sample = { second: 0, price: 100, bid: 99, ask: 101, volume: 100, nearBidQty: 100, asks: [{ price: 101, qty: 100 }, { price: 105, qty: 100 }] }
  const next = { ...sample, second: 1, asks: [{ price: 101, qty: 100 }, { price: 102, qty: 100 }] }
  assert.equal(continuousDepthMetrics([sample, next], 100).askReductionEvents, 0)
})
