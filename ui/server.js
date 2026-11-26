import dotenv from "dotenv"
import express from "express"
import apiV3 from "fyers-api-v3"
import { createServer } from "node:http"
import { execFile, spawn } from "node:child_process"
import { readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Server as SocketServer } from "socket.io"
import { autoLogin, formatAutoLoginError } from "../autologin.js"
import { CONSTANT, DEPTH_TREND } from "../constant.js"
import { getFromStorage } from "../utils.js"
import {
  createCandleStore,
  createHistoryPreloader,
  createLiveCandleBuilder,
} from "./candles.js"
import {
  loadStocks,
  toFyersIndexSymbol,
  toFyersSymbol,
  toMarketName,
} from "./market-data.js"
import { createMarketFeed } from "./market-feed.js"
import { createMarketHistory } from "./market-history.js"
import { createMarketDepthHistory } from "./market-depth-history.js"
import {
  formatIstDateTime,
  isWithinLiveMarketSession,
  nextMarketOpen,
} from "./market-session.js"
import { createTradingRuntime } from "./trading/runtime.js"
import { createBroker } from "./trading/broker.js"
import { brokerTimestamp, positionStartedAt, sellPositionExitStatus } from "./position-exit.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDirectory = path.resolve(__dirname, "..")
const databaseDirectory = path.join(rootDirectory, "db")
const publicDirectory = path.join(__dirname, "public")
const environment = process.env.NODE_ENV || "production"
const envFile = environment === "production" ? ".env.production" : ".env"
dotenv.config({ path: path.join(rootDirectory, envFile) })
const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || "127.0.0.1"
// The dashboard server is a lean WebSocket cash-depth collector by default.
// Set DEPTH_ONLY_MODE=false only when live candles and trading are needed.
const depthOnlyMode = process.env.DEPTH_ONLY_MODE !== "false"
const historyRefreshConcurrency = Math.max(1, Math.min(20, Math.trunc(Number(process.env.HISTORY_REFRESH_CONCURRENCY)) || 5))
const historyRefreshWorkerDelayMs = Math.max(0, Math.trunc(Number(process.env.HISTORY_REFRESH_WORKER_DELAY_MS)) || 400)
const historyRefreshOffsetMs = Math.max(1_000, Math.min(30_000, Math.trunc(Number(process.env.HISTORY_REFRESH_OFFSET_MS)) || 5_000))

let nifty50HistoryCache = null
const NIFTY_HISTORY_CACHE_MS = 30_000

async function directorySize(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return directorySize(entryPath)
      if (entry.isFile()) return (await stat(entryPath)).size
      return 0
    }),
  )
  return sizes.reduce((total, size) => total + size, 0)
}

