export function indexOptionContracts(contracts) {
  const byUnderlying = new Map()
  const values = contracts instanceof Map ? contracts.values() : contracts || []

  for (const contract of values) {
    if (!contract?.underlying || !Number.isFinite(contract.strike) ||
        !Number.isFinite(contract.expiry) || !["CE", "PE"].includes(contract.optionType)) continue
    let expiries = byUnderlying.get(contract.underlying)
    if (!expiries) byUnderlying.set(contract.underlying, expiries = new Map())
    let strikes = expiries.get(contract.expiry)
    if (!strikes) expiries.set(contract.expiry, strikes = new Map())
    let legs = strikes.get(contract.strike)
    if (!legs) strikes.set(contract.strike, legs = new Map())
    legs.set(contract.optionType, contract)
  }

  return new Map(Array.from(byUnderlying, ([underlying, expiries]) => [
    underlying,
    Array.from(expiries, ([expiry, strikes]) => ({
      expiry,
      strikes: Array.from(strikes.keys()).sort((a, b) => a - b),
      contracts: strikes,
    })).sort((a, b) => a.expiry - b.expiry),
  ]))
}

export function selectNearAtmOptions(index, underlying, spot, now = Date.now()) {
  if (!(spot > 0) || !Number.isFinite(spot)) return []
  const expiry = index.get(underlying)?.find((item) => item.expiry > now)
  if (!expiry?.strikes.length) return []

  let atmIndex = 0
  for (let i = 1; i < expiry.strikes.length; i++) {
    if (Math.abs(expiry.strikes[i] - spot) < Math.abs(expiry.strikes[atmIndex] - spot)) atmIndex = i
  }
  const strikes = expiry.strikes.slice(Math.max(0, atmIndex - 1), atmIndex + 2)
  const selected = []
  for (const strike of strikes) {
    const legs = expiry.contracts.get(strike)
    for (const optionType of ["CE", "PE"]) {
      const contract = legs?.get(optionType)
      if (contract) selected.push(contract)
    }
  }
  return selected
}
