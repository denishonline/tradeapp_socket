import assert from "node:assert/strict"
import { it } from "node:test"
import { mkdtemp, rm, appendFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { openOrderJournal } from "../ui/trading/order-journal.js"

it("restores durable order state and prevents concurrent writers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trend-journal-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const journal = await openOrderJournal(directory)
  const state = { ...journal.initialState, pending: [{ id: "intent", live: true, brokerId: null }], fault: "unknown" }
  journal.save({ type: "ORDER_INTENT" }, state)
  await assert.rejects(openOrderJournal(directory), /already owned/)
  journal.close()
  const reopened = await openOrderJournal(directory)
  assert.deepEqual(reopened.initialState, state)
  reopened.close()
})

it("fails closed on a truncated journal rather than treating missing fills as empty state", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trend-journal-corrupt-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const journal = await openOrderJournal(directory)
  journal.save({ type: "INIT" }, journal.initialState)
  journal.close()
  await appendFile(path.join(directory, "orders.jsonl"), '{"sequence":2,')
  await assert.rejects(openOrderJournal(directory), SyntaxError)
})