// Depth history is intentionally retained only for the latest five stored
// NSE sessions. Candle history is separate and is never touched here.
async function pruneMarketDepthHistory(directory, keepSessions = 5) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return { kept: [], removed: [] }
    throw error
  }
  const sessionDirectories = entries
    .filter(
      (entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
  const keep = sessionDirectories.slice(-keepSessions),
    remove = sessionDirectories.slice(0, -keepSessions)
  for (const date of remove)
    await rm(path.join(directory, date), { recursive: true, force: true })
  return { kept: keep, removed: remove }
}

let dbSizeBytes = await directorySize(databaseDirectory)
let dbSizeUpdatedAt = new Date().toISOString()

const stocks = await loadStocks(path.join(rootDirectory, "db", "stocks"))
const indexSymbols = ["NIFTY50"]
const marketSymbols = [...stocks, ...indexSymbols]
const history = depthOnlyMode
  ? {
      record: () => false,
      flush: async () => {},
      close: async () => {},
      status: () => ({
        state: "disabled",
        message: "General market-history recording disabled in depth-only mode",
      }),
    }
  : await createMarketHistory({
      directory: path.resolve(
        rootDirectory,
        process.env.MARKET_HISTORY_DIR || "db/market-history",
      ),
    })
const depthHistory = await createMarketDepthHistory({
  directory: path.join(rootDirectory, "db", "cash-depth"),
})
const cashDepthDirectory = path.join(rootDirectory, "db", "cash-depth")
const depthPrune = await pruneMarketDepthHistory(cashDepthDirectory, 5)
if (depthPrune.removed.length)
  console.log(
    `Pruned market depth history: removed ${depthPrune.removed.length} old session(s); kept ${depthPrune.kept.join(", ")}`,
  )
if (!depthOnlyMode) {
  history.record("recorder_start", { stocks: stocks.length, indexSymbols })
  await history.flush()
  if (history.status().state === "error")
    throw new Error(history.status().error)
}
const depthRetentionTimer = setInterval(() => {
  void pruneMarketDepthHistory(cashDepthDirectory, 5).catch((error) =>
    console.error("Cannot prune market depth history:", error.message),
  )
}, 10 * 60_000)
depthRetentionTimer.unref?.()

const candles = await createCandleStore({
  directory: path.join(rootDirectory, "db", "candles"),
  symbols: marketSymbols,
})
const app = express()
globalThis.__tradeappErrorLog?.attachRoutes(app)
const httpServer = createServer(app)
const io = new SocketServer(httpServer, {
  serveClient: true,
  transports: ["websocket", "polling"],
})
const candleBuilder = createLiveCandleBuilder({
  store: candles,
  io,
  indexSymbols,
  onError: (symbol, error) => {
    candleCapture.error = `Candle storage error for ${symbol}: ${error.message}`
    emitControlStatus()
  },
})

let feed = null
let trading = null
let startPromise = null
let marketOpenTimer = null
let historyCandlePollTimer = null
let armedPreparation = null
let positionsBroker = null
let positionsBrokerToken = null
let positionsOrderBook = { token: null, at: 0, orders: [] }
const candleCapture = {
  priceTicks: 0,
  candleUpdates: 0,
  lastPriceAt: null,
  error: null,
}
let directionalShares = {
  state: "waiting",
  message: "Waiting for the market stream to start.",
  updatedAt: null,
  data: null,
}
let directionalSharesTimer = null
let directionalSharesRunning = false
let directionalSharesCutoffTime = null
let directionalSharesCutoffRevision = 0
let directionalSharesRescanPending = false
let directionalSharesChild = null
let directionalSharesScanCutoffTime = null
const liveSignalScanners = {
  askAbsorption: { key: "askAbsorption", title: "Ask absorption volume", script: "scan-ask-absorption-volume.js", until: "09:45", earliest: "09:20", timer: null, running: false, child: null, state: "waiting", message: "Waiting for market stream.", data: { buy: [], sell: [] }, updatedAt: null },
}
let engineStatus = state(
  "stopped",
  "Market stream is stopped. Use Start Server when ready.",
)
let authStatus = state(
  hasToken() ? "ready" : "required",
  hasToken() ? "Saved FYERS token found" : "AutoLogin required",
)

const preloader = createHistoryPreloader({
  appId: CONSTANT.appId,
  getAccessToken: accessToken,
  stocks: marketSymbols,
  store: candles,
  label: "stocks and NIFTY 50",
  symbolFormatter: (symbol) =>
    indexSymbols.includes(symbol)
      ? toFyersIndexSymbol(symbol)
      : toFyersSymbol(symbol),
  refreshConcurrency: historyRefreshConcurrency,
  refreshWorkerDelayMs: historyRefreshWorkerDelayMs,
  onStatus: (status) => {
    io.emit("history:status", status)
    if (status.state === "complete" || status.state === "partial") {
      void stockSnapshot()
        .then((snapshot) => io.emit("stocks:snapshot", snapshot))
        .catch((error) => {
          console.error("Cannot refresh stored stock prices:", error.message)
        })
    }
  },
})

function state(status, message) {
  return { state: status, message, updatedAt: new Date().toISOString() }
}

function currentIstCutoff(now = Date.now()) {
  const shifted = new Date(now + 330 * 60_000).toISOString()
  return `${shifted.slice(0, 10)}T${shifted.slice(11, 16)}`
}

function effectiveDirectionalCutoff() {
  const current = currentIstCutoff()
  return directionalSharesCutoffTime
    ? `${current.slice(0, 10)}T${directionalSharesCutoffTime}`
    : current
}

function directionalSharesPayload() {
  return {
    ...directionalShares,
    cutoffMode: directionalSharesCutoffTime ? "fixed" : "live",
    selectedCutoffTime: directionalSharesCutoffTime,
    scanCutoffTime: directionalSharesScanCutoffTime,
  }
}

function emitDirectionalShares() {
  io.emit("opening:directional-shares", directionalSharesPayload())
}

async function refreshDirectionalShares() {
  if (directionalSharesRunning || !feed) return
  directionalSharesRunning = true
  const cutoffRevision = directionalSharesCutoffRevision
  const cutoff = effectiveDirectionalCutoff()
  directionalSharesScanCutoffTime = cutoff.slice(11, 16)
  directionalShares = {
    ...directionalShares,
    state: "scanning",
    message: `Scanning cutoff ${directionalSharesScanCutoffTime} IST · starting...`,
    updatedAt: new Date().toISOString(),
  }
  emitDirectionalShares()
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(
            rootDirectory,
            "scripts",
            "scan-opening-directional-shares.js",
          ),
          "--cutoff-datetime",
          cutoff,
          "--min-depth-minutes",
          "3",
          "--json=true",
        ],
        { cwd: rootDirectory, stdio: ["ignore", "pipe", "pipe"] },
      )
      directionalSharesChild = child
      let output = "",
        pending = "",
        errorOutput = ""
      const publishProgress = (text) => {
        const match = text.match(/Scanning \[\d+\/\d+\] .+\.\.\./)
        if (!match) return
        directionalShares = {
          ...directionalShares,
          state: "scanning",
          message: `Cutoff ${directionalSharesScanCutoffTime} IST · ${match[0]}`,
          updatedAt: new Date().toISOString(),
        }
        emitDirectionalShares()
      }
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString()
        output += text
        pending += text
        const parts = pending.split(/[\r\n]/)
        pending = parts.pop() || ""
        for (const part of parts) publishProgress(part)
      })
      child.stderr.on("data", (chunk) => {
        errorOutput += chunk.toString()
      })
      child.on("error", reject)
      child.on("close", (code, signal) => {
        if (directionalSharesChild === child) directionalSharesChild = null
        if (pending) publishProgress(pending)
        if (code === 0) resolve(output)
        else {
          const lines = errorOutput
            .trim()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
          const detail =
            lines.find((line) => /^\w*Error(?:\s|:)/.test(line)) || lines.at(-1)
          reject(
            new Error(
              detail || `Scanner exited with ${signal || `code ${code}`}.`,
            ),
          )
        }
      })
      const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000)
      child.on("close", () => clearTimeout(timeout))
    })
    const jsonStart = stdout.indexOf('{"date":')
    if (jsonStart < 0) throw new Error("Scanner did not return a result.")
    const result = JSON.parse(stdout.slice(jsonStart))
    if (cutoffRevision !== directionalSharesCutoffRevision) return
    const byBehaviour = new Map(result.table.map((row) => [row.Behaviour, row]))
    const total = byBehaviour.get("TOTAL (sum of differences)")
    const lastFiveTotal = result.lastFiveTable?.find(
      (row) => row.Behaviour === "TOTAL (sum of differences)",
    )
    const lastFifteenTotal = result.lastFifteenTable?.find(
      (row) => row.Behaviour === "TOTAL (sum of differences)",
    )
    if (!total) throw new Error("Scanner result is missing totals.")
    if (!feed) return
    directionalShares = {
      state: "ready",
      message: `High-volume opening shares through ${result.cutoffTime} IST`,
      updatedAt: new Date().toISOString(),
      data: {
        cutoffTime: result.cutoffTime,
        analyzed: result.analyzed,
        bullish: total.Bullish,
        bearish: total.Bearish,
        difference: total.Difference,
        lastFiveAnalyzed: result.lastFiveAnalyzed || 0,
        lastFiveBullish: lastFiveTotal?.Bullish || "—",
        lastFiveBearish: lastFiveTotal?.Bearish || "—",
        lastFiveDifference: lastFiveTotal?.Difference || "—",
        lastFifteenBullish: lastFifteenTotal?.Bullish || "—",
        lastFifteenBearish: lastFifteenTotal?.Bearish || "—",
        lastFifteenDifference: lastFifteenTotal?.Difference || "—",
      },
    }
  } catch (error) {
    if (cutoffRevision !== directionalSharesCutoffRevision) return
    directionalShares = {
      state: "waiting",
      message: `Opening shares unavailable: ${error.message}`,
      updatedAt: new Date().toISOString(),
      data: directionalShares.data,
    }
  } finally {
    directionalSharesRunning = false
    emitDirectionalShares()
    if (directionalSharesRescanPending && feed) {
      directionalSharesRescanPending = false
      void refreshDirectionalShares()
    }
  }
}

