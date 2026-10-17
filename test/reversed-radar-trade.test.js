import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { reversedTrade, resolveReversedCandle, resolveReversedPrice } from "../ui/reversed-radar-trade.js"

describe("reversed Strategy Radar trade plan", () => {
  it("turns BUY into SELL with a fixed 0.4% target and stop", () => {
    const trade = reversedTrade(100, "BUY")
    assert.equal(trade.direction, "SELL")
    assert.equal(trade.target, 99.6)
    assert.equal(trade.stop, 100.4)
    assert.equal(resolveReversedPrice(trade, 99.6), "Target reached")
    assert.equal(resolveReversedPrice(trade, 100.4), "Stopped")
  })

  it("turns SELL into BUY with a fixed 0.4% target and stop", () => {
    const trade = reversedTrade(100, "SELL")
    assert.equal(trade.direction, "BUY")
    assert.equal(trade.target, 100.4)
    assert.equal(trade.stop, 99.6)
    assert.equal(resolveReversedPrice(trade, 100.4), "Target reached")
    assert.equal(resolveReversedPrice(trade, 99.6), "Stopped")
  })

  it("uses the stop when both boundaries occur in one candle", () => {
    const sell = reversedTrade(100, "BUY")
    assert.equal(resolveReversedCandle(sell, { high: 100.5, low: 99.5 }), "Stopped")
  })
})
