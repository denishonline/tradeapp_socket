// Research-only expansion of the frozen Chronological Positive Filter.
// This is intentionally not wired into the live Strategy Radar.
export function relaxedChronologicalPositiveBranch(features) {
  const f = features || {}
  const signalMinute = Number(f.timeMinute) + 1

  const leaderPullback = signalMinute >= 9 * 60 + 22 && signalMinute <= 9 * 60 + 37 &&
    f.openingReturn >= 1.0 && f.return5 >= -0.10 && f.return5 <= 0.60 &&
    f.bodyEfficiency >= 80 && f.bidShare >= 55 && f.vwapGap >= 0.20 &&
    ((f.openingReturn >= 2.5 && f.closeLocation <= 70) ||
      (f.return3 <= -0.10 && f.closeLocation <= 35))

  const openingImpulse = signalMinute >= 9 * 60 + 22 && signalMinute <= 9 * 60 + 37 &&
    f.openingReturn <= 2.5 && f.return5 >= 1.0 && f.closeLocation >= 85 &&
    f.bodyEfficiency >= 75 && f.askLift >= 40 && f.bidShare >= 50

  const earlyReversalBase = signalMinute >= 9 * 60 + 22 && signalMinute <= 9 * 60 + 32 &&
    f.openingReturn <= 0.25 && f.return3 >= 0.25 && f.closeLocation >= 80 &&
    f.depthMidReturn >= 0.15
  const earlyReversalQuality = f.bodyEfficiency >= 140 ||
    (f.volumeRatio >= 2.5 && f.askLift >= 65) ||
    (f.bidShare >= 57 && f.top2BidShare >= 53 && f.askLift >= 55)

  const momentumBase = signalMinute >= 9 * 60 + 45 && signalMinute <= 10 * 60 + 8 &&
    f.return5 >= 0.18 && f.closeLocation >= 82 && f.bodyEfficiency >= 90 &&
    f.depthMidReturn >= 0.18 && f.green5 >= 3 && f.askLift >= 40 &&
    f.bidShare >= 49 && f.vwapGap >= -0.05
  const momentumTrigger = f.return1 >= 0.35 || f.volumeRatio >= 2.5 ||
    (f.normalizedOfi >= 0.05 && f.vwapGap >= 0.20)

  if (leaderPullback) return 'LEADER_PULLBACK_RELAXED'
  if (openingImpulse) return 'OPENING_IMPULSE_RELAXED'
  if (earlyReversalBase && earlyReversalQuality) return 'EARLY_REVERSAL_RELAXED'
  if (momentumBase && momentumTrigger) return 'CONFIRMED_MOMENTUM_RELAXED'
  return null
}