function scheduleDirectionalShares() {
  if (directionalSharesTimer) clearTimeout(directionalSharesTimer)
  directionalSharesTimer = null
  if (directionalSharesCutoffTime) return
  const delay = 3_000 + 60_000 - (Date.now() % 60_000)
  directionalSharesTimer = setTimeout(() => {
    void refreshDirectionalShares().finally(scheduleDirectionalShares)
  }, delay)
}

function startDirectionalShares() {
  void refreshDirectionalShares()
  scheduleDirectionalShares()
}

function stopDirectionalShares(
  message = "Waiting for the market stream to start.",
) {
  if (directionalSharesTimer) clearTimeout(directionalSharesTimer)
  directionalSharesTimer = null
  directionalSharesRescanPending = false
  directionalShares = {
    state: "waiting",
    message,
    updatedAt: new Date().toISOString(),
    data: null,
  }
  emitDirectionalShares()
}

function liveSignalScannersPayload() {
  return Object.fromEntries(Object.entries(liveSignalScanners).map(([key, scanner]) => [key, {
    title: scanner.title, until: scanner.until, state: scanner.state, message: scanner.message,
    buy: scanner.data.buy, sell: scanner.data.sell, updatedAt: scanner.updatedAt,
  }]))
}

function emitLiveSignalScanners() {
  io.emit("signals:live-scanners", liveSignalScannersPayload())
}

function mergeEarliestSignals(report) {
  const candidates = [
    ...(Array.isArray(report?.buySignals) ? report.buySignals.map((row) => ({ ...row, side: "BUY" })) : []),
    ...(Array.isArray(report?.sellSignals) ? report.sellSignals.map((row) => ({ ...row, side: "SELL" })) : []),
  ].filter((row) => row.Stock && row["Known at"])
  candidates.sort((left, right) => String(left["Known at"]).localeCompare(String(right["Known at"])) || String(left.Stock).localeCompare(String(right.Stock)))
  const seen = new Set(), selected = []
  for (const row of candidates) {
    if (seen.has(row.Stock)) continue
    seen.add(row.Stock)
    selected.push({ stock: row.Stock, side: row.side, signalTime: row["Known at"], entryTime: row["Next completed entry at"] || null, window: row.Window || row.Reversal || null })
  }
  selected.sort((left, right) => left.signalTime.localeCompare(right.signalTime) || left.stock.localeCompare(right.stock))
  return { buy: selected.filter((row) => row.side === "BUY"), sell: selected.filter((row) => row.side === "SELL") }
}

async function refreshLiveSignalScanner(scanner) {
  if (scanner.running || !feed) return
  const cutoff = currentIstCutoff(), date = cutoff.slice(0, 10), minute = cutoff.slice(11, 16)
  if (minute < scanner.earliest) return
  if (minute > scanner.until) {
    scanner.state = "complete"; scanner.message = `Final signals through ${scanner.until} IST`; scanner.updatedAt = new Date().toISOString(); emitLiveSignalScanners(); return
  }
  scanner.running = true; scanner.state = "scanning"; scanner.message = `Scanning through ${minute} IST...`; scanner.updatedAt = new Date().toISOString(); emitLiveSignalScanners()
  try {
    const output = await new Promise((resolve, reject) => {
      const args = [path.join(rootDirectory, "scripts", scanner.script), `${date}T${minute}:00+05:30`]
      const child = spawn(process.execPath, args, { cwd: rootDirectory, stdio: ["ignore", "pipe", "pipe"] })
      scanner.child = child
      let stdout = "", stderr = ""
      child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
      child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
      child.on("error", reject)
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || `Scanner exited with code ${code}.`)))
      const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000)
      child.on("close", () => clearTimeout(timeout))
    })
    const match = String(output).match(/report:\s*(.+\.json)/)
    if (!match) throw new Error("Scanner report path was not returned.")
    const report = JSON.parse(await readFile(match[1].trim(), "utf8"))
    scanner.data = mergeEarliestSignals(report); scanner.state = "ready"; scanner.message = `${scanner.data.buy.length + scanner.data.sell.length} earliest signals through ${minute} IST`; scanner.updatedAt = new Date().toISOString()
  } catch (error) {
    scanner.state = "error"; scanner.message = `${scanner.title} unavailable: ${error.message}`; scanner.updatedAt = new Date().toISOString()
  } finally {
    scanner.running = false; scanner.child = null; emitLiveSignalScanners()
  }
}

function scheduleLiveSignalScanner(scanner) {
  if (scanner.timer) clearTimeout(scanner.timer)
  if (currentIstCutoff().slice(11, 16) > scanner.until) {
    void refreshLiveSignalScanner(scanner)
    return
  }
  const delay = 3_000 + 60_000 - (Date.now() % 60_000)
  scanner.timer = setTimeout(() => void refreshLiveSignalScanner(scanner).finally(() => scheduleLiveSignalScanner(scanner)), delay)
}

function startLiveSignalScanners() {
  for (const scanner of Object.values(liveSignalScanners)) { void refreshLiveSignalScanner(scanner); scheduleLiveSignalScanner(scanner) }
}

function stopLiveSignalScanners(message = "Waiting for market stream.") {
  for (const scanner of Object.values(liveSignalScanners)) {
    if (scanner.timer) clearTimeout(scanner.timer)
    scanner.timer = null; scanner.child?.kill("SIGTERM"); scanner.child = null; scanner.running = false
    scanner.state = "waiting"; scanner.message = message; scanner.data = { buy: [], sell: [] }; scanner.updatedAt = new Date().toISOString()
  }
  emitLiveSignalScanners()
}

