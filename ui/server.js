import dotenv from "dotenv"
import express from "express"
import { createServer } from "node:http"
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
import { createTradingRuntime } from "./trading/runtime.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDirectory = path.resolve(__dirname, "..")
const publicDirectory = path.join(__dirname, "public")
const environment = process.env.NODE_ENV || "production"
const envFile = environment === "production" ? ".env.production" : ".env"
dotenv.config({ path: path.join(rootDirectory, envFile) })
const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || "127.0.0.1"

const stocks = await loadStocks(path.join(rootDirectory, "db", "stocks"))
const history = await createMarketHistory({
  directory: path.resolve(rootDirectory, process.env.MARKET_HISTORY_DIR || "db/market-history"),
})
const depthHistory = await createMarketDepthHistory({
  directory: path.join(rootDirectory, "db", "option-depth"),
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
const candleBuilder = createLiveCandleBuilder({
  store: candles,
  io,
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
  onStatus: (status) => io.emit("history:status", status),
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

function stockSnapshot() {
  return stocks.map((symbol) => ({ symbol, price: null, change: null, changePercent: null, updatedAt: null }))
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
              ? `WebSocket receiving depth updates · ${stream.received.depth} stock / ${stream.optionDepth?.received || 0} option · last ${stream.lastDepthAt || "unknown"}`
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
  const currentFeed = feed
  const currentTrading = trading
  feed = null
  trading = null
  await currentFeed?.stop()
  await currentTrading?.close()
  engineStatus = state("stopped", message)
  io.emit("stocks:snapshot", stockSnapshot())
  io.emit("feed:status", engineStatus)
  io.emit("strategy:rankings", { buy: [], sell: [] })
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
  if (engineStatus.state === "armed") {
    response.status(409).json({ ok: false, message: "Capture service is already running; live data is unavailable outside market hours.", status: controlStatus() })
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
    const nextTrading = await createTradingRuntime({ rootDirectory, constants: CONSTANT, config: DEPTH_TREND, history })
    const nextFeed = createMarketFeed({
      io,
      stocks,
      clientId: process.env.FYERS_CLIENT_ID,
      accessToken: CONSTANT.access_token,
      history,
      optionContracts: nextTrading.optionContracts,
      depthHistory,
      onMarket: (kind, data, at) => {
        nextTrading.observe(kind, data, at)
        if (kind === "price") {
          candleCapture.priceTicks++
          candleCapture.lastPriceAt = at instanceof Date ? at.toISOString() : new Date(at).toISOString()
          if (candleBuilder.observe(data, at)) candleCapture.candleUpdates++
        }
      },
      onGap: () => {
        nextTrading.reset()
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

app.get("/api/candles/:symbol", async (request, response) => {
  const symbol = String(request.params.symbol || "").trim().toUpperCase()
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
  if (feed) feed.sendSnapshot(socket)
  else {
    socket.emit("stocks:snapshot", stockSnapshot())
    socket.emit("feed:status", engineStatus)
  }
  socket.emit("control:status", controlStatus())
  socket.emit("history:status", preloader.status())
  socket.emit("strategy:rankings", trading?.rankings() || { buy: [], sell: [] })
})

const statusTimer = setInterval(() => {
  emitControlStatus()
  io.emit("strategy:rankings", trading?.rankings() || { buy: [], sell: [] })
}, 2000)

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
  clearInterval(statusTimer)
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
