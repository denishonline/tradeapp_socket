import { randomUUID } from "node:crypto"
import { DEFAULT_TREND_CONFIG, entrySession, indiaTime } from "./config.js"
import { restBook, selectCall } from "./broker.js"

// Calculate executable price across levels, never use LTP as an assumed fill.
export function sweep(levels, requested, limit = Infinity, side = 1) {
  let qty = 0, value = 0, worst = null
  for (const level of levels) {
    if (side === 1 ? level.price > limit : level.price < limit) break
    const take = Math.min(requested - qty, level.qty)
    if (take > 0) { qty += take; value += take * level.price; worst = level.price }
    if (qty === requested) break
  }
  return { qty, average: qty ? value / qty : 0, worst }
}

export function createExecution({ constants, config = {}, broker, journal, contracts = new Map(), getBook, history, clock = Date.now, canEnter = () => true }) {
  const c = { ...DEFAULT_TREND_CONFIG, ...config }
  const state = structuredClone(journal.initialState)
  const chainCache = new Map()
  let fault = state.fault || null
  let busy = false
  let lastError = null
  const id = () => randomUUID()
  function commit(event) { journal.save(event, state) }
  function block(message) {
    if (fault === message) return
    fault = message; state.fault = message; commit({ type: "BLOCKED", message })
  }
  const hasExposure = (symbol) => state.positions.some((p) => p.underlying === symbol) || state.pending.some((p) => p.underlying === symbol)
  const flags = () => ({ cash: constants.flgPlaceCashOrder === true, option: constants.flgPlaceOptionOrder === true })
  function fresh(book, now) { return book && now >= book.at && now - book.at <= c.staleMs }
  function available() {
    const used = state.positions.reduce((s, p) => s + p.qty * p.entry, 0) + state.pending.filter((p) => p.side === 1).reduce((s, p) => s + p.qty * p.limit, 0)
    return Math.max(0, constants.balance - used)
  }
  function pnl(now) {
    const day = indiaTime(now).day
    let value = state.daily[day] || 0
    for (const p of state.positions) {
      const book = p.kind === "cash" ? getBook(p.symbol) : p.lastBook
      if (fresh(book, now)) {
        const quote = sweep(book.bids, p.qty)
        if (quote.qty === p.qty) value += (quote.average - p.entry) * p.qty - quote.average * p.qty * c.estimatedCostRate
      }
    }
    return value
  }
  function addFill(order, qty, price, now) {
    if (!qty) return
    const day = indiaTime(now).day
    state.daily[day] ??= 0
    state.daily[day] -= qty * price * c.estimatedCostRate
    if (order.side === 1) {
      state.positions.push({ id: order.positionId, underlying: order.underlying, symbol: order.symbol, kind: order.kind, live: order.live, qty, entry: price, peak: price, openedAt: now, tick: order.tick, lot: order.lot, exitReason: null, retryAt: 0 })
    } else {
      const p = state.positions.find((p) => p.id === order.positionId)
      if (!p || qty > p.qty) throw new Error("Exit fill exceeds owned position; reconcile broker")
      state.daily[day] += (price - p.entry) * qty
      p.qty -= qty
      p.retryAt = now + 5000
      if (!p.qty) {
        state.positions = state.positions.filter((x) => x.id !== p.id)
        state.cooldowns[p.underlying] = now + c.cooldownMs
      }
    }
  }

  async function submit({ underlying, symbol, kind, live, qty, side, tick, lot = 1, book, reason, positionId = id() }) {
    const now = clock()
    if (side === 1 && (!canEnter() || fault)) return false
    if (!fresh(book, now)) return false
    const quote = sweep(side === 1 ? book.asks : book.bids, qty)
    if (quote.qty !== qty || !quote.worst) return false
    // Round buys upward and sells downward to valid ticks. Cash orders require
    // an explicit validated tick size from the current contract metadata.
    const limit = Number(((side === 1 ? Math.ceil(quote.worst / tick - 1e-8) : Math.floor(quote.worst / tick + 1e-8)) * tick).toFixed(8))
    if (!(limit > 0)) return false
    if (side === 1 && qty * limit * (1 + c.estimatedCostRate) > Math.min(c.capitalPerTrade, available())) return false
    const order = { id: id(), positionId, underlying, symbol, kind, live, qty, side, tick, lot, limit, at: now, reason, brokerId: null, phase: "INTENT" }
    state.pending.push(order)
    commit({ type: "ORDER_INTENT", order }) // durable BEFORE network submission
    if (!live) {
      addFill(order, qty, quote.average, now)
      state.pending = state.pending.filter((p) => p.id !== order.id)
      commit({ type: "PAPER_FILL", orderId: order.id, qty, price: quote.average, assumed: true })
      return true
    }
    try {
      const result = await broker.place({ symbol, qty, type: 1, side, productType: constants.orderType, limitPrice: limit, stopPrice: 0, validity: "IOC", disclosedQty: 0, offlineOrder: false, stopLoss: 0, takeProfit: 0 }, book.at + c.staleMs)
      if (result?.s === "ok" && result.id) {
        order.brokerId = String(result.id)
        order.phase = "SUBMITTED"
        commit({ type: "ORDER_ACCEPTED", orderId: order.id, brokerId: order.brokerId })
      } else if (result?.s === "error") {
        state.pending = state.pending.filter((p) => p.id !== order.id)
        commit({ type: "ORDER_REJECTED", orderId: order.id, code: result.code })
      } else {
        order.phase = "UNKNOWN"
        block("Ambiguous order submission. Reconcile the journal with FYERS before further entries; no automatic resubmit.")
      }
    } catch {
      order.phase = "UNKNOWN"
      block("Order request failed with unknown outcome. Reconcile with FYERS; no automatic resubmit.")
    }
    return true
  }

  async function reconcile(now) {
    if (state.pending.some((p) => !p.live)) {
      // A paper intent interrupted before its fill was logged has no real fill.
      state.pending = state.pending.filter((p) => p.live)
      commit({ type: "PAPER_INTENTS_ABANDONED_AFTER_RESTART" })
    }
    if (state.pending.some((p) => !p.brokerId)) {
      if (!fault) block("Unresolved live intent from a previous request; manual broker reconciliation required.")
    }
    const pending = state.pending.filter((p) => p.live && p.brokerId)
    if (!pending.length) return
    const response = await broker.orders()
    if (response?.s !== "ok" || !Array.isArray(response.orderBook)) throw new Error("Cannot reconcile broker order book")
    for (const order of pending) {
      const row = response.orderBook.find((x) => String(x.id) === order.brokerId)
      if (!row) { if (now - order.at > c.orderTimeoutMs) block("Submitted order absent from broker order book; manual reconciliation required"); continue }
      const filled = Number(row.filledQty), price = Number(row.tradedPrice)
      if (row.symbol !== order.symbol || Number(row.side) !== order.side || !Number.isInteger(filled) || filled < 0 || filled > order.qty || (filled > 0 && !(price > 0))) {
        block("Invalid broker fill response; manual reconciliation required")
        continue
      }
      const terminal = [1, 2, 5].includes(Number(row.status))
      if (!terminal) {
        if (now - order.at > c.orderTimeoutMs * 4) block("Broker order remains unresolved after cancellation window; reconcile manually")
        if (now - order.at > c.orderTimeoutMs && !order.cancelRequested) {
          order.cancelRequested = true
          commit({ type: "CANCEL_REQUESTED", brokerId: order.brokerId })
          await broker.cancel(order.brokerId)
        }
        continue
      }
      if (Number(row.status) === 2 && filled !== order.qty) { block("Inconsistent filled status/quantity; reconcile broker"); continue }
      addFill(order, filled, price, now)
      state.pending = state.pending.filter((p) => p.id !== order.id)
      commit({ type: "ORDER_SETTLED", orderId: order.id, brokerId: order.brokerId, status: Number(row.status), filledQty: filled, averagePrice: price })
    }
  }

  async function optionFor(signal, now) {
    let cached = chainCache.get(signal.symbol)
    if (!cached || now - cached.at >= c.chainCacheMs) {
      const response = await broker.chain(signal.symbol)
      cached = { at: clock(), response }
      chainCache.set(signal.symbol, cached)
      history?.record("option_chain", { symbol: signal.symbol, response }, new Date(cached.at))
    }
    return selectCall(cached.response, contracts, signal.symbol, signal.price, now, c)
  }

  async function enter(signal) {
    let now = clock()
    if (fault || !canEnter() || !entrySession(now, c) || now - signal.at > c.signalMaxAgeMs || now < signal.at || hasExposure(signal.symbol) || now < (state.cooldowns[signal.symbol] || 0) || pnl(now) <= constants.maxLoss) return
    const mode = flags()
    if ((mode.cash || mode.option) && c.metadataDay !== indiaTime(now).day) {
      commit({ type: "ENTRY_SKIPPED", symbol: signal.symbol, reason: "Current-day instrument metadata unavailable; restart to refresh" })
      return
    }
    const kinds = signal.kind === "cash"
      ? (mode.cash ? ["cash"] : [])
      : mode.cash || mode.option ? [ ...(mode.cash ? ["cash"] : []), ...(mode.option ? ["option"] : []) ] : ["cash"]
    commit({ type: "ENTRY_SIGNAL", signal })
    for (const kind of kinds) {
      if (fault || state.positions.length + state.pending.length >= constants.maxPositions) break
      const live = kind === "cash" ? mode.cash : mode.option
      let symbol = signal.symbol, lot = 1, tick = null
      if (kind === "option") {
        const option = await optionFor(signal, now)
        if (!option) { commit({ type: "ENTRY_SKIPPED", symbol, kind, reason: "No liquid, unexpired call with validated lot/tick metadata" }); continue }
        ;({ symbol, lot, tick } = option)
      } else {
        tick = c.cashTickSizes?.[symbol]
        // Paper quotes do not need exchange tick metadata; use the visible price
        // directly through a fine increment. Live cash never guesses tick size.
        if (!tick && !live) tick = 0.0001
        if (!(tick > 0)) { commit({ type: "ENTRY_SKIPPED", symbol, kind, reason: "Missing validated cash tick size in DEPTH_TREND.cashTickSizes" }); continue }
      }
      let book
      if (kind === "cash") book = getBook(symbol)
      else {
        const requestedAt = clock()
        const response = await broker.depth(symbol)
        const parsed = restBook(response, symbol)
        book = parsed && { ...parsed, at: requestedAt }
        history?.record("option_depth", { symbol, response })
      }
      now = clock()
      if (!entrySession(now, c) || now - signal.at > c.signalMaxAgeMs || !fresh(book, now) || book.spread > (kind === "cash" ? c.maxSpread : c.optionMaxSpread)) continue
      if (kind === "option") {
        const underlying = getBook(signal.symbol)
        if (!fresh(underlying, now) || underlying.spread > c.maxSpread ||
            (underlying.bids[0].price + underlying.asks[0].price) / 2 < signal.price ||
            (underlying.bids[0].price + underlying.asks[0].price) / 2 > signal.price * (1 + c.maxChase)) {
          commit({ type: "ENTRY_SKIPPED", symbol, reason: "Underlying no longer confirms the call entry" })
          continue
        }
      }
      if (live) {
        const response = await broker.positions()
        if (response?.s !== "ok" || !Array.isArray(response.netPositions)) throw new Error("Cannot verify account exposure before entry")
        if (response.netPositions.some((p) => p.symbol === symbol && Number(p.netQty) !== 0)) {
          commit({ type: "ENTRY_SKIPPED", symbol, reason: "Existing broker position in this instrument" })
          continue
        }
        now = clock()
        if (!fresh(book, now) || now - signal.at > c.signalMaxAgeMs || !entrySession(now, c)) continue
      }
      const budget = Math.min(c.capitalPerTrade, available()) / (1 + c.estimatedCostRate)
      const qty = kind === "cash" ? Math.floor(budget / book.asks[0].price) : lot * constants.lot
      const quote = sweep(book.asks, qty)
      if (!Number.isInteger(qty) || qty <= 0 || quote.qty !== qty || qty * quote.worst > budget) { commit({ type: "ENTRY_SKIPPED", symbol, kind, reason: "Insufficient capital or displayed depth for requested quantity" }); continue }
      await submit({ underlying: signal.symbol, symbol, kind, live, qty, side: 1, tick, lot, book, reason: signal.reason })
    }
  }

  async function manage(now, signals) {
    let positionsResponse = null
    for (const p of [...state.positions]) {
      if (state.pending.some((o) => o.positionId === p.id) || now < p.retryAt) continue
      let book = getBook(p.symbol)
      if (p.kind === "option") {
        const at = clock()
        const response = await broker.depth(p.symbol)
        const parsed = restBook(response, p.symbol)
        book = parsed && { ...parsed, at }
        history?.record("option_depth", { symbol: p.symbol, response })
      }
      now = clock()
      if (!fresh(book, now)) continue
      p.lastBook = book
      const quote = sweep(book.bids, p.qty)
      if (!quote.qty) continue
      p.peak = Math.max(p.peak, quote.average)
      const stop = p.kind === "cash" ? constants.sl : constants.optionSL
      const trail = p.kind === "cash" ? c.trailingFraction : c.optionTrailingFraction
      if (quote.average <= p.entry * (1 - stop)) p.exitReason = "stop_loss"
      else if (quote.average <= p.peak * (1 - trail)) p.exitReason = "trailing_exit"
      else if (indiaTime(now).minute >= c.squareOffMinute || indiaTime(now).day !== indiaTime(p.openedAt).day) p.exitReason = "session_exit"
      else if (pnl(now) <= constants.maxLoss) p.exitReason = "daily_loss_limit"
      else if (signals.some((s) => s.symbol === p.underlying && s.action === "EXIT")) p.exitReason = "trend_weakness"
      if (!p.exitReason) continue
      commit({ type: "EXIT_SIGNAL", positionId: p.id, reason: p.exitReason })
      if (p.live) {
        positionsResponse ??= await broker.positions()
        if (positionsResponse?.s !== "ok" || !Array.isArray(positionsResponse.netPositions)) throw new Error("Cannot verify broker position before exit")
        const actual = positionsResponse.netPositions.find((x) => x.symbol === p.symbol && x.productType === constants.orderType)
        if (!actual || Number(actual.netQty) < p.qty) { block("Broker position differs from owned quantity; exit withheld to avoid overselling"); continue }
      }
      const exitQty = Math.floor(quote.qty / p.lot) * p.lot
      if (exitQty) await submit({ ...p, qty: exitQty, positionId: p.id, side: -1, book, reason: p.exitReason })
    }
  }

  async function cycle(signals = []) {
    if (busy) return
    busy = true
    try {
      await reconcile(clock())
      await manage(clock(), signals)
      for (const signal of signals) if (signal.action === "ENTRY") await enter(signal)
      if (state.positions.length) commit({ type: "POSITION_MARKS" })
      lastError = null
    } catch (error) {
      lastError = error.message
      // Any exception involving state persistence may have an ambiguous outcome.
      fault = error.message
      state.fault = fault
      try { commit({ type: "EXECUTION_ERROR", message: fault }) } catch { /* Never submit after failed persistence. */ }
    } finally { busy = false }
  }
  return {
    cycle, hasExposure,
    status: () => ({ flags: flags(), fault, lastError, busy, positions: structuredClone(state.positions), pending: structuredClone(state.pending), dailyEstimatedPnl: { ...state.daily }, availableCapital: available() }),
  }
}
