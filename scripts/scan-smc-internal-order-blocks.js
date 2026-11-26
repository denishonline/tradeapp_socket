import { execFileSync } from 'node:child_process'

const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

const targetDate = option('--date', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()))
const cutoff = option('--cutoff', '15:30')
const side = option('--side', 'sell')
const firstOnly = process.argv.includes('--first')
const symbols = option('--symbols', '')
  .split(',')
  .map(value => value.replace(/[\\\s]+/g, '').replace(/^NSE:/i, '').replace(/-EQ$/i, ''))
  .filter(Boolean)

if (!symbols.length) {
  throw new Error('Provide comma-separated symbols with --symbols')
}

const rows = []
for (const [index, symbol] of symbols.entries()) {
  process.stderr.write(`\r\x1b[2KScanning [${index + 1}/${symbols.length}] ${symbol}...`)
  const args = [
    'scripts/analyze-smc-internal-order-blocks.js', symbol, targetDate,
    '--json', '--side', side, '--active-only', '--cutoff', cutoff
  ]
  if (process.argv.includes('--refresh-fyers')) args.push('--refresh-fyers')
  if (process.argv.includes('--early-candidates')) args.push('--early-candidates')

  const output = execFileSync(process.execPath, args, { encoding: 'utf8' })
  const jsonLine = output.split(/\r?\n/).reverse().find(line => line.trim().startsWith('['))
  const events = jsonLine ? JSON.parse(jsonLine) : []

  if (!events.length) {
    rows.push({ Stock: symbol, Status: '-', Side: '-', 'Signal time': '-', Structure: '-', Zone: '-' })
    continue
  }

  for (const event of firstOnly ? events.slice(0, 1) : events) {
    rows.push({
      Stock: symbol,
      Status: event.Status || 'CONFIRMED',
      Side: event.Side === 'Bearish' ? 'SELL' : 'BUY',
      'Signal time': event['Confirmed at'].slice(11),
      Structure: event.Structure,
      Zone: `${event['Zone low']}–${event['Zone high']}`
    })
  }
}

process.stderr.write('\r\x1b[2K')
console.log(`5-minute FYERS-calibrated SMC | ${targetDate} | cutoff ${cutoff} IST`)
console.table(rows)
