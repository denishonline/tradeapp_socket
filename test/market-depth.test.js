import assert from "node:assert/strict"
import { it } from "node:test"
import { depthUpdateFields, marketDepthSession } from "../ui/market-depth.js"

it("uses the weekday India session from 09:15 inclusive to 15:15 exclusive", () => {
  assert.equal(marketDepthSession(new Date("2026-10-05T03:44:59.999Z")).open, false)
  assert.equal(marketDepthSession(new Date("2026-10-05T03:45:00.000Z")).open, true)
  assert.equal(marketDepthSession(new Date("2026-10-05T09:44:59.999Z")).open, true)
  assert.equal(marketDepthSession(new Date("2026-10-05T09:45:00.000Z")).open, false)
  assert.equal(marketDepthSession(new Date("2026-10-03T04:30:00.000Z")).open, false)
})

it("accepts valid partial depth fields and rejects malformed book values", () => {
  assert.deepEqual(
    [...depthUpdateFields({ type: "dp", symbol: "NSE:SBIN-EQ", bid_size1: "25" })],
    [["bid_size1", 25]],
  )
  assert.equal(depthUpdateFields({ type: "dp", symbol: "NSE:SBIN-EQ" }), null)
  assert.equal(depthUpdateFields({ type: "dp", symbol: "NSE:SBIN-EQ", ask_price1: "NaN" }), null)
  assert.equal(depthUpdateFields({ type: "dp", symbol: "NSE:SBIN-EQ", bid_size1: 2.5 }), null)
  assert.equal(depthUpdateFields({ type: "dp", symbol: "NSE:SBIN-EQ", bid_price1: -1 }), null)
})
