import dotenv from "dotenv"
import express from "express"
import apiV3 from "fyers-api-v3"
import { createServer } from "node:http"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Server as SocketServer } from "socket.io"
import { autoLogin, formatAutoLoginError } from "../autologin.js"
import { CONSTANT, DEPTH_TREND } from "../constant.js"
import { getFromStorage } from "../utils.js"
import { createCandleStore, createHistoryPreloader, createLiveCandleBuilder } from "./candles.js"
import { loadStocks } from "./market-data.js"
import { createMarketFeed } from "./market-feed.js"
import { createMarketHistory } from "./market-history.js"
import { createMarketDepthHistory } from "./market-depth-history.js"
import { marketDepthSession } from "./market-depth.js"
import { createTradingRuntime } from "./trading/runtime.js"
import { createPersistentBidBreakout } from "./persistent-bid-breakout.js"
import { createEarlyDepthBreakout } from "./early-depth-breakout.js"
import { createBidSupportBreakout } from "./bid-support-breakout.js"
import { createBidRecoveryRadar } from "./bid-recovery-radar.js"
import { createStrategySignalStore } from "./strategy-signal-store.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDirectory = path.resolve(__dirname, "..")
const databaseDirectory = path.join(rootDirectory, "db")
const publicDirectory = path.join(__dirname, "public")
const environment = process.env.NODE_ENV || "production"
const envFile = environment === "production" ? ".env.production" : ".env"
dotenv.config({ path: path.join(rootDirectory, envFile) })
const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || "127.0.0.1"

async function directorySize(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const sizes = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return directorySize(entryPath)
    if (entry.isFile()) return (await stat(entryPath)).size
    return 0
  }))
  return sizes.reduce((total, size) => total + size, 0)
}

let dbSizeBytes = await directorySize(databaseDirectory)
let dbSizeUpdatedAt = new Date().toISOString()

const stocks = await loadStocks(path.join(rootDirectory, "db", "stocks"))
const history = await createMarketHistory({
  directory: path.resolve(rootDirectory, process.env.MARKET_HISTORY_DIR || "db/market-history"),
})
const depthHistory = await createMarketDepthHistory({
  directory: path.join(rootDirectory, "db", "cash-depth"),
})
history.record("recorder_start", { stocks: stocks.length })
await history.flush()
if (history.status().state === "error") throw new Error(history.status().error)

const candles = await createCandleStore({
  directory: path.join(rootDirectory, "db", "candles"),
  symbols: stocks,
})
const app = express()
const httpServer = createServer(app)
const io = new SocketServer(httpServer, {
  serveClient: true,
  transports: ["websocket", "polling"],
})
const signalStore = createStrategySignalStore(path.join(databaseDirectory, "strategy-signals", "persistent-bid-breakout"))
const earlySignalStore = createStrategySignalStore(path.join(databaseDirectory, "strategy-signals", "early-depth-breakout"))
const bidSupportSignalStore = createStrategySignalStore(path.join(databaseDirectory, "strategy-signals", "bid-support-breakout"))
const bidRecoverySignalStore = createStrategySignalStore(path.join(databaseDirectory, "strategy-signals", "bid-recovery-radar"))
let earlyRadar
let bidSupportRadar
let bidRecoveryRadar
function radarSnapshot() {
  return [...strategyRadar.snapshot(), ...earlyRadar.snapshot(), ...bidSupportRadar.snapshot(), ...bidRecoveryRadar.snapshot()]
    .sort((left, right) => Date.parse(right.time) - Date.parse(left.time))
}
function emitRadarSignals() {
  io.emit("strategy:signals", radarSnapshot())
}
const strategyRadar = createPersistentBidBreakout({
  initialSignals: signalStore.read(marketDepthSession().date),
  onUpdate: (signals, date) => {
    try { signalStore.save(date, signals) }
    catch (error) { console.error("Cannot save Strategy Radar signals:", error.message) }
    emitRadarSignals()
  },
})
earlyRadar = createEarlyDepthBreakout({
  initialSignals: earlySignalStore.read(marketDepthSession().date),
  onUpdate: (signals, date) => {
    try { earlySignalStore.save(date, signals) }
    catch (error) { console.error("Cannot save early breakout signals:", error.message) }
    emitRadarSignals()
  },
})
bidSupportRadar = createBidSupportBreakout({
  initialSignals: bidSupportSignalStore.read(marketDepthSession().date),
  onUpdate: (signals, date) => {
    try { bidSupportSignalStore.save(date, signals) }
    catch (error) { console.error("Cannot save bid support breakout signals:", error.message) }
    emitRadarSignals()
  },
})
bidRecoveryRadar = createBidRecoveryRadar({
  initialSignals: bidRecoverySignalStore.read(marketDepthSession().date),
  onUpdate: (signals, date) => {
    try { bidRecoverySignalStore.save(date, signals) }
    catch (error) { console.error("Cannot save bid recovery signals:", error.message) }
    emitRadarSignals()
  },
})
const candleBuilder = createLiveCandleBuilder({
  store: candles,
  io,
  onComplete: (symbol, candle) => {
    strategyRadar.observeCandle(symbol, candle)
    earlyRadar.observeCandle(symbol, candle)
    bidSupportRadar.observeCandle(symbol, candle)
    bidRecoveryRadar.observeCandle(symbol, candle)
  },
  onError: (symbol, error) => {
    candleCapture.error = `Candle storage error for ${symbol}: ${error.message}`
    emitControlStatus()
  },
})

