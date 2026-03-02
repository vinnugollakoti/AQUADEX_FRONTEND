export const PACKAGE_ID =
  '0xcb71c1e9cc1a6a1fdd6dabc1a01393c2423315f6d59a22629bfcfcd99bcc2097'

export const NETWORK = 'testnet' as const
export const NETWORK_CHAIN = 'sui:testnet' as const

export const SUISCAN_BASE = 'https://suiscan.xyz/testnet'
export const suiscObjectUrl = (objectId: string) => `${SUISCAN_BASE}/object/${objectId}`
export const suiscTxUrl = (txDigest: string) => `${SUISCAN_BASE}/tx/${txDigest}`
