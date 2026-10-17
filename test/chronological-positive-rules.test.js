import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  CHRONOLOGICAL_POSITIVE_CONFIG,
  chronologicalPositiveBranch,
} from "../ui/chronological-positive-rules.js"

function metrics(overrides = {}) {
  return {
    timeMinute: 9 * 60 + 22,
    openingReturn: 0,
    return1: 0,
    return3: 0,
    return5: 0,
    green5: 0,
    closeLocation: 0,
    bodyEfficiency: 0,
    vwapGap: 0,
    volumeRatio: 0,
    askLift: 0,
    bidShare: 0,
    top2BidShare: 0,
    depthMidReturn: 0,
    normalizedOfi: 0,
    ...overrides,
  }
}

describe("chronological positive filter", () => {
  it("uses the frozen trailing-risk configuration", () => {
    assert.deepEqual(CHRONOLOGICAL_POSITIVE_CONFIG, {
      initialStopPct: 0.7,
      targetPct: 1,
      breakevenTriggerPct: 0.5,
      trailDistancePct: 0.4,
      maxHoldMinutes: 120,
    })
  })

  it("recognizes a leader pullback", () => {
    assert.equal(chronologicalPositiveBranch(metrics({
      timeMinute: 9 * 60 + 36,
      openingReturn: 1.57,
      return3: -0.25,
      return5: 0.09,
      closeLocation: 16,
      bodyEfficiency: 110,
      bidShare: 59,
      vwapGap: 0.4,
    })), "LEADER_PULLBACK")
  })

  it("recognizes an opening impulse", () => {
    assert.equal(chronologicalPositiveBranch(metrics({
      timeMinute: 9 * 60 + 27,
      openingReturn: 1.09,
      return5: 2.21,
      closeLocation: 94.7,
      bodyEfficiency: 88.6,
      askLift: 54.3,
      bidShare: 55.4,
    })), "OPENING_IMPULSE")
  })

  it("recognizes an early reversal", () => {
    assert.equal(chronologicalPositiveBranch(metrics({
      timeMinute: 9 * 60 + 22,
      openingReturn: -0.01,
      return3: 0.51,
      closeLocation: 98.9,
      bodyEfficiency: 95.2,
      volumeRatio: 3.81,
      askLift: 83.4,
      depthMidReturn: 0.56,
    })), "EARLY_REVERSAL")
  })

  it("recognizes confirmed momentum", () => {
    assert.equal(chronologicalPositiveBranch(metrics({
      timeMinute: 9 * 60 + 59,
      return1: 0.64,
      return5: 0.65,
      green5: 4,
      closeLocation: 100,
      bodyEfficiency: 134,
      vwapGap: 0.51,
      askLift: 82.6,
      bidShare: 66.9,
      depthMidReturn: 0.62,
    })), "CONFIRMED_MOMENTUM")
  })

  it("rejects a high-volume setup without the required price structure", () => {
    assert.equal(chronologicalPositiveBranch(metrics({
      timeMinute: 9 * 60 + 59,
      return5: 0.1,
      green5: 3,
      closeLocation: 100,
      bodyEfficiency: 150,
      volumeRatio: 5,
      askLift: 80,
      bidShare: 65,
      depthMidReturn: 0.1,
    })), null)
  })
})
