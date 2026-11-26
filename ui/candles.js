import apiV3 from "fyers-api-v3"
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { toFyersSymbol, toMarketName } from "./market-data.js"

const MINUTE_SECONDS = 60
const MINUTE_MS = MINUTE_SECONDS * 1000
const IST_OFFSET_MS = 330 * 60_000
const SESSION_OPEN_MINUTE = 9 * 60 + 15
const SESSION_CLOSE_MINUTE = 15 * 60 + 30
const MAX_SOURCE_DELAY_MS = 2 * 60_000

export async function createCandleStore({ directory, symbols }) {
  await mkdir(directory, { recursive: true })
  const allowed = new Set(symbols)
  const queues = new Map()
  const indexes = new Map()
  const orderedIndexes = new Map()

  const filename = (symbol) => {
    if (!allowed.has(symbol)) throw new Error("Unknown market symbol")
    return path.join(directory, `${symbol}.jsonl`)
  }

  const enqueue = (symbol, work) => {
    const previous = queues.get(symbol) || Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    queues.set(symbol, next)
    return next.finally(() => {
      if (queues.get(symbol) === next) queues.delete(symbol)
    })
  }

  async function loadCanonical(symbol) {
    if (indexes.has(symbol)) return indexes.get(symbol)
    let contents = ""
    try {
      contents = await readFile(filename(symbol), "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    const candles = new Map()
    let validLines = 0
    let nonemptyLines = 0
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue
      nonemptyLines++
      try {
        const candle = normalizeCandle(JSON.parse(line))
        if (candle) {
          validLines++
          // Keep the first valid stored candle. Later duplicates never replace it.
          if (!candles.has(candle.time)) candles.set(candle.time, candle)
        }
      } catch {
        // Invalid JSON and malformed candles are removed during canonicalization.
      }
    }
    indexes.set(symbol, candles)
    orderedIndexes.set(symbol, [...candles.values()].sort((a, b) => a.time - b.time))
    if (nonemptyLines !== candles.size || validLines !== candles.size) {
      await writeCanonical(symbol, candles)
    }
    return candles
  }

  async function writeCanonical(symbol, candles) {
    const body = [...candles.values()]
      .sort((a, b) => a.time - b.time)
      .map((candle) => JSON.stringify(candle))
      .join("\n")
    const target = filename(symbol)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, body ? `${body}\n` : "", "utf8")
    await rename(temporary, target)
  }

  async function read(symbol, { limit = 360 } = {}) {
    await queues.get(symbol)?.catch(() => {})
    const candles = await loadCanonical(symbol)
    const ordered = orderedIndexes.get(symbol) || []
    return ordered.slice(-Math.max(1, Math.min(20_000, Number(limit) || 360)))
  }

  // Lightweight path for dashboard quote snapshots. It reads only the tail of
  // the JSONL file instead of parsing and sorting the entire multi-month file.
  async function readLatest(symbol, { limit = 2 } = {}) {
    await queues.get(symbol)?.catch(() => {})
    const handle = await open(filename(symbol), "r").catch((error) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (!handle) return []
    try {
      const stats = await handle.stat()
      const bytes = Math.min(stats.size, 128 * 1024)
      if (!bytes) return []
      const buffer = Buffer.alloc(bytes)
      await handle.read(buffer, 0, bytes, stats.size - bytes)
      const rows = buffer.toString("utf8").split(/\r?\n/).filter(Boolean)
      const result = []
      for (let index = rows.length - 1; index >= 0 && result.length < Math.max(1, Number(limit) || 2); index--) {
        try {
          const candle = normalizeCandle(JSON.parse(rows[index]))
          if (candle) result.push(candle)
        } catch {}
      }
      return result.reverse()
    } finally {
      await handle.close()
    }
  }

  function append(symbol, candle) {
    const normalized = normalizeCandle(candle)
    if (!normalized) return Promise.reject(new Error("Invalid or out-of-session candle"))
    return enqueue(symbol, async () => {
      const stored = await loadCanonical(symbol)
      if (stored.has(normalized.time)) return { added: false, reason: "duplicate" }
      await appendFile(filename(symbol), `${JSON.stringify(normalized)}\n`, "utf8")
      stored.set(normalized.time, normalized)
      const ordered = orderedIndexes.get(symbol) || []
      if (!ordered.length || ordered.at(-1).time < normalized.time) ordered.push(normalized)
      else {
        const index = ordered.findIndex((item) => item.time > normalized.time)
        ordered.splice(index < 0 ? ordered.length : index, 0, normalized)
      }
      orderedIndexes.set(symbol, ordered)
      return { added: true }
    })
  }

  // Historical fetches are additive. Every valid stored candle is retained, and
  // REST data fills only timestamps that are genuinely absent.
  function fillMissingHistory(symbol, incoming) {
    return enqueue(symbol, async () => {
      const stored = await loadCanonical(symbol)
      let added = 0
      let duplicate = 0
      let invalid = 0
      for (const value of incoming) {
        const candle = normalizeCandle(value)
        if (!candle) {
          invalid++
        } else if (stored.has(candle.time)) {
          duplicate++
        } else {
          stored.set(candle.time, candle)
          added++
        }
      }
      if (added) {
        await writeCanonical(symbol, stored)
        orderedIndexes.set(symbol, [...stored.values()].sort((a, b) => a.time - b.time))
      }
      return { total: stored.size, added, duplicate, invalid }
    })
  }

  // A live chart refresh must also update today's already-stored candles. FYERS
  // can return a more complete close/volume for a minute that was previously
  // written by the websocket, so this path intentionally replaces matching
  // timestamps while retaining every other historical candle.
  function mergeHistory(symbol, incoming, { replaceExisting = false } = {}) {
    return enqueue(symbol, async () => {
      const stored = await loadCanonical(symbol)
      let added = 0
      let replaced = 0
      let duplicate = 0
      let invalid = 0
      for (const value of incoming) {
        const candle = normalizeCandle(value)
        if (!candle) {
          invalid++
        } else if (stored.has(candle.time)) {
          if (replaceExisting && JSON.stringify(stored.get(candle.time)) !== JSON.stringify(candle)) {
            stored.set(candle.time, candle)
            replaced++
          } else {
            duplicate++
          }
        } else {
          stored.set(candle.time, candle)
          added++
        }
      }
      if (added || replaced) {
        await writeCanonical(symbol, stored)
        orderedIndexes.set(symbol, [...stored.values()].sort((a, b) => a.time - b.time))
      }
      return { total: stored.size, added, replaced, duplicate, invalid }
    })
  }

  return { append, read, readLatest, fillMissingHistory, mergeHistory, replaceHistory: fillMissingHistory }
}

export function createLiveCandleBuilder({ store, io, indexSymbols = [], now = () => Date.now(), onError = () => {}, onUpdate = () => {}, onComplete = () => {} }) {
  const states = new Map()
  const indices = new Set(indexSymbols)
  let closed = false

  async function finalize(symbol, state) {
    const current = state.current
    if (!current || current.partial || state.finalized === current.time) return false
    state.finalized = current.time
    const candle = { ...current, source: "websocket" }
    delete candle.partial
    let result
    try {
      result = await store.append(symbol, candle)
    } catch (error) {
      onError(symbol, error)
      throw error
    }
    io.emit("candle:complete", { symbol, candle, stored: result?.added !== false })
    try { onComplete(symbol, candle) }
    catch (error) { console.error(`Cannot evaluate ${symbol} strategy candle:`, error.message) }
    return result?.added !== false
  }

  function reset() {
    // Never persist an unfinished candle on stop, disconnect, or reconnect.
    states.clear()
  }

  function observe(message, receivedAt = new Date()) {
    if (closed || !message || typeof message !== "object") return false
    const symbol = toMarketName(message.symbol)
    const price = Number(message.ltp)
    const totalVolume = Number(message.vol_traded_today)
    const receivedMs = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    const timestamp = sourceTime(message, receivedMs)
    const isIndex = indices.has(symbol)
    if (!symbol || !validPrice(price) || (!isIndex && (!Number.isSafeInteger(totalVolume) || totalVolume < 0)) || timestamp == null) return false
    const minute = Math.floor(timestamp / MINUTE_MS) * MINUTE_SECONDS
    if (!isNseCandleMinute(minute)) return false

    let state = states.get(symbol)
    if (!state) {
      // The initial socket snapshot is only a baseline. It is not proof that a
      // trade happened after this process started.
      states.set(symbol, {
        current: null,
        totalVolume: isIndex ? 0 : totalVolume,
        lastTradeAt: timestamp,
        initialMinute: minute,
        finalized: null,
      })
      return false
    }
    if (timestamp < state.lastTradeAt || (!isIndex && totalVolume <= state.totalVolume)) {
      if (!isIndex && totalVolume < state.totalVolume) {
        // Volume resetting means a new exchange session or inconsistent stream.
        states.delete(symbol)
      }
      return false
    }

    const delta = isIndex ? 0 : totalVolume - state.totalVolume
    state.totalVolume = isIndex ? 0 : totalVolume
    state.lastTradeAt = timestamp
    if (!isIndex && (!Number.isSafeInteger(delta) || delta <= 0)) return false
    if (state.current && minute < state.current.time) return false
    if (state.current && minute > state.current.time) {
      void finalize(symbol, state).catch((error) => console.error(`Cannot store ${symbol} candle:`, error.message))
      state.current = null
    }
    if (!state.current) {
      state.current = {
        time: minute,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: delta,
        partial: minute === state.initialMinute,
      }
    } else {
      state.current.high = Math.max(state.current.high, price)
      state.current.low = Math.min(state.current.low, price)
      state.current.close = price
      state.current.volume += delta
    }
    const liveCandle = { ...state.current, source: "websocket-live" }
    io.emit("candle:update", { symbol, candle: liveCandle })
    try { onUpdate(symbol, liveCandle) }
    catch (error) { console.error(`Cannot update ${symbol} live strategy return:`, error.message) }
    return true
  }

  const timer = setInterval(() => {
    const currentMs = now()
    for (const [symbol, state] of states) {
      if (state.current && currentMs >= (state.current.time + MINUTE_SECONDS) * 1000 + 2000) {
        void finalize(symbol, state).catch((error) => console.error(`Cannot store ${symbol} candle:`, error.message))
      }
      if (!isNseTimestamp(currentMs) &&
          (!state.current || state.current.partial || state.finalized === state.current.time)) {
        states.delete(symbol)
      }
    }
  }, 1000)
  timer.unref?.()

  return {
    observe,
    reset,
    close() {
      closed = true
      clearInterval(timer)
      reset()
    },
  }
}

export function createHistoryPreloader({ appId, getAccessToken, stocks, store, onStatus = () => {}, modelFactory,
  symbolFormatter = toFyersSymbol, historySource = "fyers-history", label = "stocks",
  refreshConcurrency = 5, refreshWorkerDelayMs = 400 } = {}) {
  let running = null
  let refreshBatchRunning = null
  const refreshes = new Map()
  const refreshCompleted = new Map()
  const sessionSynced = new Map()
  const refreshCacheMs = 30_000
  let status = { state: "idle", completed: 0, total: stocks.length, message: "Not fetched yet", updatedAt: new Date().toISOString() }

  const publish = (next) => {
    status = { ...status, ...next, updatedAt: new Date().toISOString() }
    onStatus({ ...status })
  }

  async function run({ sessionOnly = false } = {}) {
    const token = getAccessToken()
    if (!token || typeof token !== "string") throw new Error("Fyers access token is missing. Run AutoLogin first.")
    const client = modelFactory ? modelFactory() : new apiV3.fyersModel({ enableLogging: false })
    client.setAppId(appId)
    client.setAccessToken(token)
    const now = Date.now()
    const range = sessionOnly ? currentSessionRange(now) : {
      from: Math.floor(now / 1000) - 30 * 24 * 60 * 60,
      to: Math.floor(now / 1000),
    }
    if (!range) {
      publish({ state: "complete", completed: stocks.length, total: stocks.length, added: 0, duplicate: 0, invalid: 0,
        message: "No current NSE session candles to backfill" })
      return { ...status }
    }
    publish({ state: "running", completed: 0, total: stocks.length, added: 0,
      message: sessionOnly
        ? `Backfilling today's completed one-minute candles for ${stocks.length} ${label}`
        : `Checking 30 days for ${stocks.length} ${label}` })
    const failures = []
    let added = 0
    let duplicate = 0
    let invalid = 0
    for (let index = 0; index < stocks.length; index++) {
      const symbol = stocks[index]
      try {
        const response = await client.getHistory({
          symbol: symbolFormatter(symbol), resolution: "1", date_format: "0",
          range_from: String(range.from), range_to: String(range.to), cont_flag: "1",
        })
        if (response?.s !== "ok" || !Array.isArray(response.candles)) {
          throw new Error(response?.message || response?.msg || "Fyers returned no candle data")
        }
        const normalized = response.candles.flatMap((row) => historyCandle(row, historySource))
        const fetched = normalized.filter((candle) =>
          candle.time >= range.from && candle.time <= range.to &&
          (!sessionOnly || candle.time < range.currentMinute))
        const result = await store.fillMissingHistory(symbol, fetched)
        added += result.added
        duplicate += result.duplicate
        invalid += result.invalid + (response.candles.length - normalized.length)
      } catch (error) {
        failures.push({ symbol, message: error.message })
      }
      publish({ completed: index + 1, added, duplicate, invalid, message: `${sessionOnly ? "Backfilled" : "Checked"} ${index + 1}/${stocks.length} · ${symbol}` })
      if (index < stocks.length - 1) await delay(400)
    }
    const final = failures.length
      ? { state: "partial", failures: failures.length, message: `Added ${added} missing candles; ${failures.length} stocks failed` }
      : { state: "complete", failures: 0, message: sessionOnly
        ? `Backfilled ${added} missing candles; kept all existing data`
        : `Added ${added} missing candles; kept all existing data` }
    publish({ ...final, added, duplicate, invalid })
    return { ...status, failureDetails: failures }
  }

  async function refreshCurrentSession(symbol, { bypassCache = false, recentMinutes = null } = {}) {
    if (!stocks.includes(symbol)) throw new Error(`Unknown ${label.slice(0, -1)} symbol: ${symbol}`)
    if (refreshes.has(symbol)) return refreshes.get(symbol)
    const cached = refreshCompleted.get(symbol)
    if (!bypassCache && cached && Date.now() - cached.at < refreshCacheMs) return { ...cached.result, cached: true }
    const promise = (async () => {
      const token = getAccessToken()
      if (!token || typeof token !== "string") throw new Error("FYERS access token is missing. Run AutoLogin first.")
      const range = currentSessionRange(Date.now())
      if (!range) {
        return { symbol, fetched: 0, added: 0, replaced: 0, duplicate: 0, invalid: 0,
          message: "No current NSE session is available to refresh." }
      }
      const client = modelFactory ? modelFactory() : new apiV3.fyersModel({ enableLogging: false })
      client.setAppId(appId)
      client.setAccessToken(token)
      const rangeFrom = Number.isFinite(Number(recentMinutes)) && Number(recentMinutes) > 0
        ? Math.max(range.from, range.currentMinute - Math.trunc(Number(recentMinutes)) * 60)
        : range.from
      const response = await client.getHistory({
        symbol: symbolFormatter(symbol), resolution: "1", date_format: "0",
        range_from: String(rangeFrom), range_to: String(range.to), cont_flag: "1",
      })
      if (response?.s !== "ok" || !Array.isArray(response.candles)) {
        throw new Error(response?.message || response?.msg || "FYERS returned no current-day candle data")
      }
      const normalized = response.candles.flatMap((row) => historyCandle(row, historySource))
        .filter((candle) => candle.time >= range.from && candle.time <= range.to && candle.time < range.currentMinute)
      const result = await store.mergeHistory(symbol, normalized, { replaceExisting: true })
      const output = { symbol, fetched: normalized.length, ...result, message: `FYERS current-day history merged for ${symbol}` }
      refreshCompleted.set(symbol, { at: Date.now(), result: output })
      return output
    })()
    refreshes.set(symbol, promise)
    try {
      return await promise
    } finally {
      if (refreshes.get(symbol) === promise) refreshes.delete(symbol)
    }
  }

  function refreshAllCurrentSession(requestedSymbols = stocks) {
    if (refreshBatchRunning) return refreshBatchRunning
    const batchSymbols = [...new Set(requestedSymbols)].filter((symbol) => stocks.includes(symbol))
    refreshBatchRunning = (async () => {
      const concurrency = Math.max(1, Math.min(batchSymbols.length, Math.trunc(Number(refreshConcurrency)) || 1))
      const workerDelay = Math.max(0, Math.trunc(Number(refreshWorkerDelayMs)) || 0)
      let cursor = 0, completed = 0, added = 0, replaced = 0, duplicate = 0, invalid = 0
      const failures = []
      publish({ state: "refreshing", completed: 0, total: batchSymbols.length, added: 0, replaced: 0, duplicate: 0, invalid: 0,
        message: `Refreshing completed one-minute candles for ${batchSymbols.length} ${label} with ${concurrency} workers` })
      const worker = async () => {
        while (true) {
          const index = cursor++
          if (index >= batchSymbols.length) return
          const symbol = batchSymbols[index]
          try {
            // First successful request for a symbol reconciles the entire
            // current session. Later minute cycles request only a short overlap.
            const result = await refreshCurrentSession(symbol, {
              bypassCache: true,
              recentMinutes: sessionSynced.get(symbol) === currentSessionRange(Date.now())?.from ? 3 : null,
            })
            sessionSynced.set(symbol, currentSessionRange(Date.now())?.from)
            added += Number(result.added) || 0
            replaced += Number(result.replaced) || 0
            duplicate += Number(result.duplicate) || 0
            invalid += Number(result.invalid) || 0
          } catch (error) {
            failures.push({ symbol, message: error.message })
          }
          completed++
          publish({ completed, added, replaced, duplicate, invalid,
            message: `Refreshed ${completed}/${batchSymbols.length} · ${symbol}` })
          if (workerDelay && cursor < batchSymbols.length) await delay(workerDelay)
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      const final = failures.length
        ? { state: "partial", failures: failures.length, message: `Reconciled completed candles; ${failures.length} ${label} failed and will retry next cycle` }
        : { state: "complete", failures: 0, message: `Reconciled completed one-minute candles for ${batchSymbols.length} ${label}` }
      publish({ ...final, completed, total: batchSymbols.length, added, replaced, duplicate, invalid })
      return { ...status, failureDetails: failures }
    })().finally(() => { refreshBatchRunning = null })
    return refreshBatchRunning
  }

  function start(sessionOnly = false) {
    if (running) return { accepted: false, status: { ...status } }
    running = run({ sessionOnly })
      .catch((error) => {
        publish({ state: "error", message: error.message })
        return { ...status }
      })
      .finally(() => { running = null })
    return { accepted: true, status: { ...status } }
  }

  return {
    start: () => start(false),
    startSessionBackfill: () => start(true),
    refreshCurrentSession,
    refreshAllCurrentSession,
    status: () => ({ ...status }),
  }
}

function currentSessionRange(nowMs) {
  const india = new Date(nowMs + IST_OFFSET_MS)
  const weekday = india.getUTCDay()
  const minute = india.getUTCHours() * 60 + india.getUTCMinutes()
  if (weekday < 1 || weekday > 5 || minute < SESSION_OPEN_MINUTE) return null

  const year = india.getUTCFullYear()
  const month = india.getUTCMonth()
  const day = india.getUTCDate()
  const from = Math.floor(Date.UTC(year, month, day, 3, 45) / 1000)
  const close = Math.floor(Date.UTC(year, month, day, 10, 0) / 1000)
  const now = Math.floor(nowMs / 1000)
  const to = Math.min(now, close - 1)
  return { from, to, currentMinute: Math.floor(nowMs / MINUTE_MS) * MINUTE_SECONDS }
}

function historyCandle(row, source = "fyers-history") {
  if (!Array.isArray(row) || row.length < 6) return []
  const candle = normalizeCandle({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), source,
  })
  return candle ? [candle] : []
}

export function normalizeCandle(value) {
  if (!value || typeof value !== "object") return null
  const candle = {
    time: Number(value.time), open: Number(value.open), high: Number(value.high),
    low: Number(value.low), close: Number(value.close), volume: Number(value.volume),
    source: typeof value.source === "string" ? value.source.slice(0, 40) : "unknown",
  }
  const prices = [candle.open, candle.high, candle.low, candle.close]
  if (!Number.isSafeInteger(candle.time) || candle.time <= 0 || candle.time % MINUTE_SECONDS !== 0 ||
      !prices.every(validPrice) || !Number.isSafeInteger(candle.volume) || candle.volume < 0 ||
      candle.high < candle.low || candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close) || !isNseCandleMinute(candle.time)) return null
  return candle
}

export function isNseCandleMinute(epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds)) return false
  const india = new Date(epochSeconds * 1000 + IST_OFFSET_MS)
  const weekday = india.getUTCDay()
  const minute = india.getUTCHours() * 60 + india.getUTCMinutes()
  return weekday >= 1 && weekday <= 5 && minute >= SESSION_OPEN_MINUTE && minute < SESSION_CLOSE_MINUTE
}

function isNseTimestamp(milliseconds) {
  return isNseCandleMinute(Math.floor(milliseconds / MINUTE_MS) * MINUTE_SECONDS)
}

function validPrice(value) {
  return Number.isFinite(value) && value > 0 && value < 1_000_000_000
}

function sourceTime(message, receivedMs) {
  if (!Number.isFinite(receivedMs)) return null
  for (const value of [message.last_traded_time, message.exch_feed_time, message.timestamp]) {
    const raw = Number(value)
    if (!Number.isFinite(raw) || raw <= 0) continue
    const milliseconds = raw < 10_000_000_000 ? raw * 1000 : raw
    if (milliseconds <= receivedMs + 5000 && receivedMs - milliseconds <= MAX_SOURCE_DELAY_MS) return milliseconds
  }
  return null
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
