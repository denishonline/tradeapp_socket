import assert from "node:assert/strict"
import { it } from "node:test"
import { createMarketFeed } from "../ui/market-feed.js"

function fixture() {
  const handlers = {}
  const subscriptions = []
  const modes = []
  const events = []
  const records = []
  let now = new Date("2026-10-05T04:30:00.000Z")
  const socket = {
    FullMode: "full",
    on: (event, handler) => { handlers[event] = handler },
    subscribe: (...args) => subscriptions.push(args),
    mode: (...args) => modes.push(args),
    autoreconnect() {},
    connect() {},
    close() { handlers.close() },
  }
  const feed = createMarketFeed({
    stocks: ["SBIN"], clientId: "test", accessToken: "secret-test-token",
    io: { emit: (...args) => events.push(args) },
    history: { record: (...args) => records.push(args) },
    clock: () => new Date(now),
    socketFactory: { getInstance: () => socket },
  })
  return { feed, handlers, subscriptions, modes, events, records, socket, setTime: (value) => { now = new Date(value) } }
}

it("subscribes to full quotes and depth on the same active channel again after reconnect", async () => {
  const { feed, handlers, subscriptions, modes, records } = fixture()
  feed.start()
  await handlers.connect()
  assert.deepEqual(subscriptions, [[["NSE:SBIN-EQ"], false, 1], [["NSE:SBIN-EQ"], true, 1]])
  assert.deepEqual(modes, [["full", 1]])
  handlers.close()
  await handlers.connect()
  assert.equal(subscriptions.length, 4)
  assert.ok(records.some(([kind, data]) => kind === "feed_status" && data.state === "reconnecting"))
  assert.ok(!JSON.stringify(records).includes("secret-test-token"))
  feed.stop()
})

it("records price and all depth updates without letting depth corrupt dashboard prices", async () => {
  const { feed, handlers, events, records } = fixture()
  feed.start()
  await handlers.connect()
  const price = { type: "sf", symbol: "NSE:SBIN-EQ", ltp: 100, vol_traded_today: 200 }
  const depth = { type: "dp", symbol: "NSE:SBIN-EQ", bid_price1: 99.9, ask_price1: 100.1 }
  handlers.message([price, depth, depth, { type: "dp", symbol: price.symbol, bid_size1: 40 }])
  handlers.message({ type: "dp", symbol: "NSE:OTHER-EQ", bid_price1: 1 })
  assert.equal(records.filter(([kind]) => kind === "depth").length, 2)
  assert.deepEqual(records.find(([kind]) => kind === "price")[1], price)
  assert.equal(events.filter(([event]) => event === "stocks:update").length, 1)
  assert.equal(feed.snapshot()[0].price, 100)
  assert.deepEqual(feed.getStatus().received, { price: 1, depth: 2 })
  assert.ok(feed.getStatus().lastReceived.SBIN.depth)
  feed.stop()
  handlers.message(depth)
  assert.equal(records.at(-1)[0], "session_end")
})

it("captures valid depth only from 09:15 through 15:14:59 IST and skips unchanged or invalid updates", () => {
  const { feed, handlers, records, setTime } = fixture()
  feed.start()
  setTime("2026-10-05T03:44:59.999Z") // 09:14:59.999 IST
  handlers.message({ type: "dp", symbol: "NSE:SBIN-EQ", bid_price1: 99.9, ask_price1: 100.1 })
  assert.equal(records.filter(([kind]) => kind === "depth").length, 0)

  setTime("2026-10-05T03:45:00.000Z") // 09:15:00 IST
  const first = { type: "dp", symbol: "NSE:SBIN-EQ", bid_price1: 99.9, ask_price1: 100.1 }
  handlers.message(first)
  handlers.message(first)
  handlers.message({ type: "dp", symbol: "NSE:SBIN-EQ", bid_size1: 2.5 })
  handlers.message({ type: "dp", symbol: "NSE:SBIN-EQ", bid_size1: 5 })

  setTime("2026-10-05T09:45:00.000Z") // 15:15:00 IST
  handlers.message({ type: "dp", symbol: "NSE:SBIN-EQ", ask_price1: 100.2 })
  assert.equal(records.filter(([kind]) => kind === "depth").length, 2)
  assert.equal(feed.getStatus().received.depth, 2)
  feed.stop()
})

it("surfaces asynchronous subscription failures and rejected subscription messages", async () => {
  const { feed, handlers, socket } = fixture()
  socket.subscribe = async () => { throw new Error("unauthorized") }
  feed.start()
  await handlers.connect()
  assert.equal(feed.getStatus().state, "error")
  handlers.message({ s: "error", message: "subscription failed" })
  assert.equal(feed.getStatus().state, "error")
  feed.stop()
})

it("does not overwrite SDK callback subscription errors with a live status", async () => {
  const { feed, handlers, socket } = fixture()
  socket.subscribe = async () => { handlers.error({ message: "Subscription limit exceeded" }) }
  feed.start()
  await handlers.connect()
  assert.equal(feed.getStatus().state, "error")
  feed.stop()
})
