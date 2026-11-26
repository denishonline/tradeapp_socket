const elements = Object.fromEntries(
  [
    "connectionChip",
    "connectionText",
    "autoLoginButton",
    "preCandlesButton",
    "startServerButton",
    "authLabel",
    "historyLabel",
    "serverLabel",
    "serverActionLabel",
    "orderMode",
    "cutoffTimeInput",
    "cutoffLiveButton",
    "cutoffMode",
    "captureServerStatus",
    "captureServerMessage",
    "captureDepthStatus",
    "captureDepthMessage",
    "captureCandleStatus",
    "captureCandleMessage",
    "positionsTotal",
    "positionsSummary",
    "positionsList",
    "askAbsorptionSignals",
    "manualCandleDepthSignals",
    "manualCandleDepthCutoff",
    "manualCandleDepthCurrent",
    "manualCandleDepthCutoffMode",
    "chartSymbol",
    "chartPrice",
    "chartChange",
    "chartSubtitle",
    "chartWrap",
    "directionalShares",
    "candleChart",
    "chartEmpty",
    "databaseSize",
    "liveTime",
    "toast",
  ].map((id) => [id, document.querySelector(`#${id}`)]),
)

const stocks = new Map()
const NIFTY50_SYMBOL = "NIFTY50"
const CHART_SESSION_LIMIT = 10
const CHART_CANDLE_FETCH_LIMIT = 5000
const CHART_VISIBLE_CANDLE_LIMIT = 360
let selectedSymbol = null
let candles = []
let liveMinute = null
let control = null
let chartRequest = 0
let toastTimer
let startRequestPending = false
let startTimeout = null
let positionsRequestPending = false
let cutoffRequestPending = false

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
})
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 })
const percent = new Intl.NumberFormat("en-IN", {
  signDisplay: "always",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const time = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})
const axisTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
})

function candleSessionDate(candle) {
  return new Date(Number(candle.time) * 1000 + 330 * 60_000).toISOString().slice(0, 10)
}

function recentChartSessions(rows) {
  const ordered = [...rows].sort((left, right) => Number(left.time) - Number(right.time))
  const dates = [...new Set(ordered.map(candleSessionDate))].slice(-CHART_SESSION_LIMIT)
  const included = new Set(dates)
  return ordered.filter((candle) => included.has(candleSessionDate(candle)))
}

const socket = io({ transports: ["websocket", "polling"] })

socket.on("connect", () => {
  if (!control)
    setFeedStatus("stopped", "Dashboard ready · market stream stopped")
})
socket.on("disconnect", () =>
  setFeedStatus("error", "Dashboard connection lost · reconnecting..."),
)
socket.on("connect_error", () =>
  setFeedStatus("error", "Cannot reach dashboard server"),
)
socket.on("feed:status", ({ state, message }) => {
  if (startRequestPending && state === "error") {
    setFeedStatus(
      "connecting",
      "Startup issue; retrying the FYERS connection...",
    )
    return
  }
  setFeedStatus(state, message)
})
socket.on("control:status", applyControlStatus)
socket.on("history:status", (history) =>
  applyControlStatus({ ...(control || {}), history }),
)
socket.on("opening:directional-shares", applyDirectionalSharesTable)
socket.on("signals:live-scanners", applyLiveSignalScanners)

function syncCutoffControl(payload) {
  if (!elements.cutoffTimeInput || !elements.cutoffMode || !elements.cutoffLiveButton) return
  if (cutoffRequestPending) return
  const fixed = payload?.cutoffMode === "fixed"
  if (document.activeElement !== elements.cutoffTimeInput)
    elements.cutoffTimeInput.value = fixed ? payload.selectedCutoffTime || "" : ""
  elements.cutoffMode.textContent = fixed
    ? `Fixed at ${payload.selectedCutoffTime} IST`
    : "Using current IST time"
  elements.cutoffLiveButton.dataset.active = fixed ? "" : "true"
}

