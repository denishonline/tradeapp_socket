import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const DATE = "2026-10-13"
const MINUTE = 60_000
const offset = 330 * MINUTE
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : NaN
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return NaN
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const date = (at) => new Date(at + offset).toISOString().slice(0, 10)
const minute = (at) => new Date(at + offset).toISOString().slice(11, 16)
const parseCsv = (filename) => {
  const [header, ...lines] = fs.readFileSync(filename, "utf8").trim().split(/\r?\n/)
  const fields = header.split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [fields[index], value])))
}

const source = path.join(ROOT, "csv", "2026-10-13-absorption-breakout-broad-candidates.csv")
const opening = parseCsv(source).filter((row) => row.branch === "opening")
const result = opening.map((candidate) => {
  const all = fs.readFileSync(path.join(ROOT, "db", "candles", `${candidate.symbol}.jsonl`), "utf8")
    .split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try {
        const value = JSON.parse(line), at = Number(value.time) * 1000
        return [{ at, open: Number(value.open), high: Number(value.high), low: Number(value.low),
          close: Number(value.close), volume: Number(value.volume) }]
      } catch { return [] }
    }).sort((a, b) => a.at - b.at)
  const sessions = Map.groupBy(all.filter((row) => date(row.at) <= DATE), (row) => date(row.at))
  const priorDates = [...sessions.keys()].filter((value) => value < DATE).sort().slice(-5)
  const prior = sessions.get(priorDates.at(-1)) ?? []
  const today = sessions.get(DATE) ?? []
  const setup = today.find((row) => minute(row.at) === candidate.setupTime)
  const tailReturn = (length) => prior.length >= length ? pct(prior.at(-1).close, prior.at(-length).open) : NaN
  const historicalVolumes = priorDates.flatMap((sessionDate) =>
    (sessions.get(sessionDate) ?? []).filter((row) => minute(row.at) === candidate.setupTime).map((row) => row.volume))
  return { ...candidate,
    gapPct: round(setup && prior.length ? pct(setup.open, prior.at(-1).close) : NaN),
    priorDayReturnPct: round(prior.length ? pct(prior.at(-1).close, prior[0].open) : NaN),
    prior5ReturnPct: round(tailReturn(5)), prior15ReturnPct: round(tailReturn(15)),
    prior30ReturnPct: round(tailReturn(30)),
    historicalOpeningVolumeRatio: round(setup ? setup.volume / median(historicalVolumes) : NaN),
    historicalOpeningVolumeSamples: historicalVolumes.length }
})

const fields = Object.keys(result[0] ?? {})
const output = path.join(ROOT, "csv", "2026-10-13-opening-breakout-context.csv")
fs.writeFileSync(output, [fields.join(","), ...result.map((row) => fields.map((field) => row[field] ?? "").join(","))].join("\n") + "\n")
console.log(output)
