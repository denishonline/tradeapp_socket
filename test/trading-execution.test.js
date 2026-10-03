import assert from "node:assert/strict"
import { it } from "node:test"
import { createExecution, sweep } from "../ui/trading/execution.js"
import { selectCall, restBook } from "../ui/trading/broker.js"
import { DEFAULT_TREND_CONFIG } from "../ui/trading/config.js"

function fixture(flags = {}, extra = {}) {
  let now = Date.parse("2026-10-05T06:00:00Z")
  const constants = { balance: 10000, maxPositions: 10, maxLoss: -5000, sl: 0.005, optionSL: 0.1, lot: 1, orderType: "INTRADAY", flgPlaceCashOrder: false, flgPlaceOptionOrder: false, ...flags }
  const events = [], placed = []
  let price = 100
  const book = () => ({ bids: [{ price: price - 0.05, qty: 10000 }], asks: [{ price: price + 0.05, qty: 10000 }], spread: 0.001, at: now })
  let orders = []
  const broker = {
    place: async (order) => { placed.push(order); return { s: "ok", id: `order-${placed.length}` } },
    orders: async () => ({ s: "ok", orderBook: orders }),
    positions: async () => ({ s: "ok", netPositions: [] }),
    cancel: async () => ({ s: "ok" }),
    chain: async () => ({ s: "ok", data: { optionsChain: [{ symbol: "NSE:SBIN26OCT100CE", option_type: "CE", oi: 1000, volume: 1000 }] } }),
    depth: async (symbol) => ({ s: "ok", d: { [symbol]: { bids: [{ price: 9.99, volume: 500 }], ask: [{ price: 10, volume: 500 }] } } }),
  }
  const contracts = new Map([["NSE:SBIN26OCT100CE", { symbol: "NSE:SBIN26OCT100CE", underlying: "NSE:SBIN-EQ", lot: 50, tick: 0.05, strike: 100, expiry: now + 7 * 86400000 }]])
  const journal = { initialState: { positions: [], pending: [], daily: {}, cooldowns: {} }, save: (event, state) => events.push(structuredClone({ event, state })) }
  const engine = createExecution({ constants, broker, contracts, journal, getBook: book, clock: () => now, config: { capitalPerTrade: 1000, cashTickSizes: { "NSE:SBIN-EQ": 0.05 }, metadataDay: "2026-10-05", ...extra } })
  const signal = () => ({ action: "ENTRY", symbol: "NSE:SBIN-EQ", at: now, price: 100, reason: "test" })
  return { engine, broker, journal, events, placed, signal, contracts, constants, advance: (ms) => { now += ms }, setPrice: (p) => { price = p }, setOrders: (value) => { orders = value } }
}

it("both flags false records paper fills and exits without any broker calls", async () => {
  const f = fixture()
  for (const key of Object.keys(f.broker)) f.broker[key] = async () => { throw new Error("Broker must not be called") }
  await f.engine.cycle([f.signal()])
  assert.equal(f.engine.status().positions.length, 1)
  assert.equal(f.engine.status().positions[0].live, false)
  assert.equal(f.engine.status().positions[0].entry, 100.05)
  f.setPrice(99)
  f.advance(2000)
  await f.engine.cycle()
  assert.equal(f.engine.status().positions.length, 0)
  assert.ok(f.events.some((x) => x.event.type === "EXIT_SIGNAL" && x.event.reason === "stop_loss"))
})

it("cash flag sends only cash IOC limits and waits for confirmed broker fill", async () => {
  const f = fixture({ flgPlaceCashOrder: true })
  await f.engine.cycle([f.signal(), f.signal()])
  assert.equal(f.placed.length, 1)
  assert.equal(f.placed[0].symbol, "NSE:SBIN-EQ")
  assert.equal(f.placed[0].validity, "IOC")
  assert.equal(f.engine.status().positions.length, 0)
  assert.ok(f.events.findIndex((x) => x.event.type === "ORDER_INTENT") < f.events.findIndex((x) => x.event.type === "ORDER_ACCEPTED"))
  f.setOrders([{ id: "order-1", symbol: "NSE:SBIN-EQ", side: 1, status: 1, filledQty: 3, tradedPrice: 100 }])
  await f.engine.cycle()
  assert.equal(f.engine.status().positions[0].qty, 3)
  assert.equal(f.engine.status().pending.length, 0)
  await f.engine.cycle()
  assert.equal(f.engine.status().positions[0].qty, 3)
})

it("option flag selects call using chain liquidity, expiry and exact lot size", async () => {
  const f = fixture({ flgPlaceOptionOrder: true })
  await f.engine.cycle([f.signal()])
  assert.equal(f.placed.length, 1)
  assert.equal(f.placed[0].symbol, "NSE:SBIN26OCT100CE")
  assert.equal(f.placed[0].qty, 50)
})

it("withholds a call entry when the underlying retreats while the option is being selected", async () => {
  const f = fixture({ flgPlaceOptionOrder: true })
  const original = f.broker.depth
  f.broker.depth = async (symbol) => { f.setPrice(99); return original(symbol) }
  await f.engine.cycle([f.signal()])
  assert.equal(f.placed.length, 0)
  assert.ok(f.events.some((e) => e.event.reason === "Underlying no longer confirms the call entry"))
})

