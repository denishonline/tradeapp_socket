import assert from "node:assert/strict"
import { it } from "node:test"
import { depthConfirmation, volumeProfile } from "../ui/trading/fabio-scalper.js"

it("finds a local low-volume node from OHLCV-distributed volume", () => {
  const profile = volumeProfile([
    { low: 100, high: 100, volume: 100 }, { low: 101, high: 101, volume: 5 }, { low: 102, high: 102, volume: 100 },
  ], 1)
  assert.ok(profile.lvnZones.some((zone) => zone.low === 101))
})

it("requires persistent directional depth as a confirmation, not a primary signal", () => {
  const positive = Array.from({ length: 4 }, (_, index) => ({ obi: 0.25, weightedObi: 0.3, mid: 100 + index * 0.01 }))
  assert.equal(depthConfirmation(positive, 1).confirmed, true)
  assert.equal(depthConfirmation(positive.map((x, index) => ({ ...x, obi: index ? 0.25 : -0.5 })), 1).confirmed, false)
  assert.equal(depthConfirmation(positive.map((x, index) => ({ ...x, mid: 100 - index * 0.01 })), 1).confirmed, false)
})
