export const PACKAGE_ID =
  '0x9df9ef693361f1d9c3dd3e816e44ed897685de3c67498157b6c5669fa97b7fe2'

export const NETWORK = 'testnet' as const
export const NETWORK_CHAIN = 'sui:testnet' as const

export const SUISCAN_BASE = 'https://suiscan.xyz/testnet'

function unwrapSuiValue(input: string): string {
  const value = String(input ?? '').trim()

  const txMatch = value.match(/^TransactionDigest\((['"]?)([A-Za-z0-9]+)\1\)$/)
  if (txMatch?.[2]) return txMatch[2]

  const objectMatch = value.match(/^ObjectID\((['"]?)(0x[a-fA-F0-9]+)\1\)$/)
  if (objectMatch?.[2]) return objectMatch[2]

  return value
}

export const suiscObjectUrl = (objectId: string) => `${SUISCAN_BASE}/object/${unwrapSuiValue(objectId)}`
export const suiscTxUrl = (txDigest: string) => `${SUISCAN_BASE}/tx/${unwrapSuiValue(txDigest)}`
