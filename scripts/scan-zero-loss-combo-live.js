#!/usr/bin/env node

// Frozen research profile selected from the historical chronological replay.
// "Zero loss" describes the evaluated sample only; it is not a live guarantee.
const strategyIds = "pvi-nvi,oct05-loose,sep29-tight-stop"

if (!process.argv.includes("--date") && !process.argv.includes("--from")) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  process.argv.push("--date", today)
}

if (!process.argv.includes("--strategies") && !process.argv.includes("--strategy")) {
  process.argv.push("--strategies", strategyIds)
}

console.log("Frozen combo: PVI/NVI Three-OR + Oct-05 High-Volume Retest + Sep-29 Tight-Stop Continuation")
console.log("Signals are chronological and use completed candles only; historical zero losses do not guarantee future results.\n")

await import("./scan-all-live-strategies.js")