async function setAnalysisCutoff(cutoffTime) {
  cutoffRequestPending = true
  elements.cutoffMode.textContent = cutoffTime ? `Switching to ${cutoffTime} IST...` : "Switching to current IST time..."
  elements.cutoffLiveButton.dataset.active = cutoffTime ? "" : "true"
  elements.cutoffTimeInput.disabled = true
  elements.cutoffLiveButton.disabled = true
  try {
    const response = await fetch("/api/control/opening-cutoff", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ cutoffTime: cutoffTime || null }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || !result.ok) throw new Error(result.message || "Unable to change cutoff time")
    if (result.status) applyDirectionalSharesTable(result.status)
    showToast(result.message, "success")
  } catch (error) {
    showToast(error.message, "error")
    await refreshDirectionalShares().catch(() => {})
  } finally {
    cutoffRequestPending = false
    elements.cutoffTimeInput.disabled = false
    elements.cutoffLiveButton.disabled = false
  }
}

function applyDirectionalSharesTable(payload) {
  const opening = elements.directionalShares?.querySelector('[data-window="opening"]')
  const lastFive = elements.directionalShares?.querySelector('[data-window="last-five"]')
  const lastFifteen = elements.directionalShares?.querySelector('[data-window="last-fifteen"]')
  if (!opening || !lastFive || !lastFifteen) return
  const progress = elements.directionalShares?.querySelector(".directional-progress")
  if (progress) progress.textContent = payload?.message || "Waiting for scan..."
  syncCutoffControl(payload)
  elements.directionalShares.dataset.state = payload?.state || "waiting"
  const paint = (row, values, direction) => {
    row.querySelectorAll("td").forEach((cell, index) => { cell.textContent = values[index] })
    row.dataset.direction = direction
  }
  const data = payload?.data
  if (!data) {
    paint(opening, ["-", "-", "-"], "")
    paint(lastFive, ["-", "-", "-"], "")
    paint(lastFifteen, ["-", "-", "-"], "")
    return
  }
  const direction = value => value > 0 ? "bullish" : value < 0 ? "bearish" : "neutral"
  const openingDifference = Number.parseFloat(data.difference)
  const lastFiveDifference = Number.parseFloat(data.lastFiveDifference)
  const lastFifteenDifference = Number.parseFloat(data.lastFifteenDifference)
  const openingWindow = opening.querySelector("[data-opening-window]")
  if (openingWindow) openingWindow.textContent = `09:15–${data.cutoffTime || "now"}`
  paint(opening, [data.bullish, data.bearish, data.difference], direction(openingDifference))
  paint(lastFive, [data.lastFiveBullish, data.lastFiveBearish, data.lastFiveDifference], direction(lastFiveDifference))
  paint(lastFifteen, [data.lastFifteenBullish, data.lastFifteenBearish, data.lastFifteenDifference], direction(lastFifteenDifference))
  elements.directionalShares.title = `${payload.message || "Opening direction"} · ${data.analyzed || 0} high-volume stocks`
}

function applyDirectionalShares(payload) {
  const lines = elements.directionalShares?.querySelectorAll("strong")
  if (!lines?.length) return
  const progress = elements.directionalShares?.querySelector(".directional-progress")
  const lastFive = elements.directionalShares?.querySelector(".directional-last-five")
  if (progress) progress.textContent = payload?.message || "Waiting for scan..."
  elements.directionalShares.dataset.state = payload?.state || "waiting"
  const data = payload?.data
  if (!data) {
    if (lastFive) lastFive.textContent = "Last 5m: Bullish: — · Bearish: — · Difference: —"
    lines[0].textContent = "Bullish: —"
    lines[1].textContent = "Bearish: —"
    lines[2].textContent = "Difference: —"
    elements.directionalShares.dataset.direction = ""
    elements.directionalShares.title = payload?.message || "Waiting for opening-direction data."
    return
  }
  if (lastFive) lastFive.textContent = `Last 5m: Bullish: ${data.lastFiveBullish} · Bearish: ${data.lastFiveBearish} · Difference: ${data.lastFiveDifference}`
  lines[0].textContent = `Bullish: ${data.bullish}`
  lines[1].textContent = `Bearish: ${data.bearish}`
  lines[2].textContent = `Difference: ${data.difference}`
  const difference = Number.parseFloat(data.difference)
  elements.directionalShares.dataset.direction = difference > 0 ? "bullish" : difference < 0 ? "bearish" : "neutral"
  elements.directionalShares.title = `${payload.message || "Opening direction"} · ${data.analyzed || 0} high-volume stocks`
}

