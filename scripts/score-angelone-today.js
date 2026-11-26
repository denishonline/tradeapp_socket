#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd(), DATE = process.argv.find(value => value.startsWith("--date="))?.split("=")[1] ?? "2026-11-03", IST = 330 * 60_000
const allRequested = process.argv.includes("--all")
const cutoffArg = process.argv.find(value => value.startsWith("--before="))?.split("=")[1] ?? "09:20"
const cutoffMinute = Number(cutoffArg.slice(0, 2)) * 60 + Number(cutoffArg.slice(3))
const requestedSymbols = allRequested
  ? JSON.parse(fs.readFileSync(path.join(process.cwd(), "db", "stocks"), "utf8"))
  : process.argv.filter(value => !value.startsWith("--")).map(value => value.toUpperCase().replace(/-EQ$/, ""))
const stamp = epoch => new Date(epoch * 1000 + IST).toISOString().slice(0, 16).replace("T", " ")
const minute = epoch => { const d = new Date(epoch * 1000 + IST); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const pct = (a, b) => 100 * (a / b - 1)
const round = (v, d = 4) => Number.isFinite(v) ? +v.toFixed(d) : null
const runSymbol = SYMBOL => {
const rows = fs.readFileSync(path.join(ROOT, "db", "candles", `${SYMBOL}.jsonl`), "utf8").trim().split(/\r?\n/).map(JSON.parse).map(x => ({ ...x, date: new Date(x.time * 1000 + IST).toISOString().slice(0, 10), minute: minute(x.time) }))
const dates = [...new Set(rows.map(x => x.date))].filter(x => x < DATE).slice(-10)
const byDate = date => rows.filter(x => x.date === date && x.minute >= 555 && x.minute <= 585).sort((a, b) => a.minute - b.minute)
const sessions = Object.fromEntries([...dates, DATE].map(date => [date, byDate(date)]))
const scoreAt = (date, targetMinute) => {
  const day = sessions[date], through = day.filter(x => x.minute <= targetMinute)
  if (!through.length) return null
  const open = day[0].open, last = through.at(-1)
  const candleScores = through.map((candle, index) => {
    const sameMinuteVolumes = dates.map(d => sessions[d].find(x => x.minute === candle.minute)?.volume).filter(Number.isFinite).sort((a, b) => a - b)
    const medianVolume = sameMinuteVolumes[Math.floor(sameMinuteVolumes.length / 2)] || candle.volume
    const volumeStrength = candle.volume / medianVolume
    const range = candle.high - candle.low
    const candleStrength = range ? 100 * (candle.close - candle.open) / range : 0
    const candleReturn = pct(candle.close, candle.open)
    return 50 * candleReturn + 30 * (volumeStrength - 1) * 100 / 10 + 20 * candleStrength / 100
  })
  const cumulativeVolume = through.reduce((s, x) => s + x.volume, 0)
  const range = Math.max(...through.map(x => x.high)) - Math.min(...through.map(x => x.low))
  const directionalStrength = range ? 100 * (last.close - open) / range : 0
  return { minute: targetMinute, time: stamp(last.time), close: last.close, returnPct: round(pct(last.close, open), 3), cumulativeVolume, directionalStrengthPct: round(directionalStrength, 3), candleScore: round(candleScores.at(-1), 3), runningAverageScore: round(candleScores.reduce((sum, score) => sum + score, 0) / candleScores.length, 3) }
}
const minutes = [...new Set(sessions[DATE].map(x => x.minute).filter(x => x >= 555 && x <= Math.min(585, cutoffMinute - 1)))].sort((a, b) => a - b)
const comparison = minutes.map(m => ({ today: scoreAt(DATE, m), prior: dates.map(d => ({ date: d, score: scoreAt(d, m)?.score ?? null })) }))
const best = comparison.reduce((best, row) => !best || row.today.runningAverageScore > best.today.runningAverageScore ? row : best, null)
const signals = comparison.filter(row => row.today && row.prior.every(x => Number.isFinite(x.runningAverageScore) && row.today.runningAverageScore > x.runningAverageScore)).map(row => row.today)
const output = { symbol: `${SYMBOL}-EQ`, date: DATE, priorSessions: dates, methodology: "Each completed 1-minute candle receives a causal score from candle return, same-minute volume strength versus prior-10 median, and candle directional strength. The running average through each minute is compared with the corresponding running average for each prior session. Signal requires today's running average to exceed all 10.", bestToday: best?.today ?? null, firstNewHighSignal: signals[0] ?? null, minuteByMinute: comparison }
let n = 1, file
do { file = path.join(ROOT, "reports", `${DATE}-ANGELONE-cumulative-score${n === 1 ? "" : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" })
return { symbol: SYMBOL, file, priorSessions: dates, bestToday: output.bestToday, firstNewHighSignal: output.firstNewHighSignal }
}
const results = requestedSymbols.map(runSymbol)
if (allRequested) {
  const ranked = results.filter(row => row.bestToday).sort((a, b) => b.bestToday.runningAverageScore - a.bestToday.runningAverageScore)
  console.log(JSON.stringify({ cutoff: cutoffArg, ranked: ranked.slice(0, 25) }, null, 2))
} else console.log(JSON.stringify(results, null, 2))
