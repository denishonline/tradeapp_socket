import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, it } from "node:test"
import {
  createCandleStore,
  createHistoryPreloader,
  createLiveCandleBuilder,
  isNseCandleMinute,
  normalizeCandle,
} from "../ui/candles.js"

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tradeapp-candles-"))
  temporaryDirectories.push(directory)
  return { directory, store: await createCandleStore({ directory, symbols: ["SBIN"] }) }
}

const epoch = (iso) => Date.parse(iso) / 1000
const friday0915 = epoch("2026-10-02T03:45:00.000Z")
const candle = (time, close = 100, source = "test") => ({
  time, open: 100, high: Math.max(101, close), low: 99, close, volume: 10, source,
})

it("fills only missing history and never overwrites or removes stored candles", async () => {
  const { store } = await fixture()
  await store.append("SBIN", candle(friday0915 + 60, 103, "websocket"))
  const result = await store.fillMissingHistory("SBIN", [
    candle(friday0915, 100, "fyers-history"),
    candle(friday0915 + 60, 101, "fyers-history"),
  ])

  const stored = await store.read("SBIN", { limit: 10 })
  assert.deepEqual(stored.map((item) => item.time), [friday0915, friday0915 + 60])
  assert.equal(stored[1].close, 103)
  assert.equal(stored[1].source, "websocket")
  assert.deepEqual(result, { total: 2, added: 1, duplicate: 1, invalid: 0 })
})

it("does not add duplicate candle lines and canonicalizes existing duplicates", async () => {
  const { directory, store } = await fixture()
  const first = candle(friday0915)
  assert.equal((await store.append("SBIN", first)).added, true)
  assert.equal((await store.append("SBIN", { ...first, close: 101 })).added, false)
  let lines = (await readFile(path.join(directory, "SBIN.jsonl"), "utf8")).trim().split(/\r?\n/)
  assert.equal(lines.length, 1)

  const duplicateDirectory = await mkdtemp(path.join(os.tmpdir(), "tradeapp-candles-"))
  temporaryDirectories.push(duplicateDirectory)
  await writeFile(path.join(duplicateDirectory, "SBIN.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify(first)}\nnot-json\n`)
  const cleanStore = await createCandleStore({ directory: duplicateDirectory, symbols: ["SBIN"] })
  await cleanStore.read("SBIN")
  lines = (await readFile(path.join(duplicateDirectory, "SBIN.jsonl"), "utf8")).trim().split(/\r?\n/)
  assert.equal(lines.length, 1)
})

it("requires real volume growth, skips the first partial minute, and persists a completed minute", async () => {
  const stored = []
  const emitted = []
  const store = { append: async (symbol, value) => { stored.push({ symbol, value }); return { added: true } } }
  const io = { emit: (...args) => emitted.push(args) }
  const builder = createLiveCandleBuilder({ store, io })
  const at = (seconds) => new Date((friday0915 + 15 * 60 + seconds) * 1000)
  const tick = (ltp, volume, seconds) => ({
    symbol: "NSE:SBIN-EQ", ltp, vol_traded_today: volume,
    last_traded_time: friday0915 + 15 * 60 + seconds,
  })

  assert.equal(builder.observe(tick(100, 100, 1), at(1)), false) // baseline only
  assert.equal(builder.observe(tick(105, 100, 10), at(10)), false) // no traded volume
  assert.equal(builder.observe(tick(102, 107, 20), at(20)), true) // partial first minute
  assert.equal(builder.observe(tick(99, 110, 61), at(61)), true)
  assert.equal(builder.observe(tick(101, 115, 80), at(80)), true)
  assert.equal(builder.observe(tick(100, 116, 121), at(121)), true)
  await new Promise((resolve) => setImmediate(resolve))
  builder.close()

  assert.equal(stored.length, 1)
  assert.equal(stored[0].symbol, "SBIN")
  assert.deepEqual(stored[0].value, {
    time: friday0915 + 16 * 60,
    open: 99, high: 101, low: 99, close: 101, volume: 8, source: "websocket",
  })
  assert.ok(emitted.some(([event]) => event === "candle:update"))
  assert.ok(emitted.some(([event]) => event === "candle:complete"))
})

it("rejects missing source timestamps, stale ticks, and all out-of-session ticks", async () => {
  const stored = []
  const builder = createLiveCandleBuilder({
    store: { append: async (...args) => stored.push(args) },
    io: { emit() {} },
  })
  const outside = epoch("2026-10-02T03:44:00.000Z") // 09:14 IST
  assert.equal(builder.observe({ symbol: "NSE:SBIN-EQ", ltp: 100, vol_traded_today: 1 }, new Date(outside * 1000)), false)
  assert.equal(builder.observe({ symbol: "NSE:SBIN-EQ", ltp: 100, vol_traded_today: 2, last_traded_time: outside }, new Date(outside * 1000)), false)
  assert.equal(builder.observe({ symbol: "NSE:SBIN-EQ", ltp: 100, vol_traded_today: 3, last_traded_time: friday0915 }, new Date((friday0915 + 300) * 1000)), false)
  builder.close()
  assert.equal(stored.length, 0)
})

it("validates NSE session, exact minute alignment, OHLC relationships and integer volume", () => {
  assert.equal(isNseCandleMinute(friday0915), true)
  assert.equal(isNseCandleMinute(epoch("2026-10-02T09:59:00.000Z")), true) // 15:29 IST
  assert.equal(isNseCandleMinute(epoch("2026-10-02T10:00:00.000Z")), false) // 15:30 IST
  assert.equal(isNseCandleMinute(epoch("2026-10-03T03:45:00.000Z")), false) // Saturday
  assert.ok(normalizeCandle(candle(friday0915)))
  assert.equal(normalizeCandle(candle(friday0915 + 1)), null)
  assert.equal(normalizeCandle({ ...candle(friday0915), high: 99 }), null)
  assert.equal(normalizeCandle({ ...candle(friday0915), volume: 1.5 }), null)
})

it("fetches 30 days but submits only valid exchange candles to additive storage", async () => {
  const fills = []
  const calls = []
  const client = {
    setAppId(value) { this.appId = value },
    setAccessToken(value) { this.token = value },
    async getHistory(payload) {
      calls.push(payload)
      return {
        s: "ok",
        candles: [
          [friday0915, 10, 12, 9, 11, 500],
          [epoch("2026-10-02T10:00:00.000Z"), 10, 12, 9, 11, 500],
        ],
      }
    },
  }
  const preloader = createHistoryPreloader({
    appId: "APP", getAccessToken: () => "TOKEN", stocks: ["SBIN"],
    store: {
      fillMissingHistory: async (...args) => {
        fills.push(args)
        return { total: 1, added: 1, duplicate: 0, invalid: 0 }
      },
    },
    modelFactory: () => client,
  })
  assert.equal(preloader.start().accepted, true)
  while (preloader.status().state === "running") await new Promise((resolve) => setImmediate(resolve))

  assert.equal(preloader.status().state, "complete")
  assert.equal(preloader.status().added, 1)
  assert.equal(preloader.status().invalid, 1)
  assert.equal(calls[0].symbol, "NSE:SBIN-EQ")
  assert.equal(calls[0].resolution, "1")
  assert.equal(Number(calls[0].range_to) - Number(calls[0].range_from), 30 * 24 * 60 * 60)
  assert.equal(fills[0][1].length, 1)
  assert.equal(fills[0][1][0].source, "fyers-history")
})