function accessToken() {
  const value = getFromStorage("token")
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function hasToken() {
  return Boolean(accessToken())
}

function brokerForPositions() {
  const token = accessToken()
  if (!token) throw new Error("Run AutoLogin before loading positions.")
  if (!positionsBroker || positionsBrokerToken !== token) {
    positionsBroker = createBroker({
      appId: CONSTANT.appId,
      token,
      timeoutMs: DEPTH_TREND.apiTimeoutMs,
    })
    positionsBrokerToken = token
  }
  return positionsBroker
}

async function filledOrdersForPositions() {
  const token = accessToken()
  if (!token) return []
  if (positionsOrderBook.token === token && Date.now() - positionsOrderBook.at < 15_000)
    return positionsOrderBook.orders
  const result = await brokerForPositions().orders()
  if (result?.s !== "ok" || !Array.isArray(result.orderBook)) return []
  positionsOrderBook = { token, at: Date.now(), orders: result.orderBook }
  return positionsOrderBook.orders
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizePosition(item) {
  const symbol = String(item?.symbol || "").trim()
  const quantity = finiteNumber(item?.netQty ?? item?.qty) || 0
  const buyQuantity =
    finiteNumber(item?.buyQty ?? item?.buyQuantity ?? item?.dayBuyQty) || 0
  const sellQuantity =
    finiteNumber(item?.sellQty ?? item?.sellQuantity ?? item?.daySellQty) || 0
  const averagePrice = finiteNumber(
    item?.netAvg ?? item?.avgPrice ?? item?.buyAvg ?? item?.sellAvg,
  )
  const lastPrice = finiteNumber(item?.ltp ?? item?.lastTradedPrice)
  const realizedProfit =
    finiteNumber(item?.realized_profit ?? item?.realizedProfit) || 0
  const unrealizedProfit = finiteNumber(
    item?.unrealized_profit ?? item?.unrealizedProfit,
  )
  const reportedProfit = finiteNumber(item?.pl ?? item?.profit)
  const calculatedProfit =
    averagePrice !== null && lastPrice !== null
      ? (lastPrice - averagePrice) * quantity
      : 0
  const profit =
    reportedProfit ??
    (unrealizedProfit !== null
      ? realizedProfit + unrealizedProfit
      : calculatedProfit)
  return {
    symbol,
    stock: symbol.replace(/^NSE:/, "").replace(/-EQ$/, ""),
    quantity,
    averagePrice,
    lastPrice,
    profit,
    isOpen: quantity !== 0,
    hasDayActivity: buyQuantity !== 0 || sellQuantity !== 0,
    productType: String(item?.productType || ""),
    side: quantity === 0 ? "EXITED" : quantity < 0 ? "SELL" : "BUY",
    entryAt: brokerTimestamp(item?.entryTime ?? item?.orderDateTime ?? item?.createdAt),
  }
}

async function readNifty50Candles(limit = 360) {
  if (
    nifty50HistoryCache &&
    Date.now() - nifty50HistoryCache.at < NIFTY_HISTORY_CACHE_MS
  ) {
    return nifty50HistoryCache.candles.slice(
      -Math.max(1, Math.min(5000, Number(limit) || 360)),
    )
  }
  const token = accessToken()
  if (!token)
    throw new Error("Run AutoLogin before loading the NIFTY 50 chart.")
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token)
  const now = Math.floor(Date.now() / 1000)
  const response = await client.getHistory({
    symbol: "NSE:NIFTY50-INDEX",
    resolution: "1",
    date_format: "0",
    range_from: String(now - 21 * 24 * 60 * 60),
    range_to: String(now),
    cont_flag: "1",
  })
  if (response?.s !== "ok" || !Array.isArray(response.candles)) {
    throw new Error(
      response?.message ||
        response?.msg ||
        "FYERS returned no NIFTY 50 candle data.",
    )
  }
  const candles = response.candles
    .flatMap((row) => {
      if (!Array.isArray(row) || row.length < 6) return []
      const candle = {
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Math.max(0, Math.trunc(Number(row[5]) || 0)),
        source: "fyers-history",
      }
      const prices = [candle.open, candle.high, candle.low, candle.close]
      if (
        !Number.isSafeInteger(candle.time) ||
        !prices.every((price) => Number.isFinite(price) && price > 0) ||
        candle.high < Math.max(candle.open, candle.close) ||
        candle.low > Math.min(candle.open, candle.close)
      )
        return []
      const india = new Date(candle.time * 1000 + 330 * 60_000)
      const weekday = india.getUTCDay()
      const minute = india.getUTCHours() * 60 + india.getUTCMinutes()
      return weekday >= 1 &&
        weekday <= 5 &&
        minute >= 9 * 60 + 15 &&
        minute < 15 * 60 + 30
        ? [candle]
        : []
    })
    .sort((left, right) => left.time - right.time)
  nifty50HistoryCache = { at: Date.now(), candles }
  return candles.slice(-Math.max(1, Math.min(5000, Number(limit) || 360)))
}

async function stockSnapshot() {
  const storedQuotes = await Promise.all(
    stocks.map(async (symbol) => {
      const recent = candles.readLatest
        ? await candles.readLatest(symbol, { limit: 2 })
        : await candles.read(symbol, { limit: 2 })
      const latest = recent.at(-1)
      const previous = recent.at(-2)
      if (!latest)
        return {
          symbol,
          price: null,
          change: null,
          changePercent: null,
          updatedAt: null,
        }

      const change = previous ? latest.close - previous.close : null
      return {
        symbol,
        price: latest.close,
        change,
        changePercent: previous?.close ? (change / previous.close) * 100 : null,
        updatedAt: new Date(latest.time * 1000).toISOString(),
      }
    }),
  )

  const liveQuotes = new Map(
    (feed?.snapshot() || []).map((quote) => [quote.symbol, quote]),
  )
  return storedQuotes.map((stored) => {
    const live = liveQuotes.get(stored.symbol)
    return Number.isFinite(live?.price) ? { ...stored, ...live } : stored
  })
}

function controlStatus() {
  const stream = feed?.getStatus() || engineStatus
  const runningState = [
    "armed",
    "starting",
    "connecting",
    "live",
    "reconnecting",
  ].includes(stream.state)
  const hasLiveSocket = stream.state === "live" && stream.connected
  const outsideSession = stream.state === "armed"
  const depthError =
    stream.state === "error" || stream.state === "reconnecting"
      ? stream.message
      : stream.optionDepth?.storageError || null
  const candleError =
    candleCapture.error ||
    (stream.state === "error" || stream.state === "reconnecting"
      ? stream.message
      : null)
  return {
    auth: { ...authStatus, tokenPresent: hasToken() },
    history: preloader.status(),
    server: stream,
    capture: {
      server: {
        state: outsideSession ? "live" : stream.state,
        message: outsideSession
          ? stream.message
          : stream.state === "live"
            ? "Server running · FYERS WebSocket connected"
            : stream.message,
      },
      depth: {
        state: outsideSession
          ? "waiting"
          : !runningState
            ? stream.state === "error"
              ? "error"
              : "stopped"
            : depthError
              ? "error"
              : !hasLiveSocket
                ? stream.state
                : stream.received?.depth
                  ? "receiving"
                  : "waiting",
        message: outsideSession
          ? "Prepared and waiting for the scheduled 09:15 IST WebSocket start"
          : !runningState
            ? stream.message
            : depthError
              ? depthError
              : !hasLiveSocket
                ? stream.message
                : stream.received?.depth
                  ? `WebSocket receiving cash depth updates · ${stream.received.depth} stock updates · last ${stream.lastDepthAt || "unknown"}`
                  : "WebSocket connected and depth subscribed · waiting for first depth update",
        stockUpdates: stream.received?.depth || 0,
        optionUpdates: stream.optionDepth?.received || 0,
      },
      candles: {
        state: depthOnlyMode
          ? "disabled"
          : outsideSession
            ? "waiting"
            : !runningState
              ? stream.state === "error"
                ? "error"
                : "stopped"
              : candleError
                ? "error"
                : !hasLiveSocket
                  ? stream.state
                  : candleCapture.priceTicks
                    ? "receiving"
                    : "waiting",
        message: depthOnlyMode
          ? "Disabled: server is recording WebSocket cash depth only"
          : outsideSession
            ? "Candle capture prepared and waiting for the scheduled 09:15 IST start"
            : !runningState
              ? stream.message
              : candleError
                ? candleError
                : !hasLiveSocket
                  ? stream.message
                  : candleCapture.priceTicks
                    ? `WebSocket receiving stock price ticks · ${candleCapture.priceTicks} ticks · ${candleCapture.candleUpdates} candle updates`
                    : "WebSocket connected · waiting for valid stock price ticks",
        priceTicks: candleCapture.priceTicks,
        candleUpdates: candleCapture.candleUpdates,
        lastPriceAt: candleCapture.lastPriceAt,
      },
    },
    stocks: stocks.length,
    database: { sizeBytes: dbSizeBytes, updatedAt: dbSizeUpdatedAt },
    orderMode: CONSTANT.flgPlaceOptionOrder
      ? "live-options"
      : CONSTANT.flgPlaceCashOrder
        ? "live-cash"
        : "paper",
  }
}

function emitControlStatus() {
  io.emit("control:status", controlStatus())
}

function stopHistoryCandlePolling() {
  if (historyCandlePollTimer) clearTimeout(historyCandlePollTimer)
  historyCandlePollTimer = null
}

function scheduleHistoryCandlePolling() {
  if (!depthOnlyMode || !feed || historyCandlePollTimer) return
  const now = Date.now()
  const nextCompletedMinute = (Math.floor(now / 60_000) + 1) * 60_000
  historyCandlePollTimer = setTimeout(async () => {
    historyCandlePollTimer = null
    try {
      await preloader.refreshAllCurrentSession(stocks)
    } catch (error) {
      console.error("Cannot refresh History API candles:", error.message)
    }
    // The 15:30 cycle collects the final 15:29 candle, then polling stops.
    if (feed && isWithinLiveMarketSession()) scheduleHistoryCandlePolling()
  }, Math.max(0, nextCompletedMinute + historyRefreshOffsetMs - now))
  historyCandlePollTimer.unref?.()
}

function startHistoryCandlePolling() {
  if (!depthOnlyMode || !feed) return
  stopHistoryCandlePolling()
  scheduleHistoryCandlePolling()
  const india = new Date(Date.now() + 330 * 60_000)
  const sessionMinute = india.getUTCHours() * 60 + india.getUTCMinutes()
  // A late start should not wait for the next minute boundary: immediately
  // merge every completed current-session candle already exposed by FYERS.
  // At exactly 09:15 there is nothing completed yet, so avoid 215 empty calls.
  if (sessionMinute > 9 * 60 + 15) {
    void preloader.refreshAllCurrentSession(stocks).catch((error) => {
      console.error("Cannot perform initial History API candle sync:", error.message)
    })
  }
}

async function disposeFailedEngine() {
  if (!feed || feed.getStatus().state !== "error") return false
  await stopMarketEngine("Previous failed market stream was cleared")
  return true
}

async function stopMarketEngine(message = "Market stream stopped") {
  if (marketOpenTimer) clearTimeout(marketOpenTimer)
  marketOpenTimer = null
  stopHistoryCandlePolling()
  const preparation = armedPreparation
  armedPreparation = null
  engineStatus = state("stopping", "Stopping market streams and strategy...")
  emitControlStatus()
  if (!depthOnlyMode) {
    candleBuilder.reset()
  }
  const currentFeed = feed
  const currentTrading = trading
  feed = null
  trading = null
  await currentFeed?.stop()
  await currentTrading?.close()
  stopDirectionalShares(message)
  stopLiveSignalScanners(message)
  if (preparation) {
    const prepared = await preparation.catch(() => null)
    if (prepared?.trading !== currentTrading) await prepared?.trading?.close()
  }
  engineStatus = state("stopped", message)
  io.emit("stocks:snapshot", await stockSnapshot())
  io.emit("feed:status", engineStatus)
  emitControlStatus()
}

app.disable("x-powered-by")
app.use(express.json({ limit: "16kb" }))
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.setHeader("X-Frame-Options", "DENY")
  next()
})
app.use("/api/control", (request, response, next) => {
  if (request.method !== "POST" || !request.headers.origin) return next()
  try {
    if (new URL(request.headers.origin).host === request.headers.host)
      return next()
  } catch {
    // Invalid origins are rejected below.
  }
  response.status(403).json({
    ok: false,
    message: "Cross-origin control requests are not allowed.",
  })
})