let feed = null
let trading = null
let startPromise = null
const candleCapture = { priceTicks: 0, candleUpdates: 0, lastPriceAt: null, error: null }
let engineStatus = state("stopped", "Market stream is stopped. Use Start Server when ready.")
let authStatus = state(hasToken() ? "ready" : "required", hasToken() ? "Saved FYERS token found" : "AutoLogin required")

const preloader = createHistoryPreloader({
  appId: CONSTANT.appId,
  getAccessToken: accessToken,
  stocks,
  store: candles,
  onStatus: (status) => {
    io.emit("history:status", status)
    if (status.state === "complete" || status.state === "partial") {
      void stockSnapshot().then((snapshot) => io.emit("stocks:snapshot", snapshot)).catch((error) => {
        console.error("Cannot refresh stored stock prices:", error.message)
      })
    }
  },
})

function state(status, message) {
  return { state: status, message, updatedAt: new Date().toISOString() }
}

function accessToken() {
  const value = getFromStorage("token")
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function hasToken() {
  return Boolean(accessToken())
}

async function readNifty50Candles(limit = 360) {
  const token = accessToken()
  if (!token) throw new Error("Run AutoLogin before loading the NIFTY 50 chart.")
  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token)
  const now = Math.floor(Date.now() / 1000)
  const response = await client.getHistory({
    symbol: "NSE:NIFTY50-INDEX",
    resolution: "1",
    date_format: "0",
    range_from: String(now - 10 * 24 * 60 * 60),
    range_to: String(now),
    cont_flag: "1",
  })
  if (response?.s !== "ok" || !Array.isArray(response.candles)) {
    throw new Error(response?.message || response?.msg || "FYERS returned no NIFTY 50 candle data.")
  }
  const candles = response.candles.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return []
    const candle = {
      time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Math.max(0, Math.trunc(Number(row[5]) || 0)),
      source: "fyers-history",
    }
    const prices = [candle.open, candle.high, candle.low, candle.close]
    if (!Number.isSafeInteger(candle.time) || !prices.every((price) => Number.isFinite(price) && price > 0) ||
        candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) return []
    const india = new Date(candle.time * 1000 + 330 * 60_000)
    const weekday = india.getUTCDay()
    const minute = india.getUTCHours() * 60 + india.getUTCMinutes()
    return weekday >= 1 && weekday <= 5 && minute >= 9 * 60 + 15 && minute < 15 * 60 + 30 ? [candle] : []
  }).sort((left, right) => left.time - right.time)
  return candles.slice(-Math.max(1, Math.min(1000, Number(limit) || 360)))
}

async function stockSnapshot() {
  const storedQuotes = await Promise.all(stocks.map(async (symbol) => {
    const recent = await candles.read(symbol, { limit: 2 })
    const latest = recent.at(-1)
    const previous = recent.at(-2)
    if (!latest) return { symbol, price: null, change: null, changePercent: null, updatedAt: null }

    const change = previous ? latest.close - previous.close : null
    return {
      symbol,
      price: latest.close,
      change,
      changePercent: previous?.close ? (change / previous.close) * 100 : null,
      updatedAt: new Date(latest.time * 1000).toISOString(),
    }
  }))

  const liveQuotes = new Map((feed?.snapshot() || []).map((quote) => [quote.symbol, quote]))
  return storedQuotes.map((stored) => {
    const live = liveQuotes.get(stored.symbol)
    return Number.isFinite(live?.price) ? { ...stored, ...live } : stored
  })
}