function applyLiveSignalScanners(payload) {
  const panel = elements.askAbsorptionSignals
  if (panel) renderSignalScanner(panel, payload?.askAbsorption || {})
}

function renderSignalScanner(panel, scanner) {
  panel.dataset.state = scanner.state || "waiting"
  const status = panel.querySelector(".signal-scanner-status")
  if (status) status.textContent = scanner.message || "Waiting for scan…"
  for (const side of ["buy", "sell"]) {
    const signals = Array.isArray(scanner[side]) ? scanner[side] : []
    const count = panel.querySelector(`[data-count="${side}"]`)
    const list = panel.querySelector(`[data-side="${side}"]`)
    if (count) count.textContent = signals.length
    if (!list) continue
    list.innerHTML = signals.length
      ? signals.map((signal) => {
        const detail = signal.entryTime ? `entry ${signal.entryTime}` : signal.setup
        return `<button class="signal-row" data-position-symbol="${escapeHtml(signal.stock)}" type="button"><strong>${escapeHtml(signal.stock)}</strong><small>${escapeHtml(signal.signalTime)}${detail ? ` · ${escapeHtml(detail)}` : ""}</small></button>`
      }).join("")
      : '<p class="signal-empty">No signals</p>'
  }
}

function updateManualCandleDepthCutoff() {
  const time = elements.manualCandleDepthCutoff.value
  elements.manualCandleDepthCurrent.dataset.active = time ? "" : "true"
  elements.manualCandleDepthCutoffMode.textContent = time ? `Scan through ${time} IST` : "Blank uses the latest completed candle"
}

elements.manualCandleDepthCutoff?.addEventListener("input", updateManualCandleDepthCutoff)
elements.manualCandleDepthCutoff?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return
  event.preventDefault()
  void runManualCandleDepthScan()
})
elements.manualCandleDepthCurrent?.addEventListener("click", runManualCandleDepthScan)

async function runManualCandleDepthScan() {
  const panel = elements.manualCandleDepthSignals
  const input = elements.manualCandleDepthCutoff
  const current = elements.manualCandleDepthCurrent
  if (current.disabled || !input.reportValidity()) return
  const cutoffTime = input.value || null
  input.disabled = true
  current.disabled = true
  current.textContent = "Scanning…"
  renderSignalScanner(panel, { state: "scanning", message: cutoffTime
    ? `Scanning through ${cutoffTime} IST…` : "Scanning through the latest completed candle…" })
  try {
    const response = await fetch("/api/control/candle-depth-scan", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ cutoffTime }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.message || "Scan failed.")
    renderSignalScanner(panel, { ...result, state: "ready" })
  } catch (error) {
    renderSignalScanner(panel, { state: "error", message: error.message })
  } finally {
    input.disabled = false
    current.disabled = false
    current.textContent = "Current"
  }
}

function formatNseEquitySymbol(symbol) {
  const stock = String(symbol || "").trim().replace(/^NSE:/i, "").replace(/-EQ$/i, "")
  return stock ? `NSE:${stock}-EQ` : ""
}

async function copySignalStocks(panel, side) {
  const symbols = [...panel.querySelectorAll(`[data-side="${side}"] [data-position-symbol]`)]
    .map((row) => formatNseEquitySymbol(row.dataset.positionSymbol))
    .filter(Boolean)
  if (!symbols.length) {
    showToast(`No ${side.toUpperCase()} stocks to copy.`, "error")
    return
  }
  const text = symbols.join(", ")
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
    else {
      const textarea = document.createElement("textarea")
      textarea.value = text
      textarea.setAttribute("readonly", "")
      textarea.style.position = "fixed"
      textarea.style.opacity = "0"
      document.body.append(textarea)
      textarea.select()
      const copied = document.execCommand("copy")
      textarea.remove()
      if (!copied) throw new Error("Copy command failed")
    }
    showToast(`${symbols.length} ${side.toUpperCase()} stock${symbols.length === 1 ? "" : "s"} copied.`, "success")
  } catch {
    showToast("Could not copy stocks to the clipboard.", "error")
  }
}

