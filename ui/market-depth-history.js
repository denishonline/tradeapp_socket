import { appendFile, mkdir, open } from "node:fs/promises"
import path from "node:path"
import { marketDepthSession } from "./market-depth.js"

// Daily JSONL files keep each depth update independently appendable.
export async function createMarketDepthHistory({
  directory,
  flushIntervalMs = 250,
  maxBufferBytes = 16 * 1024 * 1024,
  onError = (error) => console.error("Market depth history recording failed:", error.message),
}) {
  const files = new Map()
  const preparing = new Map()
  let queue = new Map()
  let bufferedBytes = 0
  let writing = null
  let timer = null
  let closed = false
  let failure = null
  let acceptedRecords = 0
  let writtenRecords = 0
  let rejectedRecords = 0
  let lastWrittenAt = null

  function status() {
    return {
      state: failure ? "error" : closed ? "closed" : "recording",
      symbols: files.size,
      acceptedRecords,
      writtenRecords,
      rejectedRecords,
      bufferedBytes,
      lastWrittenAt,
      error: failure?.message ?? null,
    }
  }

  function fail(error) {
    if (failure) return
    failure = error
    clearTimeout(timer)
    timer = null
    queue = new Map()
    bufferedBytes = 0
    onError(error)
  }

  function fileKey(symbol, date) {
    return `${date}|${symbol}`
  }

  async function prepareStock(stock, date = marketDepthSession(new Date()).date) {
    const symbol = `NSE:${stock}-EQ`
    return prepareFile({ symbol, stock, filename: `${stock}.jsonl`, date })
  }

  async function prepareFile({ symbol, stock, filename, date }) {
    if (!/^[A-Z0-9&._-]+$/i.test(stock) || !/^[A-Z0-9&._-]+\.jsonl$/i.test(filename) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new TypeError("Unsafe stock or market symbol in depth history")
    }
    const key = fileKey(symbol, date)
    if (files.has(key)) return
    if (preparing.has(key)) return preparing.get(key)

    const task = (async () => {
      if (closed || failure) throw failure || new Error("Market depth history is closed")
      const stockDirectory = path.join(directory, date, stock)
      await mkdir(stockDirectory, { recursive: true })
      const fullPath = path.join(stockDirectory, filename)
      const handle = await open(fullPath, "a")
      await handle.close()
      files.set(key, { path: fullPath })
    })()

    preparing.set(key, task)
    try {
      await task
    } finally {
      preparing.delete(key)
    }
  }

  async function prepareStocks(stocks) {
    try {
      const date = marketDepthSession(new Date()).date
      await Promise.all(stocks.map((stock) => prepareStock(stock, date)))
    } catch (error) {
      fail(error)
      throw error
    }
  }

  function record(contract, data, receivedAt = new Date(), book = null, marketContext = null) {
    if (closed || failure) {
      rejectedRecords++
      return false
    }
    const date = marketDepthSession(receivedAt).date
    const key = fileKey(contract?.symbol, date)
    const file = files.get(key)
    if (!file) {
      rejectedRecords++
      return false
    }
    let serialized
    try {
      serialized = JSON.stringify({
        schemaVersion: 1,
        kind: book ? "checkpoint" : "update",
        receivedAt: receivedAt.toISOString(),
        data,
        ...(marketContext ? { marketContext } : {}),
        ...(book ? { book } : {}),
      })
    } catch (error) {
      rejectedRecords++
      fail(error)
      return false
    }
    if (typeof serialized !== "string") {
      rejectedRecords++
      return false
    }
    const bytes = Buffer.byteLength(serialized)
    if (bufferedBytes + bytes > maxBufferBytes) {
      rejectedRecords++
      fail(new Error("Market depth history buffer capacity exceeded; recording stopped."))
      return false
    }
    const items = queue.get(key) || []
    items.push(serialized)
    queue.set(key, items)
    bufferedBytes += bytes
    acceptedRecords++
    if (!timer && !writing) timer = setTimeout(() => { void flush() }, flushIntervalMs)
    return true
  }

  async function drain() {
    while (queue.size && !failure) {
      const batch = queue
      queue = new Map()
      for (const [key, records] of batch) {
        const file = files.get(key)
        if (!file) throw new Error(`Market depth history file was not prepared for ${key}`)
        await appendFile(file.path, `${records.join("\n")}\n`, "utf8")
        bufferedBytes -= records.reduce((total, item) => total + Buffer.byteLength(item), 0)
        writtenRecords += records.length
        lastWrittenAt = new Date().toISOString()
      }
    }
  }

  async function flush() {
    clearTimeout(timer)
    timer = null
    await Promise.allSettled([...preparing.values()])
    if (!writing && !failure) {
      writing = drain().catch(fail).finally(() => { writing = null })
    }
    await (writing ?? Promise.resolve())
  }

  async function close() {
    closed = true
    await flush()
    files.clear()
    if (failure) throw failure
  }

  return { prepareStocks, record, flush, close, status }
}
