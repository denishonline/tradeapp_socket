#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const scanner = path.join(directory, 'scan-sr-mtf-high-precision.js')
const result = spawnSync(process.execPath, [scanner, '--profile', 'core', ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