app.get("/api/control/status", (_request, response) =>
  response.json(controlStatus()),
)
app.get("/api/opening-directional-shares", (_request, response) => {
  response.setHeader("Cache-Control", "no-store")
  response.json(directionalSharesPayload())
})

let manualCandleDepthRunning = false
async function latestCompletedStockCandleCutoff(now = Date.now()) {
  const latest = await Promise.all(stocks.map(async (stock) => {
    const recent = await candles.readLatest(stock, { limit: 2 })
    return Math.max(0, ...recent.map(({ time }) => (time + 60) * 1000).filter((end) => end <= now))
  }))
  const end = Math.max(0, ...latest)
  return end ? currentIstCutoff(end) : null
}

app.post("/api/control/candle-depth-scan", async (request, response) => {
  if (manualCandleDepthRunning)
    return response.status(409).json({ message: "A candle-depth scan is already running." })

  const requestedTime = request.body?.cutoffTime
  if (requestedTime != null && requestedTime !== "" &&
      (typeof requestedTime !== "string" || !/^\d{2}:[0-5]\d$/.test(requestedTime) ||
        requestedTime < "09:16" || requestedTime > "15:30"))
    return response.status(400).json({ message: "Enter a cutoff between 09:16 and 15:30 IST." })

  manualCandleDepthRunning = true
  let latestCutoff
  try {
    latestCutoff = await latestCompletedStockCandleCutoff()
  } catch (error) {
    manualCandleDepthRunning = false
    console.error("Could not find the latest completed stock candle:", error.message)
    return response.status(500).json({ message: "Could not read the latest stored candles." })
  }
  if (!latestCutoff) {
    manualCandleDepthRunning = false
    return response.status(404).json({ message: "No completed stock candles are stored." })
  }
  if (requestedTime && requestedTime > latestCutoff.slice(11)) {
    manualCandleDepthRunning = false
    return response.status(400).json({ message: `Latest completed candle is at ${latestCutoff.replace("T", " ")} IST.` })
  }
  const cutoff = requestedTime ? `${latestCutoff.slice(0, 10)}T${requestedTime}` : latestCutoff
  const script = path.join(rootDirectory, "scripts", "scan-two-setup-candle-depth.js")
  execFile(process.execPath, [script, cutoff, "--json"], {
    cwd: rootDirectory, timeout: 180_000, windowsHide: true,
  }, (error, stdout) => {
    manualCandleDepthRunning = false
    if (error) {
      console.error("Manual candle-depth scan failed:", error.message)
      return response.status(500).json({ message: error.killed ? "Scan timed out." : "Candle-depth scan failed." })
    }
    try {
      const result = JSON.parse(stdout)
      const label = `${cutoff.replace("T", " ")} IST`
      const message = !result.depthReady
        ? `${label} · Scan needs 15 minutes of today's depth (from 09:30 IST)`
        : result.evaluatedDepth
          ? `${label} · ${result.evaluatedDepth} books checked${result.buyReady ? "" : " · Insufficient BUY candle history"}`
          : `No usable depth at ${label}`
      return response.json({ ...result, message })
    } catch (parseError) {
      console.error("Manual candle-depth scan returned invalid output:", parseError.message)
      return response.status(500).json({ message: "Could not read scan results." })
    }
  })
})

