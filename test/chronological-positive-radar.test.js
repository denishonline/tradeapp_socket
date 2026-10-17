import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createChronologicalPositiveRadar } from "../ui/chronological-positive-radar.js"

const MINUTE = 60_000
const INDIA_OFFSET = 330 * MINUTE

function epoch(hour, minute, second = 0) {
  return Date.UTC(2026, 9, 16, hour, minute, second) - INDIA_OFFSET
}

function candle(hour, minute, open, high, low, close, volume = 1_000) {
  return { time: epoch(hour, minute) / 1000, open, high, low, close, volume }
}

function depth(symbol, bid, ask) {
  const result = { symbol: `NSE:${symbol}-EQ`, type: "dp" }
  for (let level = 1; level <= 5; level++) {
    result[`bid_price${level}`] = bid - (level - 1) * 0.05
    result[`ask_price${level}`] = ask + (level - 1) * 0.05
    result[`bid_size${level}`] = 200
    result[`ask_size${level}`] = 100
  }
  return result
}

describe("chronological positive live radar", () => {
  it("emits an opening impulse only after its final candle and depth minute complete", async () => {
    const symbol = "TEST"
    const seeded = [
      candle(9, 15, 100, 100.1, 99.9, 100),
      candle(9, 16, 100, 100.1, 99.7, 99.8),
      candle(9, 17, 99.8, 99.9, 99.4, 99.5),
      candle(9, 18, 99.5, 99.6, 99.1, 99.2),
      candle(9, 19, 99.2, 99.3, 98.8, 98.9),
      candle(9, 20, 98.9, 99, 98.5, 98.6),
      candle(9, 21, 98.6, 98.7, 98.2, 98.3),
      candle(9, 22, 98.3, 98.4, 97.9, 98),
    ]
    const published = []
    const radar = createChronologicalPositiveRadar({
      now: () => epoch(9, 23),
      onUpdate: (signals) => published.push(signals),
    })
    await radar.seed([symbol], { read: async () => seeded })

    const five = [
      candle(9, 23, 98, 98.25, 97.95, 98.2),
      candle(9, 24, 98.2, 98.55, 98.15, 98.5),
      candle(9, 25, 98.5, 99.05, 98.45, 99),
      candle(9, 26, 99, 99.55, 98.95, 99.5),
      candle(9, 27, 99.5, 100.15, 99.45, 100.1),
    ]
    let cumulativeVolume = 10_000
    let bestBid = 97.9
    let bestAsk = 98
    for (const row of five) {
      const minuteAt = row.time * 1000
      radar.observeDepth(depth(symbol, bestBid, bestAsk), new Date(minuteAt + 10_000), {
        priceAt: new Date(minuteAt + 10_000).toISOString(),
        cumulativeVolume,
      })
      cumulativeVolume += 1_000
      bestBid += 0.1
      bestAsk += 0.1
      radar.observeDepth(depth(symbol, bestBid, bestAsk), new Date(minuteAt + 50_000), {
        priceAt: new Date(minuteAt + 50_000).toISOString(),
        cumulativeVolume,
      })
      radar.observeCandle(symbol, row)
      if (row.time < five.at(-1).time) assert.equal(radar.snapshot().length, 0)
    }

    const [signal] = radar.snapshot()
    assert.equal(published.length, 1)
    assert.equal(signal.symbol, symbol)
    assert.equal(signal.branch, "OPENING_IMPULSE")
    assert.equal(signal.status, "Active")
    assert.equal(signal.time, new Date(epoch(9, 28)).toISOString())
    assert.equal(signal.price, signal.entry)
    assert.equal(signal.stop, signal.entry * 0.993)
    assert.equal(signal.target, signal.entry * 1.01)
  })
})
