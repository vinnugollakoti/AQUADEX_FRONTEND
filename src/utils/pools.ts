import { PACKAGE_ID } from '../constants/sui'

export type ParsedPoolType = {
  coinAType: string
  coinBType: string
}

export function splitTypeArgs(input: string): [string, string] | null {
  let depth = 0

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (ch === '<') depth += 1
    if (ch === '>') depth -= 1
    if (ch === ',' && depth === 0) {
      return [input.slice(0, i).trim(), input.slice(i + 1).trim()]
    }
  }

  return null
}

export function extractPoolTypes(poolType?: string | null): ParsedPoolType | null {
  if (!poolType) return null

  const prefix = `${PACKAGE_ID}::pool::Pool<`
  if (!poolType.startsWith(prefix) || !poolType.endsWith('>')) {
    return null
  }

  const inner = poolType.slice(prefix.length, -1)
  const args = splitTypeArgs(inner)

  if (!args) return null

  return {
    coinAType: args[0],
    coinBType: args[1],
  }
}

export function shortTypeName(coinType: string): string {
  const parts = coinType.split('::')
  return parts[parts.length - 1] ?? coinType.slice(0, 6)
}

function findNestedValue(input: unknown): string | null {
  if (typeof input === 'string') return input
  if (typeof input === 'number') return String(input)
  if (!input || typeof input !== 'object') return null

  const value = input as Record<string, unknown>

  if ('value' in value && (typeof value.value === 'string' || typeof value.value === 'number')) {
    return String(value.value)
  }

  if ('fields' in value && value.fields && typeof value.fields === 'object') {
    return findNestedValue(value.fields)
  }

  return null
}

export function extractBalanceValue(input: unknown): bigint {
  const raw = findNestedValue(input)
  if (!raw) return 0n
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}