app.post("/api/control/opening-cutoff", (request, response) => {
  const raw = request.body?.cutoffTime
  const cutoffTime = raw == null || raw === "" ? null : String(raw)
  if (cutoffTime && !/^\d{2}:\d{2}$/.test(cutoffTime))
    return response
      .status(400)
      .json({ ok: false, message: "Cutoff time must use HH:mm." })
  const currentTime = currentIstCutoff().slice(11, 16)
  if (cutoffTime && (cutoffTime <= "09:15" || cutoffTime > "15:30"))
    return response.status(400).json({
      ok: false,
      message: "Choose a cutoff from 09:16 through 15:30 IST.",
    })
  if (cutoffTime && cutoffTime > currentTime)
    return response.status(400).json({
      ok: false,
      message: `Cutoff cannot be later than the current time (${currentTime} IST).`,
    })

  directionalSharesCutoffTime = cutoffTime
  directionalSharesCutoffRevision += 1
  if (directionalSharesTimer) clearTimeout(directionalSharesTimer)
  directionalSharesTimer = null
  if (feed) {
    if (directionalSharesRunning) {
      directionalSharesRescanPending = true
      directionalSharesChild?.kill("SIGTERM")
    } else void refreshDirectionalShares()
    scheduleDirectionalShares()
  }
  emitDirectionalShares()
  response.json({
    ok: true,
    message: cutoffTime
      ? `Opening cutoff set to ${cutoffTime} IST.`
      : "Opening cutoff restored to current time.",
    status: directionalSharesPayload(),
  })
})

app.post("/api/control/autologin", async (_request, response) => {
  await disposeFailedEngine()
  if (feed || startPromise || engineStatus.state === "armed") {
    response.status(409).json({
      ok: false,
      message:
        "The market engine is already running. Restart the app before replacing its FYERS session.",
    })
    return
  }
  if (authStatus.state === "running") {
    response
      .status(409)
      .json({ ok: false, message: "AutoLogin is already running." })
    return
  }
  authStatus = state("running", "Starting FYERS AutoLogin...")
  emitControlStatus()
  try {
    const result = await autoLogin({
      nonInteractive: true,
      onProgress: ({ step, total, message }) => {
        authStatus = { ...state("running", message), step, total }
        emitControlStatus()
      },
    })
    authStatus = state("complete", result.message)
    emitControlStatus()
    response.json({ ok: true, status: authStatus })
  } catch (error) {
    authStatus = state("error", formatAutoLoginError(error))
    emitControlStatus()
    response.status(502).json({ ok: false, message: authStatus.message })
  }
})

app.post("/api/control/pre-candles", (_request, response) => {
  if (!hasToken()) {
    response
      .status(400)
      .json({ ok: false, message: "Run AutoLogin before fetching candles." })
    return
  }
  const result = preloader.start()
  emitControlStatus()
  response
    .status(result.accepted ? 202 : 409)
    .json({ ok: result.accepted, ...result })
})

async function prepareMarketEngine() {
  CONSTANT.access_token = accessToken()
  await depthHistory.prepareStocks(stocks)
  const nextTrading = depthOnlyMode
    ? null
    : await createTradingRuntime({
        rootDirectory,
        constants: CONSTANT,
        config: DEPTH_TREND,
        history,
      })
  const nextFeed = createMarketFeed({
    io,
    stocks,
    indexSymbols,
    clientId: process.env.FYERS_CLIENT_ID,
    accessToken: CONSTANT.access_token,
    history,
    depthHistory,
    capturePrices: !depthOnlyMode,
    onMarket: (kind, data, at) => {
      if (depthOnlyMode) return
      const marketName = toMarketName(data?.symbol)
      const isStock = stocks.includes(marketName)
      if (isStock) nextTrading.observe(kind, data, at)
      if (kind === "price") {
        candleCapture.priceTicks++
        if (!isStock) {
          if (candleBuilder.observe(data, at)) candleCapture.candleUpdates++
          return
        }
        candleCapture.lastPriceAt =
          at instanceof Date ? at.toISOString() : new Date(at).toISOString()
        if (candleBuilder.observe(data, at)) candleCapture.candleUpdates++
      }
    },
    onGap: () => {
      nextTrading?.reset()
      if (!depthOnlyMode) candleBuilder.reset()
    },
    onReady: () => {
      nextTrading?.ready()
    },
  })
  return { trading: nextTrading, feed: nextFeed }
}

