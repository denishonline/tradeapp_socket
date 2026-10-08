const elements = Object.fromEntries([
  "connectionChip", "connectionText", "niftyChartButton", "radarAlertButton",
  "autoLoginButton", "preCandlesButton", "startServerButton", "authLabel",
  "historyLabel", "serverLabel", "serverActionLabel", "orderMode", "strategySignalGroups",
  "captureServerStatus", "captureServerMessage", "captureDepthStatus", "captureDepthMessage",
  "captureCandleStatus", "captureCandleMessage",
  "chartSymbol", "chartPrice", "chartChange", "chartSubtitle", "chartWrap", "candleChart",
  "chartEmpty", "databaseSize", "liveTime", "toast",
].map((id) => [id, document.querySelector(`#${id}`)]))

const stocks = new Map()
const NIFTY50_SYMBOL = "NIFTY50"
let selectedSymbol = null
let candles = []
let liveMinute = null
let control = null
let chartRequest = 0
let toastTimer
let startRequestPending = false
let startTimeout = null
let radarSignalsInitialized = false
const knownRadarSignalIds = new Set()

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 })
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 })
const percent = new Intl.NumberFormat("en-IN", { signDisplay: "always", minimumFractionDigits: 2, maximumFractionDigits: 2 })
const time = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" })
const axisTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })
const radarDateTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
  year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
const radarStrategies = ["Persistent Bid Absorption Breakout", "Early Depth-Control Breakout",
  "Bid Support Breakout", "Bid-Dominant Recovery"]

const socket = io({ transports: ["websocket", "polling"] })

socket.on("connect", () => {
  if (!control) setFeedStatus("stopped", "Dashboard ready · market stream stopped")
})
socket.on("disconnect", () => setFeedStatus("error", "Dashboard connection lost · reconnecting..."))
socket.on("connect_error", () => setFeedStatus("error", "Cannot reach dashboard server"))
socket.on("feed:status", ({ state, message }) => {
  if (startRequestPending && state === "error") {
    setFeedStatus("connecting", "Startup issue; retrying the FYERS connection...")
    return
  }
  setFeedStatus(state, message)
})
socket.on("control:status", applyControlStatus)
socket.on("history:status", (history) => applyControlStatus({ ...(control || {}), history }))
socket.on("stocks:snapshot", (snapshot) => {
  stocks.clear()
  for (const stock of snapshot) stocks.set(stock.symbol, stock)
  if (!selectedSymbol) void selectStock(NIFTY50_SYMBOL)
  else paintSelectedQuote()
})
socket.on("stocks:update", (tick) => {
  stocks.set(tick.symbol, { ...(stocks.get(tick.symbol) || {}), ...tick })
  if (tick.symbol === selectedSymbol) paintSelectedQuote()
})
socket.on("strategy:signals", (signals) => {
  const current = signals || []
  notifyNewRadarSignals(current)
  renderStrategySignals(current)
})
socket.on("candle:update", ({ symbol, candle }) => {
  if (symbol !== selectedSymbol) return
  liveMinute = candle
  upsertCandle(candle)
})
socket.on("candle:complete", ({ symbol, candle }) => {
  if (symbol !== selectedSymbol) return
  liveMinute = null
  upsertCandle(candle)
})

elements.niftyChartButton.addEventListener("click", () => void selectStock(NIFTY50_SYMBOL))
elements.radarAlertButton.addEventListener("click", () => void enableRadarNotifications())
elements.strategySignalGroups.addEventListener("click", (event) => {
  const orderButton = event.target.closest("[data-radar-order]")
  if (orderButton) {
    void placeRadarCashOrder(orderButton)
    return
  }
  const button = event.target.closest("[data-symbol]")
  if (button) selectStock(button.dataset.symbol)
})
elements.autoLoginButton.addEventListener("click", () => runControl("/api/control/autologin", elements.autoLoginButton, "AutoLogin started"))
elements.preCandlesButton.addEventListener("click", () => runControl("/api/control/pre-candles", elements.preCandlesButton, "Historical candle fetch started"))
elements.startServerButton.addEventListener("click", () => {
  const running = ["armed", "connecting", "live", "reconnecting"].includes(control?.server?.state)
  if (running) {
    runControl("/api/control/stop", elements.startServerButton, "Market server stopped")
    return
  }

  startRequestPending = true
  clearTimeout(startTimeout)
  startTimeout = setTimeout(() => {
    if (!startRequestPending) return
    startRequestPending = false
    startTimeout = null
    showToast("Market feed did not connect within 60 seconds. Startup was stopped; check the FYERS session and try again.", "error")
    applyControlStatus(control || {})
    runControl("/api/control/stop", elements.startServerButton, "Market server stopped after startup timeout")
  }, 60_000)
  applyControlStatus(control || {})
  runControl("/api/control/start", elements.startServerButton, "Market server is starting")
    .then((succeeded) => {
      if (!succeeded) finishStartAttempt()
    })
})
new ResizeObserver(drawChart).observe(elements.chartWrap)

