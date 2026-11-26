// Causal, candle-close implementation of the price-structure portion of the
// Fabio-style trend setup.  It emits an underlying-cash candidate only; option
// selection and order placement deliberately remain separate.

export const DEFAULT_FABIO_CONFIG = Object.freeze({
  balanceWindows: [20, 30, 60],
  atrPeriod: 14,
  maxBalanceAtr: 4,
  maxBalanceEfficiency: 0.35,
  breakoutAtr: 0.10,
  minBodyRatio: 0.60,
  minVolumeMultiple: 1.50,
  retestDeadlineMinutes: 15,
  depthSeconds: 15,
  minObi: 0.15,
  minWeightedObi: 0.20,
  minDepthPersistence: 0.70,
  rewardRisk: 2.5,
})

const mean = (xs) => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const directionName = (direction) => direction > 0 ? "BULLISH" : "BEARISH"

export function atr(candles, endIndex, period = 14) {
  if (endIndex < period) return null
  const ranges = []
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const bar = candles[i], prior = candles[i - 1]?.close ?? bar.open
    ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prior), Math.abs(bar.low - prior)))
  }
  return mean(ranges)
}

export function volumeProfile(candles, binWidth) {
  const low = Math.min(...candles.map((bar) => bar.low))
  const high = Math.max(...candles.map((bar) => bar.high))
  const width = Math.max(binWidth, Number.EPSILON)
  const bins = Array.from({ length: Math.max(1, Math.ceil((high - low) / width) + 1) }, (_, index) => ({
    low: low + index * width, high: low + (index + 1) * width, volume: 0,
  }))
  for (const bar of candles) {
    const first = clamp(Math.floor((bar.low - low) / width), 0, bins.length - 1)
    const last = clamp(Math.floor((bar.high - low) / width), 0, bins.length - 1)
    const count = last - first + 1
    for (let index = first; index <= last; index++) bins[index].volume += bar.volume / count
  }
  const poc = bins.reduce((best, bin) => bin.volume > best.volume ? bin : best, bins[0])
  const lvnZones = bins.slice(1, -1).filter((bin, index) => {
    const left = bins[index], right = bins[index + 2]
    return bin.volume < left.volume && bin.volume < right.volume &&
      bin.volume < 0.6 * mean([left.volume, right.volume])
  }).map(({ low: zoneLow, high: zoneHigh }) => ({ low: zoneLow, high: zoneHigh }))
  return { bins, poc: (poc.low + poc.high) / 2, lvnZones }
}

export function detectBalance(candles, endIndex, config = DEFAULT_FABIO_CONFIG) {
  for (const window of config.balanceWindows) {
    const start = endIndex - window + 1
    const bars = candles.slice(start, endIndex + 1)
    const currentAtr = atr(candles, endIndex, config.atrPeriod)
    if (bars.length !== window || !currentAtr) continue
    const high = Math.max(...bars.map((bar) => bar.high)), low = Math.min(...bars.map((bar) => bar.low))
    const travel = bars.slice(1).reduce((sum, bar, index) => sum + Math.abs(bar.close - bars[index].close), 0)
    const efficiency = travel ? Math.abs(bars.at(-1).close - bars[0].close) / travel : 0
    if (high - low > config.maxBalanceAtr * currentAtr || efficiency > config.maxBalanceEfficiency) continue
    const profile = volumeProfile(bars, Math.max(0.1 * currentAtr, 0.01))
    return { startIndex: start, endIndex, window, high, low, atr: currentAtr, efficiency, ...profile }
  }
  return null
}

export function depthConfirmation(samples, direction, config = DEFAULT_FABIO_CONFIG) {
  if (!samples || samples.length < 3) return { confirmed: false, reason: "insufficient depth observations" }
  const sign = direction > 0 ? 1 : -1
  const obi = mean(samples.map((sample) => sample.obi))
  const weightedObi = mean(samples.map((sample) => sample.weightedObi))
  const persistence = samples.filter((sample) => sign * sample.obi > 0.10).length / samples.length
  const first = samples[0], last = samples.at(-1)
  const midAdvanced = sign * (last.mid - first.mid) >= 0
  const confirmed = sign * obi > config.minObi && sign * weightedObi > config.minWeightedObi &&
    persistence >= config.minDepthPersistence && midAdvanced
  return { confirmed, obi, weightedObi, persistence, midAdvanced }
}

