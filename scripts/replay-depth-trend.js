import fs from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { createDepthTrend } from "../ui/trading/depth-trend.js"

// Read-only signal research. Deliberately imports no credentials or execution code.
const directory = process.argv[2]
if (!directory) throw new Error("Usage: node scripts/replay-depth-trend.js db/market-history/YYYY-MM-DD")
const files = []
for (const name of await readdir(directory)) {
  if (!name.endsWith(".jsonl")) continue
  const filename = path.join(directory, name)
  const input = fs.createReadStream(filename)
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let first
  try { for await (const line of lines) { if (line.trim()) { first = JSON.parse(line); break } } }
  finally { lines.close(); input.destroy() }
  if (first) files.push({ filename, at: first.receivedAt, session: first.sessionId, sequence: first.sequence })
}
files.sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence)
let count = 0, entries = 0, session = null, lastAt = 0
const detector = createDepthTrend({ onSignal: (signal) => {
  entries++
  console.log(JSON.stringify({ ...signal, at: new Date(signal.at).toISOString() }))
} })
for (const file of files) {
  const lines = readline.createInterface({ input: fs.createReadStream(file.filename), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    const now = Date.parse(record.receivedAt)
    if (!Number.isFinite(now)) throw new Error(`Invalid receipt time in ${file.filename}`)
    if (record.sessionId !== session) { detector.reset(); session = record.sessionId; lastAt = 0 }
    if (now < lastAt) throw new Error("Overlapping or out-of-order history; replay separate sessions")
    lastAt = now
    if (record.kind === "feed_status" && record.data.state !== "live" || record.kind === "session_start" || record.kind === "session_end") detector.reset()
    if (["price", "depth"].includes(record.kind)) { detector.observe(record.kind, record.data, now); count++ }
  }
}
console.log(JSON.stringify({ marketRecords: count, entryCandidates: entries, note: "Signal replay only; no simulated fills or profitability claim." }))