async function launchMarketEngine() {
  if (feed) return controlStatus()
  if (startPromise) return startPromise
  if (!hasToken())
    throw new Error("Run AutoLogin before starting the market server.")
  if (!isWithinLiveMarketSession())
    throw new Error(
      "Scheduled market start was reached outside NSE live hours.",
    )
  if (marketOpenTimer) clearTimeout(marketOpenTimer)
  marketOpenTimer = null
  engineStatus = state(
    "starting",
    depthOnlyMode
      ? "Starting WebSocket cash-depth recording..."
      : "Loading trading metadata and starting streams...",
  )
  candleCapture.priceTicks = 0
  candleCapture.candleUpdates = 0
  candleCapture.lastPriceAt = null
  candleCapture.error = null
  if (!depthOnlyMode) candleBuilder.reset()
  emitControlStatus()
  startPromise = (async () => {
    const preparation = armedPreparation
    armedPreparation = null
    const prepared = preparation
      ? await preparation
      : await prepareMarketEngine()
    const nextTrading = prepared.trading
    const nextFeed = prepared.feed
    trading = nextTrading
    feed = nextFeed
    if (!feed.start())
      throw new Error(
        feed.getStatus().message || "Unable to start FYERS market feed",
      )
    if (depthOnlyMode) startHistoryCandlePolling()
    else preloader.startSessionBackfill()
    engineStatus = feed.getStatus()
    startDirectionalShares()
    startLiveSignalScanners()
    emitControlStatus()
    return controlStatus()
  })()
  try {
    return await startPromise
  } catch (error) {
    engineStatus = state("error", error.message)
    if (trading) await trading.close().catch(() => {})
    trading = null
    feed = null
    emitControlStatus()
    throw error
  } finally {
    startPromise = null
  }
}

function armMarketOpen(now = Date.now()) {
  if (marketOpenTimer) clearTimeout(marketOpenTimer)
  const scheduledForMs = nextMarketOpen(now)
  const scheduledFor = new Date(scheduledForMs).toISOString()
  engineStatus = {
    ...state(
      "armed",
      depthOnlyMode
        ? `WebSocket cash-depth recording starts at ${formatIstDateTime(scheduledForMs)}`
        : `Preparing data now; WebSocket and candle capture start at ${formatIstDateTime(scheduledForMs)}`,
    ),
    scheduledFor,
  }
  const preparation = prepareMarketEngine()
  armedPreparation = preparation
  preparation.catch((error) => {
    if (armedPreparation !== preparation || engineStatus.state !== "armed")
      return
    armedPreparation = null
    if (marketOpenTimer) clearTimeout(marketOpenTimer)
    marketOpenTimer = null
    engineStatus = state(
      "error",
      `Cannot prepare scheduled market start: ${error.message}`,
    )
    emitControlStatus()
  })
  marketOpenTimer = setTimeout(
    () => {
      marketOpenTimer = null
      if (engineStatus.state !== "armed") return
      void launchMarketEngine().catch((error) => {
        engineStatus = state(
          "error",
          `Scheduled 09:15 start failed: ${error.message}`,
        )
        emitControlStatus()
      })
    },
    Math.max(0, scheduledForMs - Date.now()),
  )
  emitControlStatus()
  return scheduledForMs
}

app.post("/api/control/start", async (_request, response) => {
  await disposeFailedEngine()
  if (feed || engineStatus.state === "armed") {
    response.status(409).json({
      ok: false,
      message:
        engineStatus.state === "armed"
          ? "Market server is already armed for 09:15 IST."
          : "Market server is already started.",
      status: controlStatus(),
    })
    return
  }
  if (!hasToken()) {
    response.status(400).json({
      ok: false,
      message: "Run AutoLogin before starting the market server.",
    })
    return
  }
  if (startPromise) {
    response
      .status(409)
      .json({ ok: false, message: "Market server is already starting." })
    return
  }
  if (!isWithinLiveMarketSession()) {
    try {
      const scheduledForMs = armMarketOpen()
      response.status(202).json({
        ok: true,
        message: `WebSocket and candle capture armed for ${formatIstDateTime(scheduledForMs)}.`,
        status: controlStatus(),
      })
    } catch (error) {
      engineStatus = state("error", error.message)
      emitControlStatus()
      response.status(500).json({ ok: false, message: error.message })
    }
    return
  }
  try {
    await launchMarketEngine()
    response.status(202).json({
      ok: true,
      message: "Market server is starting.",
      status: controlStatus(),
    })
  } catch (error) {
    response.status(500).json({ ok: false, message: error.message })
  }
})

app.post("/api/control/stop", async (_request, response) => {
  if (startPromise) await startPromise.catch(() => {})
  if (!feed && !trading && engineStatus.state !== "armed") {
    response.status(409).json({
      ok: false,
      message: "Market server is already stopped.",
      status: controlStatus(),
    })
    return
  }
  const strategy = trading?.status()
  const livePositions =
    strategy?.positions?.filter((position) => position.live) || []
  const livePending = strategy?.pending?.filter((order) => order.live) || []
  if (strategy?.busy || livePositions.length || livePending.length) {
    response.status(409).json({
      ok: false,
      message: strategy?.busy
        ? "Trading execution is currently busy. Wait for it to finish before stopping."
        : `Cannot stop while ${livePositions.length} live position(s) or ${livePending.length} live order(s) still require management.`,
    })
    return
  }
  try {
    await stopMarketEngine("Market stream stopped by dashboard")
    response.json({
      ok: true,
      message: "Market server stopped.",
      status: controlStatus(),
    })
  } catch (error) {
    engineStatus = state("error", `Unable to stop cleanly: ${error.message}`)
    emitControlStatus()
    response.status(500).json({ ok: false, message: engineStatus.message })
  }
})

