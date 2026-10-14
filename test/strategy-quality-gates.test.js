import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import {
  passesFailedBidQuality,
  passesMultiFrameBuyQuality,
  passesMultiFrameSellQuality,
  passesRevisedAbsorptionQuality,
} from "../ui/strategy-quality-gates.js"

const ROOT = path.resolve(import.meta.dirname, "..")

function csvRows(relativePath) {
  const [header, ...lines] = fs.readFileSync(path.join(ROOT, relativePath), "utf8").trim().split(/\r?\n/)
  const fields = header.split(",")
  return lines.map((line) => Object.fromEntries(
    line.split(",").map((value, index) => [fields[index], value.replace(/^"|"$/g, "")]),
  ))
}

const revisedPattern = (patterns) => {
  if (patterns.includes("late_breadth_confirmed_absorption")) return "Late breadth-confirmed absorption"
  if (patterns === "smooth_depth_confirmation") return "Smooth depth confirmation"
  if (patterns === "balanced_flow_continuation") return "Balanced flow continuation"
  if (patterns === "opening_hidden_buy_flow") return "Opening hidden buy flow"
  return "Opening broad participation"
}

test("quality gates preserve every recorded winner for the changed strategies", () => {
  let winners = 0

  for (const row of csvRows("csv/2026-10-06-to-08-optimized-multiframe-depth-buy-zero-stop-audit.csv")) {
    const branch = row.branch === "1" ? "controlled_recovery" : "other"
    assert.equal(passesMultiFrameBuyQuality(branch, { rsi14: row.rsi14 }), true, `buy ${row.symbol}`)
    winners++
  }

  for (const row of csvRows("csv/2026-10-06-to-08-multiframe-depth-2pct-zero-stop-audit.csv")) {
    const branch = row.branch === "2" ? "weak_recovery_falling_bid" : "other"
    assert.equal(passesMultiFrameSellQuality(branch, { rsi14: row.rsi14 }), true, `sell ${row.symbol}`)
    winners++
  }

  for (const row of csvRows("csv/2026-10-06-to-09-enhanced-failed-bid-absorption.csv")) {
    if (row.result !== "TARGET") continue
    assert.equal(passesFailedBidQuality({
      priceDropPct: row.priceDropPct,
      volumeRatio: row.candleVolumeRatio,
      confirmationBidSharePct: row.confirmationBidSharePct,
    }), true, `failed-bid ${row.symbol}`)
    winners++
  }

  const enriched = csvRows("csv/2026-10-05-to-13-absorption-breakout-broad-enriched.csv")
  const enrichedBySignal = new Map(enriched.map((row) => [
    [row.date, row.symbol, row.setupTime, row.signalTime].join("|"), row,
  ]))
  for (const row of csvRows("csv/2026-10-05-to-13-revised-absorption-strategy-backtest.csv")) {
    const metrics = enrichedBySignal.get([row.date, row.symbol, row.setupTime, row.signalTime].join("|"))
    assert.ok(metrics, `missing revised metrics for ${row.symbol}`)
    assert.equal(passesRevisedAbsorptionQuality(revisedPattern(row.patterns), {
      breadthPositivePct: metrics.breadthPositivePct,
      breadthAbove05Pct: metrics.breadthAbove05Pct,
      bidDominantPct: metrics.bidDominantPct,
      ofi: metrics.ofi,
      confirmationVolumeRatio10: metrics.confirmVolumeRatio10,
      confirmationCandleReturnPct: metrics.confirmCandleReturnPct,
      vwapGapPct: metrics.vwapGapPct,
    }), true, `revised ${row.symbol}`)
    winners++
  }

  const liveBuyWinner = JSON.parse(fs.readFileSync(
    path.join(ROOT, "db/strategy-signals/multi-frame-depth-buy/2026-10-12.json"), "utf8",
  )).find((signal) => signal.status === "Target reached")
  assert.ok(liveBuyWinner)
  assert.equal(passesMultiFrameBuyQuality(liveBuyWinner.metrics.filterBranch, liveBuyWinner.metrics), true)
  winners++

  assert.equal(winners, 58)
})

test("quality gates reject all fourteen October 14 failed signals", () => {
  const checks = []
  for (const signal of JSON.parse(fs.readFileSync(
    path.join(ROOT, "db/strategy-signals/multi-frame-depth-buy/2026-10-14.json"), "utf8",
  ))) checks.push([signal.symbol, passesMultiFrameBuyQuality(signal.metrics.filterBranch, signal.metrics)])

  for (const signal of JSON.parse(fs.readFileSync(
    path.join(ROOT, "db/strategy-signals/multi-frame-depth-sell/2026-10-14.json"), "utf8",
  ))) checks.push([signal.symbol, passesMultiFrameSellQuality(signal.metrics.filterBranch, signal.metrics)])

  for (const signal of JSON.parse(fs.readFileSync(
    path.join(ROOT, "db/strategy-signals/failed-bid-absorption/2026-10-14.json"), "utf8",
  ))) checks.push([signal.symbol, passesFailedBidQuality({
    priceDropPct: signal.metrics.priceDropPct,
    volumeRatio: signal.metrics.volumeRatio,
    confirmationBidSharePct: signal.metrics.confirmationBidSharePct,
  })])

  for (const signal of JSON.parse(fs.readFileSync(
    path.join(ROOT, "db/strategy-signals/revised-absorption-breakout/2026-10-14.json"), "utf8",
  ))) checks.push([signal.symbol, passesRevisedAbsorptionQuality(signal.pattern, signal.metrics)])

  assert.equal(checks.length, 14)
  assert.deepEqual(checks.filter(([, passed]) => passed), [])
})
