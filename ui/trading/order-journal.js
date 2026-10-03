import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import readline from "node:readline"

export async function openOrderJournal(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const lockPath = path.join(directory, "writer.lock")
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"))
    if (owner.host !== os.hostname()) throw new Error("Order journal locked by another host")
    let alive = true
    try { process.kill(owner.pid, 0) } catch (error) { if (error.code === "ESRCH") alive = false; else throw error }
    if (alive) throw new Error(`Order journal already owned by process ${owner.pid}`)
    fs.unlinkSync(lockPath)
  } catch (error) { if (error.code !== "ENOENT") throw error }
  const lock = fs.openSync(lockPath, "wx")
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }))
  fs.closeSync(lock)
  const filename = path.join(directory, "orders.jsonl")
  let state = { positions: [], pending: [], daily: {}, cooldowns: {} }
  let sequence = 0
  let fd
  try {
    if (fs.existsSync(filename)) {
      const lines = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.trim()) continue
        const row = JSON.parse(line)
        if (row.sequence !== sequence + 1 || !Array.isArray(row.state?.positions) || !Array.isArray(row.state?.pending)) throw new Error("Invalid order journal; reconcile before restarting")
        sequence = row.sequence
        state = row.state
      }
    }
    fd = fs.openSync(filename, "a")
  } catch (error) {
    fs.unlinkSync(lockPath)
    throw error
  }
  return {
    initialState: state,
    save(event, next) {
      const row = JSON.stringify({ version: 1, sequence: sequence + 1, at: new Date().toISOString(), event, state: next }) + "\n"
      fs.writeFileSync(fd, row)
      fs.fsyncSync(fd)
      sequence++
    },
    close() { fs.closeSync(fd); fs.unlinkSync(lockPath) },
  }
}