async function runControl(url, button, successMessage) {
  button.disabled = true
  try {
    const response = await fetch(url, { method: "POST", headers: { Accept: "application/json" } })
    const result = await response.json()
    if (!response.ok) throw new Error(result.message || "Action failed")
    showToast(result.message || successMessage, "success")
    await refreshControlStatus()
    return true
  } catch (error) {
    showToast(error.message, "error")
    await refreshControlStatus().catch(() => {})
    return false
  }
}

function finishStartAttempt() {
  startRequestPending = false
  clearTimeout(startTimeout)
  startTimeout = null
  applyControlStatus(control || {})
}

async function refreshControlStatus() {
  const response = await fetch("/api/control/status", { headers: { Accept: "application/json" } })
  if (!response.ok) throw new Error("Cannot load server status")
  applyControlStatus(await response.json())
}

function applyControlStatus(next) {
  control = { ...(control || {}), ...next }
  const auth = control.auth || {}
  const history = control.history || {}
  const server = control.server || {}
  const capture = control.capture || {}
  const database = control.database || {}
  if (startRequestPending && ["armed", "live", "error"].includes(server.state)) {
    startRequestPending = false
    clearTimeout(startTimeout)
    startTimeout = null
  }
  const serverRunning = ["armed", "connecting", "live", "reconnecting"].includes(server.state)
  const serverTransitioning = startRequestPending || ["starting", "stopping"].includes(server.state)
  const serverStarting = startRequestPending || ["starting", "connecting"].includes(server.state)
  elements.authLabel.textContent = auth.state === "running"
    ? `${auth.step || 0}/${auth.total || 5} · ${auth.message}`
    : auth.tokenPresent ? "Token saved" : "Session required"
  elements.historyLabel.textContent = history.state === "running"
    ? `${history.completed || 0}/${history.total || 0} stocks`
    : history.state === "complete" ? "30-day history ready" : history.message || "30 days · 1 minute"
  elements.serverLabel.textContent = server.state === "live"
    ? "Full quotes + 5-depth live"
    : startRequestPending && server.state === "stopped"
      ? "Preparing market feed..."
      : startRequestPending && server.state === "reconnecting"
        ? "Connection interrupted; retrying startup..."
        : startRequestPending && server.state === "error"
          ? "Startup issue; retrying the FYERS connection..."
      : server.message || "Price + depth streams"
  elements.autoLoginButton.disabled = auth.state === "running" || serverRunning || serverTransitioning
  elements.preCandlesButton.disabled = !auth.tokenPresent || history.state === "running"
  elements.startServerButton.disabled = serverTransitioning || (!auth.tokenPresent && !serverRunning)
  elements.serverActionLabel.textContent = server.state === "armed" || server.state === "live" || (server.state === "reconnecting" && !startRequestPending)
    ? "Stop Server"
    : server.state === "stopping" ? "Stopping..." : serverStarting ? "Starting..." : "Start Server"
  elements.startServerButton.classList.toggle("is-live", server.state === "armed" || server.state === "live")
  elements.startServerButton.classList.toggle("is-starting", serverStarting)
  elements.startServerButton.classList.toggle("is-reconnecting", server.state === "reconnecting" && !startRequestPending)
  elements.orderMode.textContent = `Order mode: ${(control.orderMode || "unknown").replace("-", " ")}`
  elements.orderMode.dataset.mode = control.orderMode || "unknown"
  setCaptureStatus(elements.captureServerStatus, elements.captureServerMessage, capture.server, server)
  setCaptureStatus(elements.captureDepthStatus, elements.captureDepthMessage, capture.depth, server)
  elements.databaseSize.textContent = `db/ size: ${formatBytes(database.sizeBytes)}`
  setCaptureStatus(elements.captureCandleStatus, elements.captureCandleMessage, capture.candles, server)
  if (server.state) {
    setFeedStatus(
      startRequestPending && server.state === "error" ? "connecting" : server.state,
      startRequestPending && server.state === "error"
        ? "Startup issue; retrying the FYERS connection..."
        : server.message,
    )
  }
}