async function refreshDirectionalShares() {
  const response = await fetch("/api/opening-directional-shares", { cache: "no-store", headers: { Accept: "application/json" } })
  if (response.ok) applyDirectionalSharesTable(await response.json())
}

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
elements.positionsList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-position-symbol]")
  if (row && stocks.has(row.dataset.positionSymbol))
    void selectStock(row.dataset.positionSymbol)
})
for (const scannerPanel of [elements.askAbsorptionSignals, elements.manualCandleDepthSignals]) {
  scannerPanel?.addEventListener("click", (event) => {
    const copyButton = event.target.closest("[data-copy-side]")
    if (copyButton) {
      void copySignalStocks(scannerPanel, copyButton.dataset.copySide)
      return
    }
    const row = event.target.closest("[data-position-symbol]")
    if (row && stocks.has(row.dataset.positionSymbol)) void selectStock(row.dataset.positionSymbol)
  })
}
elements.cutoffTimeInput?.addEventListener("input", () => {
  if (!cutoffRequestPending)
    elements.cutoffMode.textContent = elements.cutoffTimeInput.value
      ? `Press Enter to scan ${elements.cutoffTimeInput.value} IST`
      : "Choose a time, then press Enter"
})
elements.cutoffTimeInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return
  event.preventDefault()
  const cutoffTime = elements.cutoffTimeInput.value
  if (!cutoffTime) {
    showToast("Choose a cutoff time first.", "error")
    return
  }
  void setAnalysisCutoff(cutoffTime)
})
elements.cutoffLiveButton?.addEventListener("click", () => {
  elements.cutoffTimeInput.value = ""
  void setAnalysisCutoff(null)
})
elements.autoLoginButton.addEventListener("click", () =>
  runControl(
    "/api/control/autologin",
    elements.autoLoginButton,
    "AutoLogin started",
  ),
)
elements.preCandlesButton.addEventListener("click", () =>
  runControl(
    "/api/control/pre-candles",
    elements.preCandlesButton,
    "Historical candle fetch started",
  ),
)
elements.startServerButton.addEventListener("click", () => {
  const running = ["armed", "connecting", "live", "reconnecting"].includes(
    control?.server?.state,
  )
  if (running) {
    runControl(
      "/api/control/stop",
      elements.startServerButton,
      "Market server stopped",
    )
    return
  }

  startRequestPending = true
  clearTimeout(startTimeout)
  startTimeout = null
  applyControlStatus(control || {})
  runControl(
    "/api/control/start",
    elements.startServerButton,
    "Market server is starting",
  ).then(() => finishStartAttempt())
})
new ResizeObserver(drawChart).observe(elements.chartWrap)