app.get("/api/positions", async (_request, response) => {
  if (!hasToken()) {
    response
      .status(401)
      .json({ ok: false, message: "Run AutoLogin before loading positions." })
    return
  }
  try {
    const result = trading?.brokerPositions
      ? await trading.brokerPositions()
      : await brokerForPositions().positions()
    if (result?.s !== "ok" || !Array.isArray(result.netPositions)) {
      throw new Error(
        result?.message || result?.msg || "FYERS returned no position data.",
      )
    }
    let orders = []
    try {
      orders = await filledOrdersForPositions()
    } catch (error) {
      console.warn("Cannot load position order book:", error.message)
    }
    const positions = (await Promise.all(result.netPositions
      .map(normalizePosition)
      // FYERS keeps today's exited positions in this response with netQty 0.
      // Retain them for a correct day P&L; ignore untouched placeholders.
      .filter(
        (position) =>
          position.symbol &&
          (position.isOpen || position.hasDayActivity || position.profit !== 0),
      )
      .map(async (position) => {
        if (!position.isOpen || position.side !== "SELL") return position
        const startedAt = positionStartedAt(position, orders) ?? position.entryAt
        if (!startedAt) return { ...position, strategyExit: { state: "UNAVAILABLE", label: "Exit monitor needs entry time" } }
        try {
          const stockCandles = await candles.read(position.stock, { limit: 5_000 })
          return { ...position, startedAt, strategyExit: sellPositionExitStatus({ position, candles: stockCandles, startedAt }) }
        } catch (error) {
          return { ...position, startedAt, strategyExit: { state: "UNAVAILABLE", label: `Exit monitor unavailable: ${error.message}` } }
        }
      })))
      .sort(
        (left, right) =>
          right.profit - left.profit || left.symbol.localeCompare(right.symbol),
      )
    response.setHeader("Cache-Control", "no-store")
    response.json({
      ok: true,
      positions,
      totalProfit: positions.reduce(
        (total, position) => total + position.profit,
        0,
      ),
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    response.status(502).json({ ok: false, message: error.message })
  }
})

app.get("/api/candles/:symbol", async (request, response) => {
  const symbol = String(request.params.symbol || "")
    .trim()
    .toUpperCase()
  if (symbol === "NIFTY50") {
    try {
      response.json({
        ok: true,
        symbol,
        candles: await readNifty50Candles(request.query.limit),
      })
    } catch (error) {
      response.status(502).json({ ok: false, message: error.message })
    }
    return
  }
  if (!marketSymbols.includes(symbol)) {
    response
      .status(404)
      .json({ ok: false, message: "Unknown stock or sector-index symbol" })
    return
  }
  try {
    let refresh = null
    // Stock clicks request a best-effort current-session FYERS refresh before
    // reading the local JSONL cache. A refresh failure must not hide candles
    // that are already available locally (for example before AutoLogin).
    if (request.query.refresh === "1") {
      try {
        refresh = {
          ok: true,
          ...(await preloader.refreshCurrentSession(symbol)),
        }
      } catch (error) {
        refresh = { ok: false, message: error.message }
      }
    }
    const data = await candles.read(symbol, { limit: request.query.limit })
    response.json({ ok: true, symbol, candles: data, refresh })
  } catch (error) {
    response.status(500).json({ ok: false, message: error.message })
  }
})

app.get("/health", (_request, response) => {
  const recording = history.status()
  const depthRecording = depthHistory.status()
  const ok =
    (depthOnlyMode || recording.state === "recording") &&
    depthRecording.state !== "error"
  const stream = feed?.getStatus() || engineStatus
  response.status(ok ? 200 : 503).json({
    ok,
    stocks: stocks.length,
    serverStopped: !feed,
    feed: stream,
    recording,
    depthHistory: depthRecording,
    strategy: trading
      ? {
          ...trading.status(),
          detector: undefined,
          rankings: trading.rankings(),
        }
      : null,
  })
})

app.use(
  express.static(publicDirectory, {
    etag: true,
    // This is a local control surface. Always revalidate assets so the dashboard
    // cannot keep calling routes from an older server version after a restart.
    maxAge: 0,
  }),
)

app.get("*", (_request, response) =>
  response.sendFile(path.join(publicDirectory, "index.html")),
)

io.on("connection", (socket) => {
  void stockSnapshot()
    .then((snapshot) => socket.emit("stocks:snapshot", snapshot))
    .catch((error) => {
      console.error("Cannot load stored stock prices:", error.message)
      socket.emit(
        "stocks:snapshot",
        stocks.map((symbol) => ({
          symbol,
          price: null,
          change: null,
          changePercent: null,
          updatedAt: null,
        })),
      )
    })
  socket.emit("feed:status", feed?.getStatus() || engineStatus)
  socket.emit("control:status", controlStatus())
  socket.emit("history:status", preloader.status())
  socket.emit("opening:directional-shares", directionalSharesPayload())
  socket.emit("signals:live-scanners", liveSignalScannersPayload())
})

const statusTimer = setInterval(() => {
  emitControlStatus()
}, 2000)

const databaseSizeTimer = setInterval(async () => {
  try {
    dbSizeBytes = await directorySize(databaseDirectory)
    dbSizeUpdatedAt = new Date().toISOString()
    emitControlStatus()
  } catch (error) {
    console.error("Cannot calculate db/ folder size:", error.message)
  }
}, 60_000)

httpServer.listen(port, host, () => {
  console.log(`Market dashboard: http://${host}:${port}`)
  console.log(`Loaded ${stocks.length} unique stocks from db/stocks`)
  console.log("Market stream is stopped until Start Server is clicked.")
  if (depthOnlyMode)
    console.log(
      `Depth-only mode: WebSocket cash depth plus History API candles (${historyRefreshConcurrency} workers, ${historyRefreshOffsetMs}ms after minute close); WebSocket candle building and trading runtime disabled.`,
    )
  console.log(
    `Trading routes: cash=${CONSTANT.flgPlaceCashOrder}, options=${CONSTANT.flgPlaceOptionOrder}; both false = paper orders`,
  )
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(statusTimer)
  clearInterval(databaseSizeTimer)
  clearInterval(depthRetentionTimer)
  stopHistoryCandlePolling()
  if (directionalSharesTimer) clearTimeout(directionalSharesTimer)
  stopLiveSignalScanners("Market stream stopped.")
  if (marketOpenTimer) clearTimeout(marketOpenTimer)
  marketOpenTimer = null
  const preparation = armedPreparation
  armedPreparation = null
  candleBuilder.close()
  const deadline = setTimeout(() => {
    console.error(
      "Shutdown timed out; buffered market history may be incomplete.",
    )
    process.exit(1)
  }, 15000)
  try {
    await feed?.stop()
    await trading?.close()
    const prepared = await preparation?.catch(() => null)
    if (prepared?.trading !== trading) await prepared?.trading?.close()
    await Promise.all([
      history.close(),
      depthHistory.close(),
      new Promise((resolve) => io.close(resolve)),
    ])
    clearTimeout(deadline)
    process.exit(0)
  } catch (error) {
    console.error("Unable to flush market history:", error.message)
    process.exit(1)
  }
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
import "./error-log-bootstrap.cjs"
