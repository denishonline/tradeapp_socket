import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

// One writer per process; UUID filenames prevent collisions across restarts.
export async function createMarketHistory({
  directory,
  flushIntervalMs = 250,
  maxBufferBytes = 16 * 1024 * 1024,
  maxFileBytes = 64 * 1024 * 1024,
  onError = (error) => console.error("Market history recording failed:", error.message),
  append = appendFile,
}) {
  await mkdir(directory, { recursive: true })
  const sessionId = randomUUID()
  let sequence = 0
  let queue = []
  let bufferedBytes = 0
  let writing = null
  let timer = null
  let closed = false
  let failure = null
  let writtenRecords = 0
  let rejectedRecords = 0
  let lastWrittenAt = null
  let fileDate = null
  let fileBytes = 0
  let part = 0
  let currentFile = null

  function fail(error) {
    if (failure) return
    failure = error
    clearTimeout(timer)
    timer = null
    // No automatic retry: an append may have partially written before failing.
    queue = []
    bufferedBytes = 0
    onError(error)
  }

  function status() {
    return {
      state: failure ? "error" : closed ? "closed" : "recording",
      sessionId,
      acceptedRecords: sequence,
      writtenRecords,
      rejectedRecords,
      bufferedBytes,
      lastWrittenAt,
      currentFile,
      error: failure?.message ?? null,
    }
  }

  function record(kind, data, receivedAt = new Date()) {
    if (closed || failure) {
      rejectedRecords++
      return false
    }
    const line = JSON.stringify({
      schemaVersion: 1,
      sessionId,
      sequence: sequence + 1,
      receivedAt: receivedAt.toISOString(),
      receivedMonotonicNs: process.hrtime.bigint().toString(),
      kind,
      data,
    }) + "\n"
    const bytes = Buffer.byteLength(line)
    if (bufferedBytes + bytes > maxBufferBytes) {
      rejectedRecords++
      fail(new Error("History buffer capacity exceeded; recording stopped. Restart after checking disk throughput."))
      return false
    }
    sequence++
    // Files are partitioned by receipt date in India, not exchange timestamps.
    const date = new Date(receivedAt.getTime() + 330 * 60_000).toISOString().slice(0, 10)
    queue.push({ line, bytes, date })
    bufferedBytes += bytes
    if (!timer && !writing) timer = setTimeout(() => { void flush() }, flushIntervalMs)
    return true
  }

  async function drain() {
    while (queue.length && !failure) {
      const batch = queue
      queue = []
      let index = 0
      while (index < batch.length && !failure) {
        const first = batch[index]
        if (fileDate !== first.date || fileBytes + first.bytes > maxFileBytes) {
          fileDate = first.date
          fileBytes = 0
          part++
          const dayDirectory = path.join(directory, fileDate)
          await mkdir(dayDirectory, { recursive: true })
          currentFile = path.join(dayDirectory, `${sessionId}-${String(part).padStart(5, "0")}.jsonl`)
        }
        const lines = []
        let bytes = 0
        while (index < batch.length && batch[index].date === fileDate) {
          const item = batch[index]
          if (lines.length && fileBytes + bytes + item.bytes > maxFileBytes) break
          lines.push(item.line)
          bytes += item.bytes
          index++
        }
        await append(currentFile, lines.join(""), "utf8")
        if (failure) return
        fileBytes += bytes
        bufferedBytes -= bytes
        writtenRecords += lines.length
        lastWrittenAt = new Date().toISOString()
      }
    }
  }

  function flush() {
    clearTimeout(timer)
    timer = null
    if (!writing && !failure) {
      writing = drain().catch(fail).finally(() => { writing = null })
    }
    return writing ?? Promise.resolve()
  }

  async function close() {
    closed = true
    await flush()
    if (failure) throw failure
  }

  return { record, flush, close, status }
}