async function runControl(url, button, successMessage) {
  button.disabled = true
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
    })
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
  const response = await fetch("/api/control/status", {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error("Cannot load server status")
  applyControlStatus(await response.json())
}

function applyControlStatus(next) {
  const tokenWasPresent = Boolean(control?.auth?.tokenPresent)
  control = { ...(control || {}), ...next }
  const auth = control.auth || {}
  const history = control.history || {}
  const server = control.server || {}
  const capture = control.capture || {}
  const database = control.database || {}
  if (
    startRequestPending &&
    ["armed", "live", "error"].includes(server.state)
  ) {
    startRequestPending = false
    clearTimeout(startTimeout)
    startTimeout = null
  }
  const serverRunning = [
    "armed",
    "connecting",
    "live",
    "reconnecting",
  ].includes(server.state)
  const serverTransitioning =
    startRequestPending || ["starting", "stopping"].includes(server.state)
  const serverStarting = startRequestPending || server.state === "starting"
  elements.authLabel.textContent =
    auth.state === "running"
      ? `${auth.step || 0}/${auth.total || 5} · ${auth.message}`
      : auth.tokenPresent
        ? "Token saved"
        : "Session required"
  elements.historyLabel.textContent =
    history.state === "running"
      ? `${history.completed || 0}/${history.total || 0} stocks`
      : history.state === "complete"
        ? "30-day history ready"
        : history.message || "30 days · 1 minute"
  elements.serverLabel.textContent =
    server.state === "live"
      ? "Full quotes + 5-depth live"
      : startRequestPending && server.state === "stopped"
        ? "Preparing market feed..."
        : startRequestPending && server.state === "reconnecting"
          ? "Connection interrupted; retrying startup..."
          : startRequestPending && server.state === "error"
            ? "Startup issue; retrying the FYERS connection..."
            : server.message || "Price + depth streams"
  elements.autoLoginButton.disabled =
    auth.state === "running" || serverRunning || serverTransitioning
  elements.preCandlesButton.disabled =
    !auth.tokenPresent || history.state === "running"
  elements.startServerButton.disabled =
    serverTransitioning || (!auth.tokenPresent && !serverRunning)
  elements.serverActionLabel.textContent =
    serverRunning && !serverTransitioning && !startRequestPending
      ? "Stop Server"
      : server.state === "stopping"
        ? "Stopping..."
        : serverStarting
          ? "Starting..."
          : "Start Server"
  elements.startServerButton.classList.toggle(
    "is-live",
    server.state === "armed" || server.state === "live",
  )
  elements.startServerButton.classList.toggle("is-starting", serverStarting)
  elements.startServerButton.classList.toggle(
    "is-reconnecting",
    server.state === "reconnecting" && !startRequestPending,
  )
  elements.orderMode.textContent = `Order mode: ${(control.orderMode || "unknown").replace("-", " ")}`
  elements.orderMode.dataset.mode = control.orderMode || "unknown"
  setCaptureStatus(
    elements.captureServerStatus,
    elements.captureServerMessage,
    capture.server,
    server,
  )
  setCaptureStatus(
    elements.captureDepthStatus,
    elements.captureDepthMessage,
    capture.depth,
    server,
  )
  elements.databaseSize.textContent = `db/ size: ${formatBytes(database.sizeBytes)}`
  setCaptureStatus(
    elements.captureCandleStatus,
    elements.captureCandleMessage,
    capture.candles,
    server,
  )
  if (server.state) {
    setFeedStatus(
      startRequestPending && server.state === "error"
        ? "connecting"
        : server.state,
      startRequestPending && server.state === "error"
        ? "Startup issue; retrying the FYERS connection..."
        : server.message,
    )
  }
  if (
    !tokenWasPresent &&
    auth.tokenPresent &&
    selectedSymbol === NIFTY50_SYMBOL &&
    !candles.length
  ) {
    void selectStock(NIFTY50_SYMBOL)
  }
}

function setCaptureStatus(container, messageElement, detail, server) {
  const state = detail?.state || server?.state || "stopped"
  container.dataset.state = state
  messageElement.textContent =
    detail?.message || server?.message || "Status unavailable"
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

function formatPositionMoney(value) {
  if (!Number.isFinite(Number(value))) return "—"
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "always",
  }).format(Number(value))
}

function renderPositions(payload) {
  const positions = Array.isArray(payload?.positions) ? payload.positions : []
  const openCount = positions.filter((position) => position.isOpen).length
  const exitedCount = positions.length - openCount
  const totalProfit = Number(payload?.totalProfit) || 0
  elements.positionsTotal.textContent = formatPositionMoney(totalProfit)
  elements.positionsTotal.className = totalProfit >= 0 ? "positive" : "negative"
  const countSummary = exitedCount
    ? `${openCount} open / ${exitedCount} exited today`
    : `${openCount} open`
  elements.positionsSummary.textContent = `${countSummary} · updated ${time.format(new Date(payload.updatedAt || Date.now()))}`
  if (!positions.length) {
    elements.positionsList.innerHTML =
      '<p class="positions-empty">No positions today</p>'
    return
  }
  elements.positionsList.innerHTML = positions
    .map((position) => {
      const stock = String(position.stock || position.symbol || "Unknown")
      const profit = Number(position.profit) || 0
      const chartable = stocks.has(stock)
      const tag = chartable ? "button" : "div"
      const symbolAttribute = chartable
        ? ` data-position-symbol="${escapeHtml(stock)}" type="button"`
        : ""
      const side = position.isOpen === false
        ? "EXITED"
        : Number(position.quantity) < 0
          ? "SELL"
          : "BUY"
      const exitStatus = position.strategyExit
      const exitLabel = exitStatus?.label
        ? `<small class="position-exit-status" data-state="${escapeHtml(exitStatus.state || "ACTIVE")}">${escapeHtml(exitStatus.label)}</small>`
        : ""
      return `<${tag} class="position-row"${symbolAttribute}>
      <span class="position-copy"><strong>${escapeHtml(stock)}</strong><small class="position-side" data-side="${escapeHtml(side)}">${escapeHtml(side)}</small>${exitLabel}</span>
      <span class="position-profit ${profit >= 0 ? "positive" : "negative"}">${escapeHtml(formatPositionMoney(profit))}</span>
    </${tag}>`
    })
    .join("")
}

