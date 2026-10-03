import { mkdir, open } from "node:fs/promises"
import path from "node:path"

// Each stock and option file remains valid JSON. Appends replace only the final
// closing bracket, so a long-running session does not rewrite the full history.
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

  async function prepareOne(contract) {
    if (!contract || typeof contract.symbol !== "string" || !contract.symbol.startsWith("NSE:") ||
        typeof contract.underlying !== "string" || !contract.underlying.startsWith("NSE:") ||
        !["CE", "PE"].includes(contract.optionType)) {
      throw new TypeError("Invalid option contract for depth history")
    }
    const stock = contract.underlying.slice(4).replace(/-EQ$/, "")
    const filename = contract.symbol.slice(4)
    return prepareFile({ symbol: contract.symbol, stock, filename: `${filename}.json` })
  }

  async function prepareStock(stock) {
    const symbol = `NSE:${stock}-EQ`
    return prepareFile({ symbol, stock, filename: `${stock}.json` })
  }

  async function prepareFile({ symbol, stock, filename }) {
    if (!/^[A-Z0-9&._-]+$/i.test(stock) || !/^[A-Z0-9&._-]+\.json$/i.test(filename)) {
      throw new TypeError("Unsafe stock or market symbol in depth history")
    }
    if (files.has(symbol)) return
    if (preparing.has(symbol)) return preparing.get(symbol)

    const task = (async () => {
      if (closed || failure) throw failure || new Error("Market depth history is closed")
      const stockDirectory = path.join(directory, stock)
      await mkdir(stockDirectory, { recursive: true })
      const fullPath = path.join(stockDirectory, filename)
      let handle
      try {
        handle = await open(fullPath, "r+")
      } catch (error) {
        if (error.code !== "ENOENT") throw error
        handle = await open(fullPath, "wx+")
        const header = JSON.stringify({ schemaVersion: 1, stock, symbol, history: [] }) + "\n"
        await handle.writeFile(header, "utf8")
      }

      try {
        const info = await handle.stat()
        if (info.size < 3) throw new Error(`Invalid market depth history file: ${fullPath}`)
        const suffix = Buffer.alloc(3)
        const suffixRead = await handle.read(suffix, 0, 3, info.size - 3)
        if (suffixRead.bytesRead !== 3 || suffix.toString("utf8") !== "]}\n") {
          throw new Error(`Market depth history file has an incomplete JSON tail: ${fullPath}`)
        }
        const bracketPosition = info.size - 3
        const prior = Buffer.alloc(1)
        const priorRead = await handle.read(prior, 0, 1, bracketPosition - 1)
        if (priorRead.bytesRead !== 1 || !["[", "}"].includes(prior.toString("utf8"))) {
          throw new Error(`Market depth history file has an invalid history array: ${fullPath}`)
        }
        files.set(symbol, {
          path: fullPath,
          bracketPosition,
          hasRecords: prior.toString("utf8") === "}",
        })
      } finally {
        await handle.close()
      }
    })()

    preparing.set(symbol, task)
    try {
      await task
    } finally {
      preparing.delete(symbol)
    }
  }

  async function prepare(contracts) {
    try {
      await Promise.all(contracts.map(prepareOne))
    } catch (error) {
      fail(error)
      throw error
    }
  }

  async function prepareStocks(stocks) {
    try {
      await Promise.all(stocks.map(prepareStock))
    } catch (error) {
      fail(error)
      throw error
    }
  }

  function record(contract, data, receivedAt = new Date()) {
    if (closed || failure) {
      rejectedRecords++
      return false
    }
    const file = files.get(contract?.symbol)
    if (!file) {
      rejectedRecords++
      return false
    }
    let serialized
    try {
      serialized = JSON.stringify({ receivedAt: receivedAt.toISOString(), data })
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
    const items = queue.get(contract.symbol) || []
    items.push(serialized)
    queue.set(contract.symbol, items)
    bufferedBytes += bytes
    acceptedRecords++
    if (!timer && !writing) timer = setTimeout(() => { void flush() }, flushIntervalMs)
    return true
  }

  async function writeAll(handle, value, position) {
    const data = Buffer.from(value, "utf8")
    let offset = 0
    while (offset < data.length) {
      const result = await handle.write(data, offset, data.length - offset, position + offset)
      if (!result.bytesWritten) throw new Error("Could not append market depth history")
      offset += result.bytesWritten
    }
  }

  async function drain() {
    while (queue.size && !failure) {
      const batch = queue
      queue = new Map()
      for (const [symbol, records] of batch) {
        const file = files.get(symbol)
        if (!file) throw new Error(`Market depth history file was not prepared for ${symbol}`)
        const joined = records.join(",")
        const prefix = file.hasRecords ? "," : ""
        const suffix = `${prefix}${joined}]}\n`
        const handle = await open(file.path, "r+")
        try {
          await handle.truncate(file.bracketPosition)
          await writeAll(handle, suffix, file.bracketPosition)
        } finally {
          await handle.close()
        }
        file.bracketPosition += Buffer.byteLength(prefix + joined)
        file.hasRecords = true
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

  return { prepare, prepareStocks, record, flush, close, status }
}
