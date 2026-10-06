import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"

export function createStrategySignalStore(directory) {
  function filename(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("Invalid Strategy Radar date")
    return path.join(directory, `${date}.json`)
  }

  function read(date) {
    const file = filename(date)
    if (!existsSync(file)) return []
    const signals = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(signals)) throw new TypeError(`Invalid Strategy Radar file: ${file}`)
    return signals
  }

  function save(date, signals) {
    if (!Array.isArray(signals)) throw new TypeError("Strategy Radar signals must be an array")
    const file = filename(date)
    mkdirSync(directory, { recursive: true })
    const temporary = path.join(directory, `.${date}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, `${JSON.stringify(signals, null, 2)}\n`, "utf8")
      renameSync(temporary, file)
    } catch (error) {
      if (existsSync(temporary)) {
        try { unlinkSync(temporary) } catch { /* Preserve the original write error. */ }
      }
      throw error
    }
  }

  return { read, save }
}