async function refreshPositions() {
  if (positionsRequestPending) return
  if (!control?.auth?.tokenPresent) {
    elements.positionsSummary.textContent = "AutoLogin required"
    return
  }
  positionsRequestPending = true
  try {
    const response = await fetch("/api/positions", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload.ok)
      throw new Error(payload.message || "Unable to load positions")
    renderPositions(payload)
  } catch (error) {
    elements.positionsSummary.textContent = error.message
  } finally {
    positionsRequestPending = false
  }
}

function renderPaper() {
  /* Removed automatic delta-hedge paper UI. */
  return
  /*
  const papers = Array.isArray(paperPositions) ? paperPositions : []
  const open = papers.filter((paper) => paper.state === "OPEN")
  const scannerState = paperAuto?.state || "waiting"
  elements.paperScannerStatus.dataset.state = scannerState
  elements.paperScannerMessage.textContent = paperAuto?.message || "Waiting for the live feed and 09:20 IST."
  elements.paperState.textContent = open.length ? `${open.length} LIVE` : papers.length ? "CLOSED" : "PAPER"
  elements.paperState.dataset.state = open.length ? "open" : papers.length ? "closed" : "idle"
  if (!papers.length) {
    elements.paperSummary.textContent = paperAuto?.message || "Automatic paper scan begins after 09:20 IST."
    elements.paperMetrics.hidden = true
    return
  }
  elements.paperSummary.textContent = `${open.length} active hedge setup(s) · ${paperAuto?.message || "paper marks"}`
  elements.paperMetrics.hidden = false
  elements.paperMetrics.innerHTML = papers.map((paper) => {
    const pnl = Number.isFinite(Number(paper.paperPnl)) ? Number(paper.paperPnl) : Number(paper.realizedPnl) || 0
    return `<section class="delta-paper-card" data-paper-id="${escapeHtml(paper.id)}"><div><strong>${escapeHtml(paper.stock)} ${escapeHtml(paper.optionType)} · ${paper.lot} qty</strong><small>${escapeHtml(paper.state)} · ${escapeHtml(paper.exitReason || paper.quoteStatus || "marking")}</small></div><div><small>Option: entry → live mark</small><strong>${number.format(paper.optionEntry)} → ${number.format(paper.optionMark)}</strong></div><div><small>Portfolio SL / target</small><strong>${escapeHtml(formatPositionMoney(paper.stopPnl))} / ${escapeHtml(formatPositionMoney(paper.targetPnl))}</strong></div><div><small>Stock hedge</small><strong>${paper.hedgeQty > 0 ? "BUY" : "SELL"} ${Math.abs(paper.hedgeQty)} shares · ${number.format(paper.cashMark)}</strong></div><div><small>Estimated / net Δ</small><strong>${number.format(paper.estimatedDelta)} / ${number.format(paper.netDelta)}</strong></div><div><small>Combined P&L · rebalances</small><strong class="${pnl >= 0 ? "positive" : "negative"}">${escapeHtml(formatPositionMoney(pnl))} · ${paper.rebalanceCount}</strong></div></section>`
  }).join("")
  */
}