function setCaptureStatus(container, messageElement, detail, server) {
  const state = detail?.state || server?.state || "stopped"
  container.dataset.state = state
  messageElement.textContent = detail?.message || server?.message || "Status unavailable"
  messageElement.title = messageElement.textContent
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "calculating..."
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let size = bytes / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size.toFixed(2)} ${units[unit]}`
}

function setFeedStatus(state, message) {
  elements.connectionChip.dataset.state = state
  elements.connectionText.textContent = message || state
}

async function selectStock(symbol) {
  const nifty50 = symbol === NIFTY50_SYMBOL
  if (!nifty50 && !stocks.has(symbol)) return
  selectedSymbol = symbol
  if (nifty50) candles = []
  elements.chartSymbol.textContent = symbol
  elements.chartSubtitle.textContent = nifty50 ? "Loading NIFTY 50 candles..." : "Loading stored candles..."
  elements.chartEmpty.textContent = "Loading candles..."
  elements.chartEmpty.hidden = false
  elements.niftyChartButton.disabled = nifty50
  paintSelectedQuote()
  const request = ++chartRequest
  try {
    const response = await fetch(`/api/candles/${encodeURIComponent(symbol)}?limit=360`)
    const result = await response.json()
    if (!response.ok) throw new Error(result.message || "Unable to load candles")
    if (request !== chartRequest) return
    candles = result.candles || []
    liveMinute = null
    elements.chartSubtitle.textContent = candles.length
      ? nifty50 ? `${candles.length} NIFTY 50 candles · FYERS one-minute history`
        : `${candles.length} stored candles · pre-history + live stream`
      : "No stored candles yet. Fetch pre candles or start the live stream."
    elements.chartEmpty.textContent = nifty50 ? "NIFTY 50 candle data is unavailable." : "No candle data for this stock yet."
    elements.chartEmpty.hidden = candles.length > 0
    paintSelectedQuote()
    drawChart()
  } catch (error) {
    if (request !== chartRequest) return
    candles = []
    elements.chartSubtitle.textContent = error.message
    elements.chartEmpty.textContent = "Candle data is unavailable."
    elements.chartEmpty.hidden = false
    drawChart()
  } finally {
    if (request === chartRequest) elements.niftyChartButton.disabled = false
  }
}

function paintSelectedQuote() {
  if (selectedSymbol === NIFTY50_SYMBOL) {
    const latest = candles.at(-1)
    const latestDay = latest ? new Date(latest.time * 1000 + 330 * 60_000).toISOString().slice(0, 10) : null
    const session = latestDay ? candles.filter((candle) =>
      new Date(candle.time * 1000 + 330 * 60_000).toISOString().slice(0, 10) === latestDay) : []
    const dayOpen = session[0]?.open
    const changePercent = latest && dayOpen ? (latest.close / dayOpen - 1) * 100 : null
    elements.chartPrice.textContent = latest ? number.format(latest.close) : "—"
    elements.chartChange.textContent = Number.isFinite(changePercent) ? `${percent.format(changePercent)}%` : ""
    elements.chartChange.className = changePercent >= 0 ? "positive" : "negative"
    return
  }
  const stock = stocks.get(selectedSymbol)
  elements.chartPrice.textContent = Number.isFinite(stock?.price) ? money.format(stock.price) : "—"
  if (Number.isFinite(stock?.changePercent)) {
    elements.chartChange.textContent = `${percent.format(stock.changePercent)}%`
    elements.chartChange.className = stock.changePercent >= 0 ? "positive" : "negative"
  } else {
    elements.chartChange.textContent = ""
    elements.chartChange.className = ""
  }
}

function upsertCandle(candle) {
  const index = candles.findIndex((item) => item.time === candle.time)
  if (index >= 0) candles[index] = candle
  else candles.push(candle)
  candles.sort((a, b) => a.time - b.time)
  candles = candles.slice(-360)
  elements.chartEmpty.hidden = candles.length > 0
  elements.chartSubtitle.textContent = `${candles.length} candles · live minute updating`
  drawChart()
}

function renderStrategySignals(signals) {
  if (!signals.length) {
    elements.strategySignalGroups.innerHTML = radarStrategies.map((strategy) => `
      <section class="strategy-signal-group">
        <div class="strategy-group-heading"><h3>${escapeHtml(strategy)}</h3><span>0</span></div>
        <p class="strategy-empty">Waiting for signal</p>
      </section>`).join("")
    return
  }
  const groups = new Map(radarStrategies.map((strategy) => [strategy, []]))
  for (const signal of signals) {
    const strategy = signal.strategy || "Other strategies"
    if (!groups.has(strategy)) groups.set(strategy, [])
    groups.get(strategy).push(signal)
  }
  elements.strategySignalGroups.innerHTML = [...groups.entries()].map(([strategy, items]) => `
    <section class="strategy-signal-group">
      <div class="strategy-group-heading"><h3>${escapeHtml(strategy)}</h3><span>${items.length}</span></div>
      <div class="strategy-signal-list">${items.length ? items.map((signal) => {
        const at = Date.parse(signal.time)
        const signalTime = Number.isFinite(at) ? `${radarDateTime.format(new Date(at))} IST` : "Time unavailable"
        const direction = String(signal.direction || "BUY").toUpperCase()
        const active = signal.status === "Active" && Boolean(signal.id)
        const disabled = active ? "" : " disabled"
        const buttonTitle = active ? `Place ${direction} cash order` : String(signal.status || "Signal unavailable")
        return `<div class="strategy-signal-row">
          <button type="button" class="strategy-signal-copy" data-symbol="${escapeHtml(signal.symbol)}" aria-label="Open ${escapeHtml(signal.symbol)} chart">
            <strong>${escapeHtml(signal.symbol)}</strong><time datetime="${escapeHtml(signal.time)}">${escapeHtml(signalTime)}</time>
          </button>
          <button type="button" class="strategy-order-button" data-side="${escapeHtml(direction)}" data-radar-order="${escapeHtml(signal.id || "")}" data-symbol="${escapeHtml(signal.symbol)}" title="${escapeHtml(buttonTitle)}"${disabled}>${escapeHtml(direction)}</button>
        </div>`
      }).join("") : `<p class="strategy-empty">Waiting for signal</p>`}</div>
    </section>`).join("")
}

function radarSignalId(signal) {
  return signal.id || `${signal.strategy || "strategy"}:${signal.symbol || "stock"}:${signal.time || "time"}`
}

function notifyNewRadarSignals(signals) {
  if (!radarSignalsInitialized) {
    for (const signal of signals) knownRadarSignalIds.add(radarSignalId(signal))
    radarSignalsInitialized = true
    return
  }
  for (const signal of signals) {
    const id = radarSignalId(signal)
    if (knownRadarSignalIds.has(id)) continue
    knownRadarSignalIds.add(id)
    if (signal.status !== "Active" || !("Notification" in window) || Notification.permission !== "granted") continue
    const direction = String(signal.direction || "BUY").toUpperCase()
    const at = Date.parse(signal.time)
    const signalTime = Number.isFinite(at) ? `${radarDateTime.format(new Date(at))} IST` : "Now"
    const notification = new Notification(`${direction} ${signal.symbol}`, {
      body: `${signal.strategy || "Strategy Radar"}\n${signalTime}`,
      tag: `strategy-radar:${id}`,
      renotify: true,
      requireInteraction: true,
    })
    notification.onclick = () => {
      window.focus()
      void selectStock(signal.symbol)
      notification.close()
    }
  }
}

function updateRadarAlertButton() {
  const supported = "Notification" in window
  const permission = supported ? Notification.permission : "unsupported"
  elements.radarAlertButton.dataset.state = permission
  elements.radarAlertButton.textContent = permission === "granted" ? "Alerts on"
    : permission === "denied" ? "Alerts blocked" : permission === "unsupported" ? "Alerts unavailable" : "Enable alerts"
  elements.radarAlertButton.setAttribute("aria-pressed", String(permission === "granted"))
}

async function enableRadarNotifications() {
  if (!("Notification" in window)) {
    showToast("Windows notifications are unavailable in this browser.", "error")
    return
  }
  let permission = Notification.permission
  if (permission === "default") permission = await Notification.requestPermission()
  updateRadarAlertButton()
  if (permission === "granted") {
    new Notification("Strategy Radar alerts enabled", { body: "New live signals will appear as Windows notifications." })
    showToast("Strategy Radar Windows notifications enabled.", "success")
  } else {
    showToast("Allow notifications for this site in the browser settings.", "error")
  }
}

async function placeRadarCashOrder(button) {
  if (button.disabled) return
  const signalId = button.dataset.radarOrder
  const symbol = button.dataset.symbol
  const direction = button.dataset.side || "BUY"
  if (!window.confirm(`Place live cash ${direction} order for ${symbol}?`)) return
  const previousLabel = button.textContent
  button.disabled = true
  button.textContent = "QUEUING…"
  try {
    const response = await fetch("/api/control/radar-cash-order", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ signalId }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload.ok) throw new Error(payload.message || "Cash order could not be queued.")
    button.textContent = "QUEUED"
    showToast(payload.message || `${direction} cash order queued for ${symbol}.`)
  } catch (error) {
    button.disabled = false
    button.textContent = previousLabel
    showToast(error.message, "error")
  }
}

function drawChart() {
  const canvas = elements.candleChart
  const bounds = elements.chartWrap.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(bounds.width * ratio)
  canvas.height = Math.round(bounds.height * ratio)
  canvas.style.width = `${bounds.width}px`
  canvas.style.height = `${bounds.height}px`
  const context = canvas.getContext("2d")
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, bounds.width, bounds.height)
  if (!candles.length) return

  const data = candles.slice(-360)
  const margin = { top: 22, right: 62, bottom: 35, left: 12 }
  const volumeHeight = Math.max(55, bounds.height * 0.2)
  const priceBottom = bounds.height - margin.bottom - volumeHeight - 12
  const plotWidth = bounds.width - margin.left - margin.right
  const priceHeight = priceBottom - margin.top
  const lowest = Math.min(...data.map((candle) => candle.low))
  const highest = Math.max(...data.map((candle) => candle.high))
  const padding = Math.max((highest - lowest) * 0.08, highest * 0.0005)
  const minimum = lowest - padding
  const maximum = highest + padding
  const range = maximum - minimum || 1
  const candleSlot = plotWidth / data.length
  const bodyWidth = Math.max(1, Math.min(7, candleSlot * 0.68))
  const maxVolume = Math.max(1, ...data.map((candle) => candle.volume))
  const y = (price) => margin.top + (maximum - price) / range * priceHeight

  context.font = "10px ui-monospace, monospace"
  context.textAlign = "left"
  context.textBaseline = "middle"
  for (let line = 0; line <= 5; line++) {
    const lineY = margin.top + priceHeight / 5 * line
    context.strokeStyle = "rgba(92, 108, 135, 0.13)"
    context.lineWidth = 1
    context.beginPath(); context.moveTo(margin.left, lineY); context.lineTo(bounds.width - margin.right, lineY); context.stroke()
    const value = maximum - range / 5 * line
    context.fillStyle = "#718096"
    context.fillText(number.format(value), bounds.width - margin.right + 8, lineY)
  }

  data.forEach((candle, index) => {
    const x = margin.left + candleSlot * index + candleSlot / 2
    const rising = candle.close >= candle.open
    const color = rising ? "#07865f" : "#d93c57"
    context.strokeStyle = color
    context.fillStyle = color
    context.lineWidth = liveMinute?.time === candle.time ? 2 : 1
    context.beginPath(); context.moveTo(x, y(candle.high)); context.lineTo(x, y(candle.low)); context.stroke()
    const top = y(Math.max(candle.open, candle.close))
    const bottom = y(Math.min(candle.open, candle.close))
    context.fillRect(x - bodyWidth / 2, top, bodyWidth, Math.max(1, bottom - top))
    const volumeTop = bounds.height - margin.bottom - candle.volume / maxVolume * volumeHeight
    context.globalAlpha = 0.35
    context.fillRect(x - bodyWidth / 2, volumeTop, bodyWidth, bounds.height - margin.bottom - volumeTop)
    context.globalAlpha = 1
  })

  const labelCount = Math.min(6, data.length)
  context.textAlign = "center"
  context.textBaseline = "top"
  context.fillStyle = "#718096"
  for (let label = 0; label < labelCount; label++) {
    const index = Math.round(label * (data.length - 1) / Math.max(1, labelCount - 1))
    const x = margin.left + candleSlot * index + candleSlot / 2
    context.fillText(axisTime.format(new Date(data[index].time * 1000)), x, bounds.height - margin.bottom + 11)
  }
}

function showToast(message, kind) {
  clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.dataset.kind = kind
  elements.toast.classList.add("visible")
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 4500)
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character])
}

function updateClock() {
  elements.liveTime.textContent = `Live time: ${time.format(new Date())} IST`
}

updateClock()
setInterval(updateClock, 1000)
updateRadarAlertButton()
void selectStock(NIFTY50_SYMBOL)
refreshControlStatus().catch(() => {})
