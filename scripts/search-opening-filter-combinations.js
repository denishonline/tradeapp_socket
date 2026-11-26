import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const input = path.join(root, 'reports', '2026-10-14-to-16-0930-multiframe-depth-filter-discovery.json')
const data = JSON.parse(fs.readFileSync(input, 'utf8')), rows = data.rows
const allMask = (1n << BigInt(rows.length)) - 1n
const badMask = rows.reduce((m, r, i) => r.rejected ? m | (1n << BigInt(i)) : m, 0n)
const goodMask = allMask ^ badMask
const bits = mask => { let n = 0; while (mask) { n += Number(mask & 1n); mask >>= 1n } return n }
const matched = mask => rows.flatMap((r, i) => mask & (1n << BigInt(i)) ? [`${r.date}|${r.symbol}`] : [])
const featureNames = [...new Set(rows.flatMap(r => Object.keys(r.features)))]
const byMask = new Map()
for (const feature of featureNames) {
  const values = [...new Set(rows.map(r => r.features[feature]).filter(Number.isFinite))].sort((a, b) => a - b)
  if (values.length < rows.length * 0.8) continue
  for (let i = 0; i < values.length - 1; i++) {
    const threshold = (values[i] + values[i + 1]) / 2
    for (const direction of ['lt', 'gt']) {
      let mask = 0n
      rows.forEach((r, index) => { if (direction === 'lt' ? r.features[feature] < threshold : r.features[feature] > threshold) mask |= 1n << BigInt(index) })
      const bad = bits(mask & badMask), good = bits(mask & goodMask)
      if (!bad || good > 8) continue
      const key = mask.toString()
      if (!byMask.has(key)) byMask.set(key, { mask, rules: [{ feature, direction, threshold }] })
    }
  }
}
const predicates = [...byMask.values()]
const clausesByMask = new Map()
for (const p of predicates) if (!(p.mask & goodMask)) clausesByMask.set(p.mask.toString(), p)
for (let i = 0; i < predicates.length; i++) for (let j = i + 1; j < predicates.length; j++) {
  const mask = predicates[i].mask & predicates[j].mask
  if (bits(mask & badMask) < 2 || mask & goodMask) continue
  const key = mask.toString()
  if (!clausesByMask.has(key)) clausesByMask.set(key, { mask, rules: [...predicates[i].rules, ...predicates[j].rules] })
}
const clauses = [...clausesByMask.values()].sort((a, b) => bits(b.mask) - bits(a.mask) || a.rules.length - b.rules.length)
const covers = []
for (let i = 0; i < clauses.length; i++) for (let j = i; j < clauses.length; j++) for (let k = j; k < clauses.length; k++) {
  const mask = clauses[i].mask | clauses[j].mask | clauses[k].mask
  if ((mask & badMask) !== badMask) continue
  covers.push({ branches: [clauses[i], clauses[j], clauses[k]], predicates: clauses[i].rules.length + clauses[j].rules.length + clauses[k].rules.length })
}
covers.sort((a, b) => a.predicates - b.predicates)
const simplify = clause => ({ rules: clause.rules.map(r => ({ ...r, threshold: +r.threshold.toFixed(6) })), matches: matched(clause.mask) })
const output = { methodology: 'Each branch is one threshold or an AND of two thresholds. Branches are ORed. Search used only causal 09:30 features, excluded symbol/date/time identity, and required zero removals among the 22 user-retained October 14-16 selections. This is in-sample fitting.',
  counts: { predicates: predicates.length, zeroCollateralClauses: clauses.length, fullThreeBranchSolutions: covers.length },
  strongestClauses: clauses.slice(0, 30).map(simplify),
  simplestFullSolutions: covers.slice(0, 20).map(c => ({ predicates: c.predicates, branches: c.branches.map(simplify) })) }
let n = 1, file
do { file = path.join(root, 'reports', `2026-10-14-to-16-0930-opening-filter-combinations${n === 1 ? '' : `-${n}`}.json`); n++ } while (fs.existsSync(file))
fs.writeFileSync(file, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ file, counts: output.counts, best: output.simplestFullSolutions.slice(0, 5) }, null, 2))
