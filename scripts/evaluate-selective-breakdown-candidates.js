import fs from "node:fs"
import path from "node:path"

const date = process.argv[2] ?? "2026-10-21"
const file = path.join(process.cwd(), "reports", `${date}-selective-breakdown-candidate-research.json`)
const rows = JSON.parse(fs.readFileSync(file, "utf8")).candidates
const configurations = []
for (const volume of [1, 1.25, 1.5, 2, 2.5, 3])
  for (const body of [0, .05, .1, .15, .2])
    for (const belowVwap of [0, .1, .2, .3, .4, .5])
      for (const momentum of [-.1, -.2, -.3, -.5, -.75])
        for (const sessionMove of [0, -.5, -1, -1.5, -2]) {
          const used = new Set(), selected = []
          for (const row of rows) {
            if (row.signalMinute > 690 || used.has(row.symbol) ||
              row.signalVolumeMultiple < volume || row.signalBodyPct < body ||
              row.belowVwapPct < belowVwap || row.signalVs5AgoPct > momentum ||
              row.signalVsOpenPct > sessionMove) continue
            used.add(row.symbol)
            selected.push(row)
          }
          if (selected.length < 10 || selected.length > 20) continue
          const hits = selected.filter(x => x.exitReason === "target").length
          configurations.push({ volume, body, belowVwap, momentum, sessionMove,
            count: selected.length, hits, hitRatePct: Math.round(1000 * hits / selected.length) / 10,
            stops: selected.filter(x => x.exitReason === "stop").length,
            symbols: selected.map(x => `${x.signalTime.slice(11)} ${x.symbol} ${x.exitReason}`) })
        }
configurations.sort((a, b) => b.hits - a.hits || b.hitRatePct - a.hitRatePct || Math.abs(a.count - 15) - Math.abs(b.count - 15))
console.log(JSON.stringify({ candidateCount: rows.length, matchingConfigurations: configurations.length,
  top: configurations.slice(0, 25) }, null, 2))