function candleConfirms(bar, direction) {
  return direction > 0 ? bar.close > bar.open : bar.close < bar.open
}

function breakout(bar, balance, relativeVolume, config) {
  const range = Math.max(bar.high - bar.low, Number.EPSILON)
  const bodyRatio = Math.abs(bar.close - bar.open) / range
  if (bodyRatio < config.minBodyRatio || relativeVolume < config.minVolumeMultiple) return 0
  if (bar.close > balance.high + config.breakoutAtr * balance.atr && bar.close > bar.open) return 1
  if (bar.close < balance.low - config.breakoutAtr * balance.atr && bar.close < bar.open) return -1
  return 0
}

// `relativeVolumes[index]` must be calculated using only earlier sessions at
// the same minute.  `depthAtEnd` maps candle-end timestamps to observations
// received before that close.
export function findTrendSetups({ candles, relativeVolumes, depthAtEnd = new Map(), config = {} }) {
  const c = { ...DEFAULT_FABIO_CONFIG, ...config }
  const setups = []
  for (let breakoutIndex = Math.max(...c.balanceWindows, c.atrPeriod); breakoutIndex < candles.length - 2; breakoutIndex++) {
    const balance = detectBalance(candles, breakoutIndex - 1, c)
    if (!balance) continue
    const direction = breakout(candles[breakoutIndex], balance, relativeVolumes[breakoutIndex] || 0, c)
    if (!direction) continue
    const boundary = direction > 0 ? balance.high : balance.low
    const zones = balance.lvnZones.filter((zone) => direction > 0
      ? zone.low >= balance.low && zone.high <= candles[breakoutIndex].high
      : zone.low >= candles[breakoutIndex].low && zone.high <= balance.high)
    const retestZone = direction > 0 ? (zones.at(-1) || { low: boundary - balance.atr * 0.1, high: boundary + balance.atr * 0.1 })
      : (zones[0] || { low: boundary - balance.atr * 0.1, high: boundary + balance.atr * 0.1 })
    const last = Math.min(candles.length - 2, breakoutIndex + c.retestDeadlineMinutes)
    for (let retestIndex = breakoutIndex + 1; retestIndex <= last; retestIndex++) {
      const retest = candles[retestIndex]
      const touches = retest.low <= retestZone.high && retest.high >= retestZone.low
      const holds = direction > 0 ? retest.close >= balance.high : retest.close <= balance.low
      if (!touches || !holds) continue
      const confirmationIndex = retestIndex + 1, confirmation = candles[confirmationIndex]
      if (!candleConfirms(confirmation, direction)) continue
      const depth = depthConfirmation(depthAtEnd.get(confirmation.at + 60_000), direction, c)
      if (!depth.confirmed) continue
      const entryIndex = confirmationIndex + 1, entry = candles[entryIndex].open
      const swing = candles.slice(breakoutIndex, confirmationIndex + 1)
      const stop = direction > 0 ? Math.min(...swing.map((bar) => bar.low)) : Math.max(...swing.map((bar) => bar.high))
      const risk = direction > 0 ? entry - stop : stop - entry
      if (!(risk > 0)) continue
      const target = entry + direction * risk * c.rewardRisk
      setups.push({ model: "TREND", direction: directionName(direction), directionSign: direction,
        balance, breakoutIndex, retestIndex, confirmationIndex, entryIndex, entry, stopLoss: stop, target,
        rewardRisk: c.rewardRisk, depth, reasons: ["balance", "accepted breakout", "LVN/boundary retest", "depth confirmation", "completed candle confirmation"] })
      break
    }
  }
  return setups
}