it("both flags true route cash and call independently", async () => {
  const f = fixture({ flgPlaceCashOrder: true, flgPlaceOptionOrder: true })
  await f.engine.cycle([f.signal()])
  assert.equal(f.placed.length, 2)
  assert.deepEqual(f.engine.status().pending.map((p) => p.kind), ["cash", "option"])
})

it("ambiguous live submissions remain blocked across restart, without resubmission", async () => {
  const f = fixture({ flgPlaceCashOrder: true })
  let calls = 0
  f.broker.place = async () => { calls++; throw new Error("timeout") }
  await f.engine.cycle([f.signal()])
  await f.engine.cycle([f.signal()])
  assert.equal(calls, 1)
  assert.equal(f.engine.status().pending[0].phase, "UNKNOWN")
  assert.ok(f.events.at(-1).state.fault)
  const restarted = createExecution({ constants: f.constants, broker: f.broker, journal: { ...f.journal, initialState: f.events.at(-1).state }, getBook: () => null })
  await restarted.cycle([f.signal()])
  assert.equal(calls, 1)
  assert.ok(restarted.status().fault)
})

it("partial live exits reduce only filled quantity and retry the remainder", async () => {
  const f = fixture({ flgPlaceCashOrder: true })
  await f.engine.cycle([f.signal()])
  const qty = f.placed[0].qty
  const buy = { id: "order-1", symbol: "NSE:SBIN-EQ", side: 1, status: 2, filledQty: qty, tradedPrice: 100 }
  f.setOrders([buy])
  await f.engine.cycle()
  f.broker.positions = async () => ({ s: "ok", netPositions: [{ symbol: "NSE:SBIN-EQ", productType: "INTRADAY", netQty: qty }] })
  f.setPrice(99)
  await f.engine.cycle()
  assert.equal(f.placed[1].side, -1)
  f.setOrders([buy, { id: "order-2", symbol: "NSE:SBIN-EQ", side: -1, status: 1, filledQty: 2, tradedPrice: 98.95 }])
  await f.engine.cycle()
  assert.equal(f.engine.status().positions[0].qty, qty - 2)
  assert.equal(f.placed.length, 2)
  f.advance(6000)
  await f.engine.cycle()
  assert.equal(f.placed[2].qty, qty - 2)
})

it("trailing exits protect part of a move and daily loss limits prevent reentry", async () => {
  const f = fixture()
  await f.engine.cycle([f.signal()])
  f.setPrice(103)
  await f.engine.cycle()
  f.setPrice(102)
  await f.engine.cycle()
  assert.equal(f.engine.status().positions.length, 0)
  assert.ok(f.events.some((e) => e.event.type === "EXIT_SIGNAL" && e.event.reason === "trailing_exit"))
  const g = fixture({ maxLoss: -1 })
  await g.engine.cycle([g.signal()])
  g.setPrice(98)
  await g.engine.cycle()
  g.advance(400000)
  await g.engine.cycle([g.signal()])
  assert.equal(g.engine.status().positions.length, 0)
})

it("never calls broker placement when durable write-ahead logging fails", async () => {
  const f = fixture({ flgPlaceCashOrder: true })
  f.journal.save = () => { throw new Error("disk full") }
  await f.engine.cycle([f.signal()])
  assert.equal(f.placed.length, 0)
  assert.equal(f.engine.status().fault, "disk full")
})

it("respects stale signals, entry cutoff, capital and max position limits", async () => {
  const f = fixture({ maxPositions: 0 })
  await f.engine.cycle([f.signal()])
  assert.equal(f.engine.status().positions.length, 0)
  const g = fixture()
  const old = g.signal()
  g.advance(20000)
  await g.engine.cycle([old])
  assert.equal(g.engine.status().positions.length, 0)
  g.advance(6 * 3600000)
  await g.engine.cycle([g.signal()])
  assert.equal(g.engine.status().positions.length, 0)
})

it("refuses to sell a live position whose broker quantity no longer matches", async () => {
  const f = fixture({ flgPlaceCashOrder: true })
  await f.engine.cycle([f.signal()])
  const qty = f.placed[0].qty
  f.setOrders([{ id: "order-1", symbol: "NSE:SBIN-EQ", side: 1, status: 2, filledQty: qty, tradedPrice: 100 }])
  await f.engine.cycle()
  f.setPrice(98)
  await f.engine.cycle()
  assert.equal(f.placed.length, 1)
  assert.match(f.engine.status().fault, /Broker position differs/)
})

it("calculates depth-weighted execution rather than LTP and validates option depth", () => {
  assert.deepEqual(sweep([{ price: 110, qty: 25 }, { price: 109.8, qty: 75 }], 100), { qty: 100, average: 109.85, worst: 109.8 })
  assert.equal(restBook({ s: "ok", d: {} }, "X"), null)
  assert.equal(selectCall({ s: "ok", data: { optionsChain: [] } }, new Map(), "X", 100, Date.now(), DEFAULT_TREND_CONFIG), null)
})
