/**
 * Default example strategy for scripts/backTest.js.
 *
 * Replace this file or pass --strategy ./strategies/my-strategy.js. A strategy
 * sees only completed candles. It enters at the following candle close, uses a
 * 0.5% stop, and exits on the stop, the opposite cross, or session close.
 */
export const reportsReturn = true

const STOP_LOSS_PCT = 0.5
const states = new Map()
const round = value => Number(value.toFixed(4))
const istTime = seconds => new Date(seconds * 1000 + 330 * 60_000).toISOString().slice(11, 16)

export function onCandle({ symbol, candle, completedAt, completedTime, nextEntryAt, isSessionExit, sessionExitTime }) {
  const day = completedTime.slice(0, 10)
  let state = states.get(symbol)
  if (!state || state.day !== day) {
    state = { day, ema10: candle.close, ema20: candle.close, bars: 1, pending: null, position: null }
    states.set(symbol, state)
    return null
  }

  let enteredThisCandle = false
  let entryOutput = null
  if (state.pending && completedAt >= state.pending.entryAt) {
    const side = state.pending.side
    const direction = side === 'BUY' ? 1 : -1
    const entryPrice = candle.close
    const stopPrice = entryPrice * (1 - direction * STOP_LOSS_PCT / 100)
    state.position = { side, direction, entryPrice, stopPrice, signalAt: state.pending.signalAt, entryAt: completedTime }
    entryOutput = { action: 'ENTRY', side, signalAt: state.pending.signalAt, entryAt: completedTime }
    state.pending = null
    enteredThisCandle = true
  }

  const previousGap = state.ema10 - state.ema20
  state.ema10 = candle.close * 2 / 11 + state.ema10 * 9 / 11
  state.ema20 = candle.close * 2 / 21 + state.ema20 * 19 / 21
  state.bars++
  const gap = state.ema10 - state.ema20
  const crossedUp = state.bars >= 21 && previousGap <= 0 && gap > 0
  const crossedDown = state.bars >= 21 && previousGap >= 0 && gap < 0
  const outputs = entryOutput ? [entryOutput] : []

  if (state.position && !enteredThisCandle) {
    const { side, direction, entryPrice, stopPrice, signalAt, entryAt } = state.position
    const openPastStop = direction > 0 ? candle.open <= stopPrice : candle.open >= stopPrice
    const stopHit = direction > 0 ? candle.low <= stopPrice : candle.high >= stopPrice
    const oppositeCross = side === 'BUY' ? crossedDown : crossedUp
    const sessionClose = isSessionExit
    if (openPastStop || stopHit || oppositeCross || sessionClose) {
      const stoppedOut = openPastStop || stopHit
      const exitPrice = openPastStop ? candle.open : stopHit ? stopPrice : candle.close
      outputs.push({ action: 'EXIT', side, signalAt, entryAt, exitAt: stoppedOut ? '' : completedTime, slAt: stoppedOut ? completedTime : '', returnPct: round(direction * 100 * (exitPrice / entryPrice - 1)) })
      state.position = null
    }
  }

  // Do not create a signal whose next completed-candle entry is at/after 15:00.
  if (istTime(nextEntryAt) < sessionExitTime && !state.position && !state.pending) {
    const side = crossedUp ? 'BUY' : crossedDown ? 'SELL' : null
    if (side) {
      state.pending = { side, signalAt: completedTime, entryAt: nextEntryAt }
      outputs.push({ action: 'SIGNAL', side, signalAt: completedTime })
    }
  }
  return outputs.length ? outputs : null
}
