export const PACKAGE_ID =
  '0x5ce37cb79e04509abc4cdbed42343ac9433f831216efbb89a71910ca3790e7ce'

export const NETWORK = 'testnet' as const
export const NETWORK_CHAIN = 'sui:testnet' as const

export const SUISCAN_BASE = 'https://suiscan.xyz/testnet'
export const suiscObjectUrl = (objectId: string) => `${SUISCAN_BASE}/object/${objectId}`
export const suiscTxUrl = (txDigest: string) => `${SUISCAN_BASE}/tx/${txDigest}`

