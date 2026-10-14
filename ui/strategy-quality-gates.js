export const QUALITY_LIMITS = Object.freeze({
  multiFrameBuy: Object.freeze({ controlledRecoveryMaxRsi14: 70 }),
  multiFrameSell: Object.freeze({ weakRecoveryMinRsi14: 27 }),
  failedBid: Object.freeze({
    minPriceDropPct: -0.15,
    maxCandleVolumeRatio: 10,
    maxConfirmationBidSharePct: 80,
  }),
  revisedAbsorption: Object.freeze({
    openingBroadMinBreadthPositivePct: 78,
    openingBroadMaxBreadthAbove05Pct: 12,
    openingHiddenMaxBidDominantPct: 22,
    openingHiddenMinOfi: 0.21,
    smoothMinConfirmationVolumeRatio10: 2,
    balancedMaxConfirmationCandleReturnPct: 0.30,
    balancedMaxVwapGapPct: 0.70,
  }),
})

const finite = (value) => Number.isFinite(Number(value))
const number = (value) => Number(value)

export function passesMultiFrameBuyQuality(branch, metrics) {
  if (branch !== "controlled_recovery") return true
  return finite(metrics?.rsi14) &&
    number(metrics.rsi14) <= QUALITY_LIMITS.multiFrameBuy.controlledRecoveryMaxRsi14
}

export function passesMultiFrameSellQuality(branch, metrics) {
  if (branch !== "weak_recovery_falling_bid") return true
  return finite(metrics?.rsi14) &&
    number(metrics.rsi14) >= QUALITY_LIMITS.multiFrameSell.weakRecoveryMinRsi14
}

export function passesFailedBidQuality(metrics) {
  return finite(metrics?.priceDropPct) && finite(metrics?.volumeRatio) &&
    finite(metrics?.confirmationBidSharePct) &&
    number(metrics.priceDropPct) >= QUALITY_LIMITS.failedBid.minPriceDropPct &&
    number(metrics.volumeRatio) <= QUALITY_LIMITS.failedBid.maxCandleVolumeRatio &&
    number(metrics.confirmationBidSharePct) <= QUALITY_LIMITS.failedBid.maxConfirmationBidSharePct
}

export function passesRevisedAbsorptionQuality(pattern, metrics) {
  const limits = QUALITY_LIMITS.revisedAbsorption
  if (pattern === "Opening broad participation") {
    return finite(metrics?.breadthPositivePct) && finite(metrics?.breadthAbove05Pct) &&
      number(metrics.breadthPositivePct) >= limits.openingBroadMinBreadthPositivePct &&
      number(metrics.breadthAbove05Pct) <= limits.openingBroadMaxBreadthAbove05Pct
  }
  if (pattern === "Opening hidden buy flow") {
    return finite(metrics?.bidDominantPct) && finite(metrics?.ofi) &&
      number(metrics.bidDominantPct) <= limits.openingHiddenMaxBidDominantPct &&
      number(metrics.ofi) >= limits.openingHiddenMinOfi
  }
  if (pattern === "Smooth depth confirmation") {
    return finite(metrics?.confirmationVolumeRatio10) &&
      number(metrics.confirmationVolumeRatio10) >= limits.smoothMinConfirmationVolumeRatio10
  }
  if (pattern === "Balanced flow continuation") {
    return finite(metrics?.confirmationCandleReturnPct) && finite(metrics?.vwapGapPct) &&
      number(metrics.confirmationCandleReturnPct) <= limits.balancedMaxConfirmationCandleReturnPct &&
      number(metrics.vwapGapPct) <= limits.balancedMaxVwapGapPct
  }
  return true
}
