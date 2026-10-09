import path from "node:path"
import { openOrderJournal } from "./order-journal.js"
import { createBroker, loadCurrentMetadata } from "./broker.js"
import { createExecution } from "./execution.js"
import { createDepthTrend, bookMetrics } from "./depth-trend.js"

export async function createTradingRuntime({ rootDirectory, constants, config, history }) {
  const journal = await openOrderJournal(path.join(rootDirectory, "db", "trend-orders"))
  const books = new Map(), signals = new Map()
  let closing = false, running = null, timer = null, metadataError = null
  let connected = false
  let metadata = { cashTickSizes: {}, contracts: new Map(), metadataDay: null }
  try {
    // The live option-depth recorder needs the option master even when order
    // routing is disabled, so contract metadata is always loaded at stream start.
    try {
      metadata = await loadCurrentMetadata({ options: true })
    } catch (error) { metadataError = error.message; console.error("Trading metadata unavailable:", error.message) }
    const broker = createBroker({ appId: constants.appId, token: constants.access_token, timeoutMs: config.apiTimeoutMs })
    const execution = createExecution({
      constants, config: { ...config, ...metadata }, broker, journal, contracts: metadata.contracts,
      history, getBook: (symbol) => books.get(symbol)?.book,
      canEnter: () => connected && !closing && history.status().state === "recording",
    })
    const detector = createDepthTrend({ config, hasExposure: execution.hasExposure, onSignal: (signal) => {
      // One outstanding signal per underlying, exits take priority. No unbounded
      // async queue in the high-frequency message handler.
      if (signals.get(signal.symbol)?.action !== "EXIT") signals.set(signal.symbol, signal)
    } })
    function observe(kind, data, at) {
      if (closing) return
      const now = at.getTime()
      if (kind === "depth") {
        let item = books.get(data.symbol)
        if (!item || now - item.at > config.staleMs) item = { raw: {} }
        Object.assign(item.raw, data)
        item.at = now
        const parsed = bookMetrics(item.raw)
        item.book = parsed && { ...parsed, at: now }
        books.set(data.symbol, item)
      }
      if (history.status().state === "recording") detector.observe(kind, data, now)
    }
    function reset() { connected = false; detector.reset(); books.clear(); signals.clear() }
    function cycle() {
      if (closing || running) return
      const batch = [...signals.values()]
      signals.clear()
      const ready = history.status().state === "recording"
      running = execution.cycle(ready ? batch : batch.filter((s) => s.action === "EXIT"))
        .finally(() => { running = null })
    }
    function placeCashOrder(signal) {
      const now = Date.now()
      const at = Number(signal?.at)
      if (closing || !connected || history.status().state !== "recording") {
        throw new Error("The live trading runtime is not ready.")
      }
      if (!execution.status().flags.cash) throw new Error("Live cash orders are disabled.")
      if (!signal?.symbol || !Number.isFinite(at) || now < at || now - at > config.signalMaxAgeMs) {
        throw new Error("This Strategy Radar signal is no longer fresh enough to trade.")
      }
      if (execution.hasExposure(signal.symbol)) throw new Error("This stock already has an open or pending order.")
      const queued = signals.get(signal.symbol)
      if (queued?.action === "EXIT") throw new Error("An exit is already queued for this stock.")
      if (queued?.action === "ENTRY") throw new Error("An entry is already queued for this stock.")
      signals.set(signal.symbol, { ...signal, action: "ENTRY", kind: "cash" })
      cycle()
      return { symbol: signal.symbol, action: "BUY" }
    }
    timer = setInterval(cycle, 2000)
    cycle() // Reconcile persisted orders before new signals can be evaluated.
    return {
      observe, reset, ready: () => { connected = true }, optionContracts: metadata.contracts,
      status: () => ({ metadataError, metadataDay: metadata.metadataDay, ...execution.status(), detector: detector.status() }),
      rankings: () => detector.rankings(5),
      brokerPositions: () => broker.positions(),
      placeCashOrder,
      async close() {
        closing = true
        clearInterval(timer)
        await running
        journal.close()
      },
    }
  } catch (error) {
    clearInterval(timer)
    journal.close()
    throw error
  }
}
