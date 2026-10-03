import apiV3 from "fyers-api-v3"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { toFyersSymbol, toStockName } from "./market-data.js"

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

  const filename = (symbol) => {
    if (!allowed.has(symbol)) throw new Error("Unknown stock symbol")
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
    const ordered = [...candles.values()].sort((a, b) => a.time - b.time)
    return ordered.slice(-Math.max(1, Math.min(20_000, Number(limit) || 360)))
  }

  function append(symbol, candle) {
    const normalized = normalizeCandle(candle)
    if (!normalized) return Promise.reject(new Error("Invalid or out-of-session candle"))
    return enqueue(symbol, async () => {
      const stored = await loadCanonical(symbol)
      if (stored.has(normalized.time)) return { added: false, reason: "duplicate" }
      await appendFile(filename(symbol), `${JSON.stringify(normalized)}\n`, "utf8")
      stored.set(normalized.time, normalized)
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
      if (added) await writeCanonical(symbol, stored)
      return { total: stored.size, added, duplicate, invalid }
    })
  }

  return { append, read, fillMissingHistory, replaceHistory: fillMissingHistory }
}

export function createLiveCandleBuilder({ store, io, now = () => Date.now(), onError = () => {} }) {
  const states = new Map()
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
    return result?.added !== false
  }

  function reset() {
    // Never persist an unfinished candle on stop, disconnect, or reconnect.
    states.clear()
  }

  function observe(message, receivedAt = new Date()) {
    if (closed || !message || typeof message !== "object") return false
    const symbol = toStockName(message.symbol)
    const price = Number(message.ltp)
    const totalVolume = Number(message.vol_traded_today)
    const receivedMs = receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt)
    const timestamp = sourceTime(message, receivedMs)
    if (!symbol || !validPrice(price) || !Number.isSafeInteger(totalVolume) || totalVolume < 0 || timestamp == null) return false
    const minute = Math.floor(timestamp / MINUTE_MS) * MINUTE_SECONDS
    if (!isNseCandleMinute(minute)) return false

    let state = states.get(symbol)
    if (!state) {
      // The initial socket snapshot is only a baseline. It is not proof that a
      // trade happened after this process started.
      states.set(symbol, {
        current: null,
        totalVolume,
        lastTradeAt: timestamp,
        initialMinute: minute,
        finalized: null,
      })
      return false
    }
    if (timestamp < state.lastTradeAt || totalVolume <= state.totalVolume) {
      if (totalVolume < state.totalVolume) {
        // Volume resetting means a new exchange session or inconsistent stream.
        states.delete(symbol)
      }
      return false
    }

    const delta = totalVolume - state.totalVolume
    state.totalVolume = totalVolume
    state.lastTradeAt = timestamp
    if (!Number.isSafeInteger(delta) || delta <= 0) return false
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
    io.emit("candle:update", { symbol, candle: { ...state.current, source: "websocket-live" } })
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

export function createHistoryPreloader({ appId, getAccessToken, stocks, store, onStatus = () => {}, modelFactory } = {}) {
  let running = null
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
        ? `Backfilling today's completed one-minute candles for ${stocks.length} stocks`
        : `Checking 30 days for ${stocks.length} stocks` })
    const failures = []
    let added = 0
    let duplicate = 0
    let invalid = 0
    for (let index = 0; index < stocks.length; index++) {
      const symbol = stocks[index]
      try {
        const response = await client.getHistory({
          symbol: toFyersSymbol(symbol), resolution: "1", date_format: "0",
          range_from: String(range.from), range_to: String(range.to), cont_flag: "1",
        })
        if (response?.s !== "ok" || !Array.isArray(response.candles)) {
          throw new Error(response?.message || response?.msg || "Fyers returned no candle data")
        }
        const normalized = response.candles.flatMap(historyCandle)
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

function historyCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return []
  const candle = normalizeCandle({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
    low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), source: "fyers-history",
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
