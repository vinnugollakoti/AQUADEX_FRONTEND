export function parseAmountToBaseUnits(value: string, decimals: number): bigint {
  const cleaned = value.trim()
  if (!/^\d*(\.\d*)?$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    throw new Error('Enter a valid positive amount.')
  }

  const [wholePartRaw, fractionalRaw = ''] = cleaned.split('.')
  const wholePart = wholePartRaw === '' ? '0' : wholePartRaw

  if (fractionalRaw.length > decimals) {
    throw new Error(`Amount exceeds ${decimals} decimal places.`)
  }

  const paddedFraction = fractionalRaw.padEnd(decimals, '0')
  const combined = `${wholePart}${paddedFraction}`.replace(/^0+/, '') || '0'
  const amount = BigInt(combined)

  if (amount <= 0n) {
    throw new Error('Amount must be greater than zero.')
  }

  return amount
}

export function formatBalance(value: string, decimals: number, fractionDigits = 6): string {
  const base = 10n ** BigInt(decimals)
  const total = BigInt(value || '0')
  const whole = total / base
  const frac = total % base

  if (frac === 0n) {
    return whole.toString()
  }

  const fracStr = frac.toString().padStart(decimals, '0').slice(0, fractionDigits)
  return `${whole.toString()}.${fracStr.replace(/0+$/, '')}`
}

export function formatBaseUnits(value: bigint, decimals: number, fractionDigits = 4): string {
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const frac = value % base

  if (frac === 0n) {
    return whole.toString()
  }

  const fracStr = frac.toString().padStart(decimals, '0').slice(0, fractionDigits)
  const cleaned = fracStr.replace(/0+$/, '')
  return cleaned ? `${whole.toString()}.${cleaned}` : whole.toString()
}

export function toDecimalNumber(value: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals)
  const whole = Number(value / base)
  const frac = Number(value % base) / Number(base)
  return whole + frac
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

export function truncateAddress(value: string, length = 6): string {
  if (value.length <= length * 2 + 2) {
    return value
  }
  return `${value.slice(0, length + 2)}...${value.slice(-length)}`
}
