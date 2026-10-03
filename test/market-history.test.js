import assert from "node:assert/strict"
import { it } from "node:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createMarketHistory } from "../ui/market-history.js"

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "market-history-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const recorder = await createMarketHistory({ directory, ...options })
  t.after(() => recorder.close().catch(() => {}))
  return { directory, recorder }
}

async function readRecords(directory) {
  const records = []
  for (const day of (await readdir(directory)).sort()) {
    for (const file of (await readdir(path.join(directory, day))).sort()) {
      const text = await readFile(path.join(directory, day, file), "utf8")
      records.push(...text.trim().split("\n").map(JSON.parse))
    }
  }
  return records
}

it("preserves every payload, duplicate, partial depth update and receipt order", async (t) => {
  const { directory, recorder } = await fixture(t)
  const tick = { type: "dp", symbol: "NSE:SBIN-EQ", bid_price1: 100, bid_size1: 50 }
  recorder.record("depth", tick)
  recorder.record("depth", tick)
  recorder.record("depth", { type: "dp", symbol: tick.symbol, bid_size1: 25 })
  recorder.record("price", { symbol: tick.symbol, ltp: 100.1, vol_traded_today: 800 })
  await recorder.close()
  const records = await readRecords(directory)
  assert.deepEqual(records.map((r) => r.sequence), [1, 2, 3, 4])
  assert.deepEqual(records[0].data, tick)
  assert.deepEqual(records[1].data, tick)
  assert.equal(records[2].data.bid_price1, undefined)
  assert.equal(records[3].data.vol_traded_today, 800)
  assert.ok(records.every((r) => r.receivedAt && r.receivedMonotonicNs))
  assert.equal(recorder.status().writtenRecords, 4)
  assert.equal(recorder.status().bufferedBytes, 0)
})

it("rotates at IST midnight and by file size without overwriting records", async (t) => {
  const { directory, recorder } = await fixture(t, { maxFileBytes: 1 })
  recorder.record("depth", {}, new Date("2026-10-01T18:29:59Z"))
  recorder.record("depth", {}, new Date("2026-10-01T18:30:00Z"))
  recorder.record("depth", {}, new Date("2026-10-01T18:30:01Z"))
  await recorder.close()
  assert.deepEqual((await readdir(directory)).sort(), ["2026-10-01", "2026-10-02"])
  assert.equal((await readdir(path.join(directory, "2026-10-02"))).length, 2)
  assert.equal((await readRecords(directory)).length, 3)
})

it("flushes automatically and keeps independent sessions across restarts", async (t) => {
  const { directory, recorder } = await fixture(t, { flushIntervalMs: 5 })
  recorder.record("depth", { bid_size1: 10 })
  for (let attempt = 0; attempt < 100 && !recorder.status().writtenRecords; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(recorder.status().writtenRecords, 1)
  await recorder.close()
  const second = await createMarketHistory({ directory })
  second.record("depth", { bid_size1: 20 })
  await second.close()
  const records = await readRecords(directory)
  assert.equal(records.length, 2)
  assert.equal(new Set(records.map((r) => r.sessionId)).size, 2)
})

it("drains records arriving during a pending disk append before closing", async (t) => {
  let release
  let began
  const started = new Promise((resolve) => { began = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const writes = []
  const { recorder } = await fixture(t, {
    append: async (_file, text) => { began(); await gate; writes.push(text) },
  })
  recorder.record("depth", { bid_size1: 10 })
  const flushing = recorder.flush()
  await started
  recorder.record("depth", { bid_size1: 20 })
  const closing = recorder.close()
  release()
  await Promise.all([flushing, closing])
  assert.equal(writes.length, 2)
  assert.equal(recorder.status().writtenRecords, 2)
  assert.equal(recorder.status().bufferedBytes, 0)
})

it("reports disk errors and refuses further recording instead of silently losing data", async (t) => {
  const errors = []
  const { recorder } = await fixture(t, {
    append: async () => { throw new Error("Disk full") },
    onError: (error) => errors.push(error.message),
  })
  recorder.record("depth", { bid_size1: 10 })
  await recorder.flush()
  assert.equal(recorder.status().state, "error")
  assert.equal(recorder.status().writtenRecords, 0)
  assert.equal(recorder.record("depth", {}), false)
  assert.equal(recorder.status().rejectedRecords, 1)
  assert.deepEqual(errors, ["Disk full"])
  await assert.rejects(recorder.close(), /Disk full/)
})

it("bounds the pending buffer and surfaces overflow", async (t) => {
  const { recorder } = await fixture(t, { maxBufferBytes: 1, onError: () => {} })
  assert.equal(recorder.record("depth", {}), false)
  assert.equal(recorder.status().state, "error")
  assert.match(recorder.status().error, /capacity exceeded/)
  await assert.rejects(recorder.close(), /capacity exceeded/)
})
