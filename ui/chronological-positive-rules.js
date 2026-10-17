export const CHRONOLOGICAL_POSITIVE_CONFIG = Object.freeze({
  initialStopPct: 0.7,
  targetPct: 1,
  breakevenTriggerPct: 0.5,
  trailDistancePct: 0.4,
  maxHoldMinutes: 120,
})

export function chronologicalPositiveBranch(features) {
  const f = features || {}
  const signalMinute = Number(f.timeMinute) + 1

  const leaderPullback = signalMinute >= 9 * 60 + 22 && signalMinute <= 9 * 60 + 37 &&
    f.openingReturn >= 1.5 && f.return5 >= 0 && f.return5 <= 0.4 &&
    f.bodyEfficiency >= 100 && f.bidShare >= 58 && f.vwapGap >= 0.4 &&
    ((f.openingReturn >= 3 && f.closeLocation <= 60) ||
      (f.return3 <= -0.2 && f.closeLocation <= 20))

  const openingImpulse = signalMinute >= 9 * 60 + 22 && signalMinute <= 9 * 60 + 37 &&
    f.openingReturn <= 2 && f.return5 >= 1.5 && f.closeLocation >= 90 &&
    f.bodyEfficiency >= 85 && f.askLift >= 50 && f.bidShare >= 52

  const earlyReversalBase = signalMinute >= 9 * 60 + 22 && signalMinute <= 9 * 60 + 32 &&
    f.openingReturn <= 0 && f.return3 >= 0.35 && f.closeLocation >= 88 &&
    f.depthMidReturn >= 0.2
  const earlyReversalQuality = f.bodyEfficiency >= 180 ||
    (f.volumeRatio >= 3 && f.askLift >= 80) ||
    (f.bidShare >= 60 && f.top2BidShare >= 55 && f.askLift >= 65)

  const momentumBase = signalMinute >= 9 * 60 + 45 && signalMinute <= 10 * 60 + 8 &&
    f.return5 >= 0.24 && f.closeLocation >= 88 && f.bodyEfficiency >= 110 &&
    f.depthMidReturn >= 0.24 && f.green5 >= 3 && f.askLift >= 50 &&
    f.bidShare >= 50 && f.vwapGap >= 0
  const momentumTrigger = f.return1 >= 0.5 || f.volumeRatio >= 3 ||
    (f.normalizedOfi >= 0.075 && f.vwapGap >= 0.3)

  if (leaderPullback) return "LEADER_PULLBACK"
  if (openingImpulse) return "OPENING_IMPULSE"
  if (earlyReversalBase && earlyReversalQuality) return "EARLY_REVERSAL"
  if (momentumBase && momentumTrigger) return "CONFIRMED_MOMENTUM"
  return null
}