function renderRzyPaper(payload) {
  /* RZY paper radar removed. */
  return
  /*
  const scanner = payload?.scanner || {}
  const positions = Array.isArray(payload?.positions) ? payload.positions : []
  const open = positions.filter((position) => position.state === "OPEN")
  elements.rzyPaperScannerStatus.dataset.state = scanner.state || "waiting"
  elements.rzyPaperScannerMessage.textContent = scanner.message || "Waiting for the live feed and 09:20 IST."
  elements.rzyPaperState.textContent = open.length ? `${open.length} LIVE` : "Paper"
  elements.rzyPaperState.dataset.state = open.length ? "open" : "waiting"
  elements.rzyPaperList.innerHTML = positions.length ? positions.map((position) => `<section class="delta-paper-card"><div><strong>${escapeHtml(position.stock)} ${escapeHtml(position.side)}</strong><small>${escapeHtml(position.state)}${position.exitReason ? ` · ${escapeHtml(position.exitReason)}` : ""}</small></div><div><small>Entry → live mark</small><strong>${number.format(position.entry)} → ${number.format(position.mark)}</strong></div><div><small>SL / target</small><strong>${number.format(position.stop)} / ${number.format(position.target)}</strong></div><div><small>Paper P&L</small><strong class="${Number(position.paperPnl) >= 0 ? "positive" : "negative"}">${escapeHtml(formatPositionMoney(position.paperPnl))}</strong></div></section>`).join("") : '<p class="panel-empty">No RZY setup yet</p>'
  */
}

/*
async function refreshRzyPaper() {
  try {
    const response = await fetch("/api/rzy-paper", { headers: { Accept: "application/json" }, cache: "no-store" })
    const payload = await response.json()
    if (response.ok && payload.ok) renderRzyPaper(payload)
  } catch {}
}
*/

function setFeedStatus(state, message) {
  if (!elements.connectionChip || !elements.connectionText) return
  elements.connectionChip.dataset.state = state
  elements.connectionText.textContent = message || state
}

