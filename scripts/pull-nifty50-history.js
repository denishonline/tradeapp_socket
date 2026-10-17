import apiV3 from "fyers-api-v3"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { CONSTANT } from "../constant.js"
import { getFromStorage } from "../utils.js"
import { normalizeCandle } from "../ui/candles.js"

const ROOT = process.cwd()
const SYMBOL = "NSE:NIFTY50-INDEX"
const STORE_SYMBOL = "NIFTY50"
const REQUESTED_DATES = [
  "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09",
  "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16",
]
const IST_OFFSET_MS = 330 * 60_000

function epochForIst(date, hour, minute) {
  const [year, month, day] = date.split("-").map(Number)
  return Math.floor(Date.UTC(year, month - 1, day, hour - 5, minute - 30) / 1000)
}

function istDate(epochSeconds) {
  return new Date(epochSeconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10)
}

async function readStored(filename) {
  let contents = ""
  try {
    contents = await readFile(filename, "utf8")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const rows = new Map()
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const candle = normalizeCandle(JSON.parse(line))
      if (candle && !rows.has(candle.time)) rows.set(candle.time, candle)
    } catch {
      // Malformed historic rows are excluded when the file is canonicalized.
    }
  }
  return rows
}

async function writeStored(filename, rows) {
  const body = [...rows.values()]
    .sort((left, right) => left.time - right.time)
    .map(JSON.stringify)
    .join("\n")
  const temporary = `${filename}.${randomUUID()}.tmp`
  await writeFile(temporary, body ? `${body}\n` : "", "utf8")
  await rename(temporary, filename)
}

async function main() {
  const token = getFromStorage("token")
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("FYERS access token is missing. Run AutoLogin before importing NIFTY 50 history.")
  }

  const client = new apiV3.fyersModel({ enableLogging: false })
  client.setAppId(CONSTANT.appId)
  client.setAccessToken(token.trim())

  const requested = new Set(REQUESTED_DATES)
  const response = await client.getHistory({
    symbol: SYMBOL,
    resolution: "1",
    date_format: "0",
    range_from: String(epochForIst(REQUESTED_DATES[0], 9, 15)),
    range_to: String(epochForIst(REQUESTED_DATES.at(-1), 15, 30) - 1),
    cont_flag: "1",
  })
  if (response?.s !== "ok" || !Array.isArray(response.candles)) {
    throw new Error(response?.message || response?.msg || "FYERS returned no NIFTY 50 candle data")
  }

  const incoming = response.candles.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 6) return []
    const candle = normalizeCandle({
      time: Number(row[0]), open: Number(row[1]), high: Number(row[2]),
      low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), source: "fyers-history",
    })
    return candle && requested.has(istDate(candle.time)) ? [candle] : []
  })

  const outputDirectory = path.join(ROOT, "db", "candles")
  const output = path.join(outputDirectory, `${STORE_SYMBOL}.jsonl`)
  await mkdir(outputDirectory, { recursive: true })
  const stored = await readStored(output)
  let added = 0
  for (const candle of incoming) {
    if (!stored.has(candle.time)) {
      stored.set(candle.time, candle)
      added++
    }
  }
  await writeStored(output, stored)

  const importedDates = new Map(REQUESTED_DATES.map((date) => [date, 0]))
  for (const candle of incoming) importedDates.set(istDate(candle.time), importedDates.get(istDate(candle.time)) + 1)
  const missing = REQUESTED_DATES.filter((date) => !importedDates.get(date))
  console.log(JSON.stringify({ symbol: SYMBOL, output, received: incoming.length, added, totalStored: stored.size,
    candlesByDate: Object.fromEntries(importedDates), missingDates: missing }, null, 2))
  if (missing.length) process.exitCode = 2
}

main().catch((error) => {
  console.error(`NIFTY 50 import failed: ${error.message}`)
  process.exitCode = 1
})