function controlStatus() {
  const stream = feed?.getStatus() || engineStatus
  const runningState = ["armed", "starting", "connecting", "live", "reconnecting"].includes(stream.state)
  const hasLiveSocket = stream.state === "live" && stream.connected
  const outsideSession = stream.state === "armed"
  const depthError = outsideSession
    ? stream.message
    : stream.state === "error" || stream.state === "reconnecting"
    ? stream.message
    : stream.optionDepth?.storageError || null
  const candleError = candleCapture.error || (outsideSession || stream.state === "error" || stream.state === "reconnecting" ? stream.message : null)
  return {
    auth: { ...authStatus, tokenPresent: hasToken() },
    history: preloader.status(),
    server: stream,
    capture: {
      server: {
        state: outsideSession ? "live" : stream.state,
        message: outsideSession
          ? "Dashboard server running · live data unavailable outside market hours"
          : stream.state === "live"
          ? "Server running · FYERS WebSocket connected"
          : stream.message,
      },
      depth: {
        state: !runningState ? (stream.state === "error" ? "error" : "stopped")
          : depthError ? "error" : !hasLiveSocket ? stream.state : stream.received?.depth
            ? "receiving" : "waiting",
        message: !runningState ? stream.message
          : depthError ? depthError : !hasLiveSocket ? stream.message
            : stream.received?.depth
              ? `WebSocket receiving cash depth updates · ${stream.received.depth} stock updates · last ${stream.lastDepthAt || "unknown"}`
              : "WebSocket connected and depth subscribed · waiting for first depth update",
        stockUpdates: stream.received?.depth || 0,
        optionUpdates: stream.optionDepth?.received || 0,
      },
      candles: {
        state: !runningState ? (stream.state === "error" ? "error" : "stopped")
          : candleError ? "error" : !hasLiveSocket ? stream.state : candleCapture.priceTicks
            ? "receiving" : "waiting",
        message: !runningState ? stream.message
          : candleError ? candleError : !hasLiveSocket ? stream.message
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

async function disposeFailedEngine() {
  if (!feed || feed.getStatus().state !== "error") return false
  await stopMarketEngine("Previous failed market stream was cleared")
  return true
}

async function stopMarketEngine(message = "Market stream stopped") {
  engineStatus = state("stopping", "Stopping market streams and strategy...")
  emitControlStatus()
  candleBuilder.reset()
  strategyRadar.resetLiveState()
  earlyRadar.resetLiveState()
  bidSupportRadar.resetLiveState()
  bidRecoveryRadar.resetLiveState()
  const currentFeed = feed
  const currentTrading = trading
  feed = null
  trading = null
  await currentFeed?.stop()
  await currentTrading?.close()
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
    if (new URL(request.headers.origin).host === request.headers.host) return next()
  } catch {
    // Invalid origins are rejected below.
  }
  response.status(403).json({ ok: false, message: "Cross-origin control requests are not allowed." })
})

app.get("/api/control/status", (_request, response) => response.json(controlStatus()))

app.post("/api/control/autologin", async (_request, response) => {
  await disposeFailedEngine()
  if (feed || startPromise) {
    response.status(409).json({ ok: false, message: "The market engine is already running. Restart the app before replacing its FYERS session." })
    return
  }
  if (authStatus.state === "running") {
    response.status(409).json({ ok: false, message: "AutoLogin is already running." })
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
    response.status(400).json({ ok: false, message: "Run AutoLogin before fetching candles." })
    return
  }
  const result = preloader.start()
  emitControlStatus()
  response.status(result.accepted ? 202 : 409).json({ ok: result.accepted, ...result })
})

app.post("/api/control/start", async (_request, response) => {
  await disposeFailedEngine()
  if (feed) {
    response.status(409).json({ ok: false, message: "Market server is already started.", status: controlStatus() })
    return
  }
  if (!hasToken()) {
    response.status(400).json({ ok: false, message: "Run AutoLogin before starting the market server." })
    return
  }
  if (startPromise) {
    response.status(409).json({ ok: false, message: "Market server is already starting." })
    return
  }
  if (!isWithinLiveMarketSession()) {
    engineStatus = state("armed", "Invalid market time for live data capture. Data is available on weekdays from 09:15 to 15:30 IST.")
    emitControlStatus()
    response.status(202).json({ ok: true, message: "Dashboard server is running. Live data capture is unavailable outside market hours.", status: controlStatus() })
    return
  }
  engineStatus = state("starting", "Loading trading metadata and starting streams...")
  candleCapture.priceTicks = 0
  candleCapture.candleUpdates = 0
  candleCapture.lastPriceAt = null
  candleCapture.error = null
  candleBuilder.reset()
  emitControlStatus()
  startPromise = (async () => {
    CONSTANT.access_token = accessToken()
    await depthHistory.prepareStocks(stocks)
    await strategyRadar.seed(stocks, candles)
    await earlyRadar.seed(stocks, candles)
    await bidSupportRadar.seed(stocks, candles)
    await bidRecoveryRadar.seed(stocks, candles)
    const nextTrading = await createTradingRuntime({ rootDirectory, constants: CONSTANT, config: DEPTH_TREND, history })
    const nextFeed = createMarketFeed({
      io,
      stocks,
      clientId: process.env.FYERS_CLIENT_ID,
      accessToken: CONSTANT.access_token,
      history,
      depthHistory,
      onMarket: (kind, data, at, marketContext) => {
        nextTrading.observe(kind, data, at)
        if (kind === "depth") {
          strategyRadar.observeDepth(data, at, marketContext)
          earlyRadar.observeDepth(data, at)
          bidSupportRadar.observeDepth(data, at, marketContext)
          bidRecoveryRadar.observeDepth(data, at)
        }
        if (kind === "price") {
          candleCapture.priceTicks++
          bidRecoveryRadar.observePrice(data, at)
          candleCapture.lastPriceAt = at instanceof Date ? at.toISOString() : new Date(at).toISOString()
          if (candleBuilder.observe(data, at)) candleCapture.candleUpdates++
        }
      },
      onGap: () => {
        nextTrading.reset()
        strategyRadar.resetLiveState()
        earlyRadar.resetLiveState()
        bidSupportRadar.resetLiveState()
        bidRecoveryRadar.resetLiveState()
        candleBuilder.reset()
      },
      onReady: nextTrading.ready,
    })
    trading = nextTrading
    feed = nextFeed
    if (!feed.start()) throw new Error(feed.getStatus().message || "Unable to start FYERS market feed")
    preloader.startSessionBackfill()
    engineStatus = feed.getStatus()
  })()
  try {
    await startPromise
    emitControlStatus()
    response.status(202).json({ ok: true, message: "Market server is starting.", status: controlStatus() })
  } catch (error) {
    engineStatus = state("error", error.message)
    if (trading) await trading.close().catch(() => {})
    trading = null
    feed = null
    emitControlStatus()
    response.status(500).json({ ok: false, message: error.message })
  } finally {
    startPromise = null
  }
})

function isWithinLiveMarketSession(now = Date.now()) {
  const india = new Date(now + 330 * 60_000)
  const weekday = india.getUTCDay()
  const minute = india.getUTCHours() * 60 + india.getUTCMinutes()
  return weekday >= 1 && weekday <= 5 && minute >= 9 * 60 + 15 && minute < 15 * 60 + 30
}

app.post("/api/control/stop", async (_request, response) => {
  if (startPromise) await startPromise.catch(() => {})
  if (!feed && !trading && engineStatus.state !== "armed") {
    response.status(409).json({ ok: false, message: "Market server is already stopped.", status: controlStatus() })
    return
  }
  const strategy = trading?.status()
  const livePositions = strategy?.positions?.filter((position) => position.live) || []
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
    response.json({ ok: true, message: "Market server stopped.", status: controlStatus() })
  } catch (error) {
    engineStatus = state("error", `Unable to stop cleanly: ${error.message}`)
    emitControlStatus()
    response.status(500).json({ ok: false, message: engineStatus.message })
  }
})

app.post("/api/control/radar-cash-order", (request, response) => {
  if (!trading) {
    response.status(409).json({ ok: false, message: "Start the market server before placing an order." })
    return
  }
  const signalId = typeof request.body?.signalId === "string" ? request.body.signalId : ""
  const signal = radarSnapshot().find((item) => item.id === signalId)
  if (!signal) {
    response.status(404).json({ ok: false, message: "Strategy Radar signal was not found." })
    return
  }
  if (signal.status !== "Active") {
    response.status(409).json({ ok: false, message: `This signal is ${String(signal.status || "inactive").toLowerCase()}.` })
    return
  }
  const direction = String(signal.direction || "BUY").toUpperCase()
  if (direction !== "BUY") {
    response.status(400).json({ ok: false, message: "Manual cash SELL signals are not supported by the current long-only execution engine." })
    return
  }
  try {
    const queued = trading.placeCashOrder({
      symbol: signal.symbol,
      price: Number(signal.price),
      at: Date.parse(signal.time),
      reason: `strategy_radar:${signal.strategy}`,
    })
    response.status(202).json({ ok: true, message: `${queued.action} cash order queued for ${queued.symbol}.` })
  } catch (error) {
    response.status(409).json({ ok: false, message: error.message })
  }
})

app.get("/api/candles/:symbol", async (request, response) => {
  const symbol = String(request.params.symbol || "").trim().toUpperCase()
  if (symbol === "NIFTY50") {
    try {
      response.json({ ok: true, symbol, candles: await readNifty50Candles(request.query.limit) })
    } catch (error) {
      response.status(502).json({ ok: false, message: error.message })
    }
    return
  }
  if (!stocks.includes(symbol)) {
    response.status(404).json({ ok: false, message: "Unknown stock symbol" })
    return
  }
  try {
    const data = await candles.read(symbol, { limit: request.query.limit })
    response.json({ ok: true, symbol, candles: data })
  } catch (error) {
    response.status(500).json({ ok: false, message: error.message })
  }
})

app.get("/health", (_request, response) => {
  const recording = history.status()
  const depthRecording = depthHistory.status()
  const ok = recording.state === "recording" && depthRecording.state !== "error"
  const stream = feed?.getStatus() || engineStatus
  response.status(ok ? 200 : 503).json({
    ok,
    stocks: stocks.length,
    serverStopped: !feed,
    feed: stream,
    recording,
    depthHistory: depthRecording,
    strategy: trading ? { ...trading.status(), detector: undefined, rankings: trading.rankings() } : null,
  })
})

app.use(express.static(publicDirectory, {
  etag: true,
  // This is a local control surface. Always revalidate assets so the dashboard
  // cannot keep calling routes from an older server version after a restart.
  maxAge: 0,
}))

app.get("*", (_request, response) => response.sendFile(path.join(publicDirectory, "index.html")))

io.on("connection", (socket) => {
  void stockSnapshot().then((snapshot) => socket.emit("stocks:snapshot", snapshot)).catch((error) => {
    console.error("Cannot load stored stock prices:", error.message)
    socket.emit("stocks:snapshot", stocks.map((symbol) => ({ symbol, price: null, change: null, changePercent: null, updatedAt: null })))
  })
  socket.emit("feed:status", feed?.getStatus() || engineStatus)
  socket.emit("control:status", controlStatus())
  socket.emit("history:status", preloader.status())
  socket.emit("strategy:signals", radarSnapshot())
})

const earlyRadarTimer = setInterval(() => {
  if (feed) {
    earlyRadar.flushCompleted(Date.now())
    bidRecoveryRadar.flushCompleted(Date.now())
  }
}, 1000)

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
  console.log(`Trading routes: cash=${CONSTANT.flgPlaceCashOrder}, options=${CONSTANT.flgPlaceOptionOrder}; both false = paper orders`)
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(earlyRadarTimer)
  clearInterval(statusTimer)
  clearInterval(databaseSizeTimer)
  candleBuilder.close()
  const deadline = setTimeout(() => {
    console.error("Shutdown timed out; buffered market history may be incomplete.")
    process.exit(1)
  }, 15000)
  try {
    await feed?.stop()
    await trading?.close()
    await Promise.all([history.close(), depthHistory.close(), new Promise((resolve) => io.close(resolve))])
    clearTimeout(deadline)
    process.exit(0)
  } catch (error) {
    console.error("Unable to flush market history:", error.message)
    process.exit(1)
  }
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
