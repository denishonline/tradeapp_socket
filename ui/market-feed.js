import apiV3 from "fyers-api-v3"
import { normalizeTick, toFyersSymbol, toStockName } from "./market-data.js"
import { indexOptionContracts, selectNearAtmOptions } from "./option-chain.js"
import { depthUpdateFields, marketDepthSession } from "./market-depth.js"

const { fyersDataSocket: FyersDataSocket } = apiV3

export function createMarketFeed({
  io, stocks, clientId, accessToken, history, socketFactory = FyersDataSocket,
  optionContracts = new Map(), depthHistory,
  onMarket = () => {}, onGap = () => {}, onReady = () => {}, clock = () => new Date(),
}) {
  const allowedStocks = new Set(stocks)
  const stockSymbols = stocks.map(toFyersSymbol)
  const contractMap = optionContracts instanceof Map ? optionContracts : new Map()
  const optionIndex = indexOptionContracts(contractMap)
  const stockDepthFiles = new Map(stocks.map((stock) => {
    const symbol = toFyersSymbol(stock)
    return [symbol, { symbol }]
  }))
  const prices = new Map()
  const selectedByStock = new Map()
  const selectedOptionSymbolSet = new Set()
  const preparedOptionSymbols = new Set()
  const depthSubscribedSymbols = new Set()
  let dataSocket = null
  let stopping = false
  let started = false
  let terminalError = false
  let connected = false
  let connectionEpoch = 0
  let optionSyncRequested = false
  let optionSyncRunning = null
  let depthStorageError = null
  let optionDepthReceived = 0
  let depthStateDate = null
  const depthFieldState = new Map()
  const received = { price: 0, depth: 0 }
  const lastReceived = new Map()
  let lastDepthAt = null
  let status = createStatus("stopped", "Market stream is stopped")

  function publishStatus(state, message) {
    if (state !== "live") {
      onGap()
      depthStateDate = null
      depthFieldState.clear()
    }
    else onReady()
    status = createStatus(state, message)
    history?.record("feed_status", status)
    io.emit("feed:status", status)
  }

  function snapshot() {
    return stocks.map((symbol) => ({
      symbol,
      price: null,
      change: null,
      changePercent: null,
      updatedAt: null,
      ...prices.get(symbol),
    }))
  }

  function sendSnapshot(socket) {
    socket.emit("stocks:snapshot", snapshot())
    socket.emit("feed:status", status)
  }

  function selectedOptionSymbols() {
    return new Set([...selectedOptionSymbolSet].filter((symbol) => preparedOptionSymbols.has(symbol)))
  }

  function depthBookUpdate(message, receivedAt) {
    const session = marketDepthSession(receivedAt)
    if (!session.open) return false
    const fields = depthUpdateFields(message)
    if (!fields) return false
    if (depthStateDate !== session.date) {
      depthFieldState.clear()
      depthStateDate = session.date
    }
    const previous = depthFieldState.get(message.symbol) || new Map()
    const next = new Map(previous)
    for (const [key, value] of fields) next.set(key, value)
    depthFieldState.set(message.symbol, next)
    return {
      bids: depthLevels(next, "bid"),
      asks: depthLevels(next, "ask"),
    }
  }

  function depthLevels(fields, side) {
    return Array.from({ length: 5 }, (_, index) => {
      const level = index + 1
      return {
        level,
        price: fields.get(`${side}_price${level}`) ?? null,
        size: fields.get(`${side}_size${level}`) ?? null,
        orders: fields.get(`${side}_order${level}`) ?? null,
      }
    })
  }

  function requestOptionDepthSync() {
    optionSyncRequested = true
    if (optionSyncRunning) return optionSyncRunning
    optionSyncRunning = (async () => {
      while (optionSyncRequested && !stopping) {
        optionSyncRequested = false
        if (!connected) continue
        const epoch = connectionEpoch
        const desired = new Set([...stockSymbols, ...selectedOptionSymbols()])
        const additions = [...desired].filter((symbol) => !depthSubscribedSymbols.has(symbol))
        const removals = [...depthSubscribedSymbols].filter((symbol) => !desired.has(symbol))
        let changed = false
        if (additions.length) {
          await dataSocket.subscribe(additions, true, 1)
          if (stopping || !connected || epoch !== connectionEpoch) continue
          for (const symbol of additions) depthSubscribedSymbols.add(symbol)
          changed = true
        }
        if (removals.length) {
          await dataSocket.unsubscribe(removals, true, 1)
          if (stopping || !connected || epoch !== connectionEpoch) continue
          for (const symbol of removals) depthSubscribedSymbols.delete(symbol)
          changed = true
        }
        if (changed && status.state === "live") {
          publishStatus("live", liveMessage())
        }
      }
    })().catch((error) => {
      if (!stopping) failFeed(error)
    }).finally(() => {
      optionSyncRunning = null
      if (optionSyncRequested && connected && !stopping) void requestOptionDepthSync()
    })
    return optionSyncRunning
  }

  function updateOptionSelection(stock, spot) {
    if (!depthHistory || !contractMap.size) return
    const contracts = selectNearAtmOptions(optionIndex, toFyersSymbol(stock), spot)
    const key = contracts.map((contract) => contract.symbol).sort().join("|")
    const previous = selectedByStock.get(stock) || []
    if (key === previous.map((contract) => contract.symbol).sort().join("|")) return

    selectedByStock.set(stock, contracts)
    selectedOptionSymbolSet.clear()
    for (const selected of selectedByStock.values()) {
      for (const contract of selected) selectedOptionSymbolSet.add(contract.symbol)
    }
    void depthHistory.prepare(contracts).then(() => {
      for (const contract of contracts) preparedOptionSymbols.add(contract.symbol)
      if (!stopping) void requestOptionDepthSync()
    }).catch((error) => {
      depthStorageError = error.message
      console.error(`Cannot prepare option depth files for ${stock}:`, error.message)
    })
  }

  function liveMessage() {
    return `Live - ${stocks.length} NSE stocks and ${selectedOptionSymbols().size} option contracts subscribed`
  }

  function markReconnecting() {
    if (stopping || terminalError) return
    connectionEpoch++
    connected = false
    depthSubscribedSymbols.clear()
    publishStatus("reconnecting", status.state === "reconnecting"
      ? status.message
      : "Market feed disconnected - reconnecting...")
  }

  function failFeed(error) {
    if (stopping || terminalError) return
    terminalError = true
    connectionEpoch++
    connected = false
    depthSubscribedSymbols.clear()
    publishStatus("error", retryMessage(error))
    try {
      dataSocket?.close()
    } catch {
      // Keep the terminal error visible if the SDK socket is already closed.
    }
  }

  function receive(message) {
    if (stopping) return
    const messages = Array.isArray(message) ? message : [message]

    for (const item of messages) {
      if (!item || typeof item !== "object") continue
      if (item.s === "error" || item.type === "error") {
        failFeed(item)
        return
      }
      const receivedAt = clock()
      if (item.type === "dp") {
        const stock = toStockName(item.symbol)
        const isStock = allowedStocks.has(stock)
        const optionContract = isStock ? null : contractMap.get(item.symbol)
        const optionStock = optionContract ? toStockName(optionContract.underlying) : null
        if (!isStock && (!optionContract || !allowedStocks.has(optionStock) || !selectedOptionSymbolSet.has(item.symbol))) continue
        const book = depthBookUpdate(item, receivedAt)
        if (!book) continue
        if (isStock) {
          // Keep every valid partial update plus the reconstructed top-five book.
          history?.record("depth", item, receivedAt)
          depthHistory?.record(stockDepthFiles.get(item.symbol), item, receivedAt, book)
          onMarket("depth", item, receivedAt)
          received.depth++
          lastDepthAt = receivedAt.toISOString()
          lastReceived.set(stock, { ...lastReceived.get(stock), depth: receivedAt.toISOString() })
        } else {
          depthHistory?.record(optionContract, item, receivedAt, book)
          optionDepthReceived++
          lastDepthAt = receivedAt.toISOString()
          lastReceived.set(optionStock, {
            ...lastReceived.get(optionStock),
            optionDepth: receivedAt.toISOString(),
          })
        }
        continue
      }

      const isPrice = item.type === "sf" ||
        (item.ltp != null && item.ltp !== "" && Number.isFinite(Number(item.ltp)))
      const tick = normalizeTick(item)
      if (!isPrice || !tick || !allowedStocks.has(tick.symbol)) continue

      history?.record("price", item, receivedAt)
      onMarket("price", item, receivedAt)
      received.price++
      lastReceived.set(tick.symbol, { ...lastReceived.get(tick.symbol), price: receivedAt.toISOString() })

      const previous = prices.get(tick.symbol)
      const next = {
        ...tick,
        direction:
          previous?.price === undefined || previous.price === tick.price
            ? "flat"
            : tick.price > previous.price
              ? "up"
              : "down",
      }

      prices.set(tick.symbol, next)
      io.emit("stocks:update", next)
      updateOptionSelection(tick.symbol, tick.price)
    }
  }

  function start() {
    if (started) return false
    started = true
    stopping = false
    publishStatus("connecting", "Connecting to FYERS market data...")
    history?.record("session_start", {
      symbols: stockSymbols,
      priceMode: "full",
      priceChannel: 1,
      depthChannel: 1,
      optionDepthSelection: "nearest expiry, ATM and one listed strike on each side, CE and PE",
      sdk: "fyers-api-v3",
    })
    if (!clientId || !accessToken) {
      publishStatus("error", "FYERS credentials are missing. Run AutoLogin first.")
      return false
    }

    try {
      const authorizationKey = accessToken.includes(":")
        ? accessToken
        : `${clientId}:${accessToken}`

      dataSocket = socketFactory.getInstance(authorizationKey)

      dataSocket.on("connect", async () => {
        if (stopping || terminalError) return
        const epoch = ++connectionEpoch
        connected = false
        depthSubscribedSymbols.clear()
        try {
          publishStatus("connecting", "Requesting full price and market-depth subscriptions...")
          await dataSocket.subscribe(stockSymbols, false, 1)
          if (stopping || epoch !== connectionEpoch) return
          await dataSocket.mode(dataSocket.FullMode, 1)
          if (stopping || epoch !== connectionEpoch) return
          // Keep quote and depth subscriptions on channel 1 for this SDK version.
          const depthSymbols = [...new Set([...stockSymbols, ...selectedOptionSymbols()])]
          await dataSocket.subscribe(depthSymbols, true, 1)
          if (stopping || epoch !== connectionEpoch) return
          for (const symbol of depthSymbols) depthSubscribedSymbols.add(symbol)
          connected = true
          publishStatus(
            "live",
            `Live · ${stocks.length} NSE stocks and ${selectedOptionSymbols().size} option contracts subscribed`,
          )
          void requestOptionDepthSync()
        } catch (error) {
          if (!stopping && epoch === connectionEpoch) failFeed(error)
        }
      })

      dataSocket.on("message", receive)
      dataSocket.on("error", (error) => {
        if (stopping) return
        failFeed(error)
      })
      dataSocket.on("close", () => {
        if (stopping) return
        if (terminalError) return
        markReconnecting()
      })

      dataSocket.autoreconnect(20)
      dataSocket.connect()
      return true
    } catch (error) {
      terminalError = true
      publishStatus("error", `Could not initialize FYERS market feed: ${retryMessage(error)}`)
      return false
    }
  }

  async function stop() {
    if (stopping) return
    stopping = true
    connected = false
    connectionEpoch++
    started = false
    history?.record("session_end", { reason: "shutdown", received })
    try {
      dataSocket?.close()
    } catch {
      // The process is already shutting down, so no further action is needed.
    }
    await depthHistory?.flush()
  }

  function getStatus() {
    return {
      ...status,
      connected,
      received: { ...received },
      lastReceived: Object.fromEntries(lastReceived),
      depthSubscribedSymbols: depthSubscribedSymbols.size,
      lastDepthAt,
      optionDepth: {
        received: optionDepthReceived,
        selectedSymbols: selectedOptionSymbols().size,
        storageError: depthStorageError,
      },
    }
  }

  return { sendSnapshot, snapshot, start, stop, getStatus }
}

function createStatus(state, message) {
  return { state, message, updatedAt: new Date().toISOString() }
}

function retryMessage(error) {
  let message =
    typeof error === "string"
      ? error
      : error?.message || error?.msg || "Unable to connect to Fyers market data."

  message = String(message)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted token]")
    .slice(0, 240)

  if (/token|auth|jwt|expired|unauthor/i.test(message)) {
    return `FYERS feed authentication failed: ${message}. Run AutoLogin and try again.`
  }

  return `FYERS market feed failed: ${message}.`
}