async function selectStock(symbol) {
  const nifty50 = symbol === NIFTY50_SYMBOL
  if (!nifty50 && !stocks.has(symbol)) return
  const symbolChanged = selectedSymbol !== symbol
  selectedSymbol = symbol
  if (nifty50 && symbolChanged) candles = []
  elements.chartSymbol.textContent = symbol
  if (symbolChanged || !candles.length) {
    elements.chartSubtitle.textContent = nifty50
      ? "Loading NIFTY 50 candles..."
      : "Loading stored candles..."
    elements.chartEmpty.textContent = "Loading candles..."
    elements.chartEmpty.hidden = false
  }
  paintSelectedQuote()
  const request = ++chartRequest
  try {
    const response = await fetch(
      `/api/candles/${encodeURIComponent(symbol)}?limit=${CHART_CANDLE_FETCH_LIMIT}${nifty50 ? "" : "&refresh=1"}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
    )
    const result = await response.json()
    if (!response.ok)
      throw new Error(result.message || "Unable to load candles")
    if (request !== chartRequest) return
    candles = recentChartSessions(result.candles || [])
    liveMinute = null
    const visibleCandleCount = Math.min(candles.length, CHART_VISIBLE_CANDLE_LIMIT)
    elements.chartSubtitle.textContent = candles.length
      ? nifty50
        ? `${visibleCandleCount} chart candles · FYERS one-minute history`
        : `${visibleCandleCount} chart candles · pre-history + live stream`
      : "No stored candles yet. Fetch pre candles or start the live stream."
    elements.chartEmpty.textContent = nifty50
      ? "NIFTY 50 candle data is unavailable."
      : "No candle data for this stock yet."
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
  }
}

function paintSelectedQuote() {
  if (selectedSymbol === NIFTY50_SYMBOL) {
    const latest = candles.at(-1)
    const latestDay = latest
      ? new Date(latest.time * 1000 + 330 * 60_000).toISOString().slice(0, 10)
      : null
    const session = latestDay
      ? candles.filter(
          (candle) =>
            new Date(candle.time * 1000 + 330 * 60_000)
              .toISOString()
              .slice(0, 10) === latestDay,
        )
      : []
    const dayOpen = session[0]?.open
    const changePercent =
      latest && dayOpen ? (latest.close / dayOpen - 1) * 100 : null
    elements.chartPrice.textContent = latest ? number.format(latest.close) : "—"
    elements.chartChange.textContent = Number.isFinite(changePercent)
      ? `${percent.format(changePercent)}%`
      : ""
    elements.chartChange.className =
      changePercent >= 0 ? "positive" : "negative"
    return
  }
  const stock = stocks.get(selectedSymbol)
  elements.chartPrice.textContent = Number.isFinite(stock?.price)
    ? money.format(stock.price)
    : "—"
  if (Number.isFinite(stock?.changePercent)) {
    elements.chartChange.textContent = `${percent.format(stock.changePercent)}%`
    elements.chartChange.className =
      stock.changePercent >= 0 ? "positive" : "negative"
  } else {
    elements.chartChange.textContent = ""
    elements.chartChange.className = ""
  }
}

function upsertCandle(candle) {
  const index = candles.findIndex((item) => item.time === candle.time)
  if (index >= 0) candles[index] = candle
  else candles.push(candle)
  candles = recentChartSessions(candles)
  elements.chartEmpty.hidden = candles.length > 0
  elements.chartSubtitle.textContent = `${Math.min(candles.length, CHART_VISIBLE_CANDLE_LIMIT)} chart candles · live minute updating`
  drawChart()
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

  const priceData = candles.slice(-CHART_VISIBLE_CANDLE_LIMIT)
  const margin = { top: 22, right: 62, bottom: 35, left: 12 }
  const plotWidth = bounds.width - margin.left - margin.right
  const priceHeight = bounds.height - margin.top - margin.bottom
  const plottedPrices = priceData.flatMap((candle) => [candle.low, candle.high])
  const lowest = Math.min(...plottedPrices)
  const highest = Math.max(...plottedPrices)
  const padding = Math.max((highest - lowest) * 0.08, highest * 0.0005)
  const minimum = lowest - padding
  const maximum = highest + padding
  const range = maximum - minimum || 1
  const priceCandleSlot = plotWidth / priceData.length
  const bodyWidth = Math.max(0.2, Math.min(7, priceCandleSlot * 0.68))
  const y = (price) => margin.top + ((maximum - price) / range) * priceHeight

  context.font = "10px ui-monospace, monospace"
  context.textAlign = "left"
  context.textBaseline = "middle"
  for (let line = 0; line <= 5; line++) {
    const lineY = margin.top + (priceHeight / 5) * line
    context.strokeStyle = "rgba(92, 108, 135, 0.13)"
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(margin.left, lineY)
    context.lineTo(bounds.width - margin.right, lineY)
    context.stroke()
    const value = maximum - (range / 5) * line
    context.fillStyle = "#718096"
    context.fillText(
      number.format(value),
      bounds.width - margin.right + 8,
      lineY,
    )
  }

  priceData.forEach((candle, index) => {
    const x = margin.left + priceCandleSlot * index + priceCandleSlot / 2
    const rising = candle.close >= candle.open
    const color = rising ? "#07865f" : "#d93c57"
    context.strokeStyle = color
    context.fillStyle = color
    context.lineWidth = liveMinute?.time === candle.time ? 1.5 : Math.max(0.2, Math.min(1, priceCandleSlot * 0.45))
    context.beginPath()
    context.moveTo(x, y(candle.high))
    context.lineTo(x, y(candle.low))
    context.stroke()
    const top = y(Math.max(candle.open, candle.close))
    const bottom = y(Math.min(candle.open, candle.close))
    context.fillRect(
      x - bodyWidth / 2,
      top,
      bodyWidth,
      Math.max(1, bottom - top),
    )
  })

  const labelCount = Math.min(6, priceData.length)
  context.textAlign = "center"
  context.textBaseline = "top"
  context.fillStyle = "#718096"
  for (let label = 0; label < labelCount; label++) {
    const index = Math.round(
      (label * (priceData.length - 1)) / Math.max(1, labelCount - 1),
    )
    const x = margin.left + priceCandleSlot * index + priceCandleSlot / 2
    context.fillText(
      axisTime.format(new Date(priceData[index].time * 1000)),
      x,
      bounds.height - margin.bottom + 11,
    )
  }
}

function showToast(message, kind) {
  clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.dataset.kind = kind
  elements.toast.classList.add("visible")
  toastTimer = setTimeout(
    () => elements.toast.classList.remove("visible"),
    4500,
  )
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ],
  )
}

function updateClock() {
  elements.liveTime.textContent = `Live time: ${time.format(new Date())} IST`
}

updateClock()
setInterval(updateClock, 1000)
void selectStock(NIFTY50_SYMBOL)
setInterval(() => {
  if (selectedSymbol === NIFTY50_SYMBOL) void selectStock(NIFTY50_SYMBOL)
}, 60_000)
refreshControlStatus().catch(() => {})
refreshDirectionalShares().catch(() => {})
void refreshPositions()
setInterval(refreshPositions, 3_000)
