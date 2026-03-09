import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { COINS, COIN_BY_TYPE, SUI_COIN_TYPE, type CoinInfo } from '../constants/coins'
import { NETWORK_CHAIN, suiscTxUrl } from '../constants/sui'
import { formatBaseUnits, parseAmountToBaseUnits, toDecimalNumber } from '../utils/amounts'
import { extractBalanceValue, shortTypeName } from '../utils/pools'
import { buildCoinInput, getAllCoinsByType } from '../utils/txCoins'

type Category = 'Stablecoins' | 'Bridged' | 'DeFi' | 'SUI' | 'BTC'

type LendAsset = {
  marketId: string
  coinType: string
  collateralFactor: number
  logoUrl: string
  symbol: string
  name: string
  price: string
  categories: Category[]
  supply: string
  supplyValue: string
  borrow: string
  borrowValue: string
  supplyApr: string
  borrowApr: string
}

type PositionRow = {
  id: string
  collateralValue: bigint
  borrowedValue: bigint
  coinType: string | null
}

type ActionKind = 'supply' | 'borrow'

const AQUALEND_PACKAGE_ID =
  '0xe0568ee1b9cf1017be543c99c877d2f686470309b3d8983d0c4e5af748044635'
const AQUALEND_ADMIN =
  '0x7c88663e7928a8fcd1a8c16f110580270cde571987ff1ccfa7c72d772370604d'
const AQUALEND_GLOBAL_CONFIG_ID =
  '0xc5de9a2de46b335a482e35b4a9444c5edeee369be075a654e16a5fa522cb0ab6'
const MARKET_TYPE_PREFIX = `${AQUALEND_PACKAGE_ID}::market::Market<`
const POSITION_TYPE = `${AQUALEND_PACKAGE_ID}::position::Position`
const NAVI_PRICE_API = '/api/navi-price'
const NAVI_CHAIN = 1999
const PRICE_SCALE = 1_000_000
const U64_MAX = 18_446_744_073_709_551_615n
const POSITION_DUST_USD = 0.01
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const CATEGORY_TABS: Array<'All' | Category> = ['All', 'Stablecoins', 'Bridged', 'DeFi', 'SUI', 'BTC']

function normalizeAddress(address?: string | null): string {
  return String(address ?? '').toLowerCase()
}

function categorizeCoin(coin: CoinInfo | null): Category[] {
  if (!coin) return ['DeFi']
  if (coin.symbol === 'USDC') return ['Stablecoins']
  if (coin.symbol === 'SUI') return ['SUI']
  if (coin.symbol === 'WAL' || coin.symbol === 'ETH') return ['Bridged']
  if (coin.symbol.includes('BTC')) return ['BTC']
  return ['DeFi']
}

function formatUsdNumber(value: number): string {
  const safeValue = Number.isFinite(value) ? value : 0
  return `$${safeValue.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function parseMarketCoinType(type?: string | null): string | null {
  if (!type || !type.startsWith(MARKET_TYPE_PREFIX) || !type.endsWith('>')) return null
  return type.slice(MARKET_TYPE_PREFIX.length, -1)
}

function extractNaviPrices(payload: unknown): Record<string, number> {
  const output: Record<string, number> = {}
  const list =
    (payload as { data?: { list?: Array<{ coinType?: string; price?: number | string }> } } | null)
      ?.data?.list ?? []

  for (const item of list) {
    if (!item?.coinType) continue
    const price =
      typeof item.price === 'number'
        ? item.price
        : typeof item.price === 'string'
          ? Number(item.price)
          : NaN
    if (Number.isFinite(price)) {
      output[item.coinType] = price
    }
  }

  return output
}

async function findMarketIds(client: ReturnType<typeof useSuiClient>): Promise<string[]> {
  const ids = new Set<string>()
  let cursor: string | null | undefined = null

  for (let pageIndex = 0; pageIndex < 12; pageIndex += 1) {
    const page = await client.queryTransactionBlocks({
      filter: {
        MoveFunction: {
          package: AQUALEND_PACKAGE_ID,
          module: 'market',
          function: 'create_market',
        },
      },
      options: { showObjectChanges: true },
      order: 'descending',
      cursor,
      limit: 50,
    })

    for (const item of page.data) {
      for (const change of item.objectChanges ?? []) {
        if (
          change.type === 'created' &&
          change.objectType.startsWith(MARKET_TYPE_PREFIX) &&
          'objectId' in change
        ) {
          ids.add(change.objectId)
        }
      }
    }

    if (!page.hasNextPage || !page.nextCursor) break
    cursor = page.nextCursor
  }

  return Array.from(ids)
}

async function fetchWalletCoinTotals(
  client: ReturnType<typeof useSuiClient>,
  owner: string,
): Promise<Record<string, string>> {
  const totals = new Map<string, bigint>()
  let cursor: string | null | undefined = null

  do {
    const page = await client.getAllCoins({
      owner,
      cursor,
      limit: 50,
    })

    for (const coin of page.data) {
      const key = coin.coinType
      const next = (totals.get(key) ?? 0n) + BigInt(coin.balance)
      totals.set(key, next)
    }

    cursor = page.hasNextPage ? page.nextCursor : null
  } while (cursor)

  return Object.fromEntries(
    Array.from(totals.entries()).map(([coinType, total]) => [coinType, total.toString()] as const),
  )
}

function extractCoinTypeFromTxInput(input: unknown): string | null {
  const tx = input as
    | {
        transaction?: {
          data?: {
            transaction?: {
              transactions?: Array<{
                MoveCall?: {
                  package?: string
                  module?: string
                  function?: string
                  type_arguments?: string[]
                  typeArguments?: string[]
                }
              }>
            }
          }
        }
      }
    | undefined

  const calls = tx?.transaction?.data?.transaction?.transactions
  if (!Array.isArray(calls)) return null

  for (const call of calls) {
    const moveCall = call.MoveCall
    if (!moveCall) continue
    if (normalizeAddress(moveCall.package) !== normalizeAddress(AQUALEND_PACKAGE_ID)) continue
    if (moveCall.module !== 'vault') continue
    const fn = moveCall.function
    if (fn !== 'new_deposit' && fn !== 'add_deposits' && fn !== 'borrow' && fn !== 'repay' && fn !== 'withdraw') {
      continue
    }
    const typeArgs = moveCall.type_arguments ?? moveCall.typeArguments ?? []
    if (typeArgs[0]) return typeArgs[0]
  }

  return null
}

async function readPausedState(client: ReturnType<typeof useSuiClient>): Promise<boolean> {
  const configObject = await client.getObject({
    id: AQUALEND_GLOBAL_CONFIG_ID,
    options: { showContent: true },
  })
  const configFields = (configObject.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields
  return Boolean(configFields?.paused)
}

export function AquaLendPage() {
  const client = useSuiClient()
  const account = useCurrentAccount()
  const signAndExecute = useSignAndExecuteTransaction()

  const [selectedCategory, setSelectedCategory] = useState<'All' | Category>('All')
  const [query, setQuery] = useState('')
  const [positionTab, setPositionTab] = useState<'supply' | 'borrow'>('supply')
  const [markets, setMarkets] = useState<LendAsset[]>([])
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>({})
  const [pricesByCoinType, setPricesByCoinType] = useState<Record<string, number>>({})
  const [configId] = useState(AQUALEND_GLOBAL_CONFIG_ID)
  const [configPaused, setConfigPaused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState('')
  const [txDigest, setTxDigest] = useState('')
  const [showCreateMarketModal, setShowCreateMarketModal] = useState(false)
  const [showPauseConfirmModal, setShowPauseConfirmModal] = useState(false)
  const [showActionModal, setShowActionModal] = useState(false)
  const [showWithdrawModal, setShowWithdrawModal] = useState(false)
  const [showRepayModal, setShowRepayModal] = useState(false)
  const [actionKind, setActionKind] = useState<ActionKind>('supply')
  const [actionMarket, setActionMarket] = useState<LendAsset | null>(null)
  const [actionAmount, setActionAmount] = useState('')
  const [actionPrice, setActionPrice] = useState('')
  const [borrowSliderPct, setBorrowSliderPct] = useState(0)
  const [selectedPositionId, setSelectedPositionId] = useState('')
  const [selectedWithdrawPosition, setSelectedWithdrawPosition] = useState<PositionRow | null>(null)
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [withdrawPrice, setWithdrawPrice] = useState('')
  const [withdrawSliderPct, setWithdrawSliderPct] = useState(0)
  const [selectedRepayPosition, setSelectedRepayPosition] = useState<PositionRow | null>(null)
  const [repayAmount, setRepayAmount] = useState('')
  const [repayPrice, setRepayPrice] = useState('')
  const [repaySliderPct, setRepaySliderPct] = useState(0)
  const [marketCoinType, setMarketCoinType] = useState(COINS[0]?.coinType ?? '')
  const [coinPickerOpen, setCoinPickerOpen] = useState(false)
  const [collateralFactorInput, setCollateralFactorInput] = useState('8000')
  const [submitting, setSubmitting] = useState(false)

  const isAdmin = normalizeAddress(account?.address) === normalizeAddress(AQUALEND_ADMIN)

  const loadOnchainData = useCallback(async () => {
    setLoading(true)
    setFeedback('')
    try {
      setConfigPaused(await readPausedState(client))

      const marketIds = await findMarketIds(client)
      if (marketIds.length === 0) {
        setMarkets([])
      } else {
        const objects = await client.multiGetObjects({
          ids: marketIds,
          options: { showType: true, showContent: true },
        })

        const parsed = objects
          .map((item) => {
            const data = item.data
            if (!data?.objectId) return null
            const coinType = parseMarketCoinType(data.type)
            if (!coinType) return null
            const content = data.content as { fields?: Record<string, unknown> } | undefined
            const coin = COIN_BY_TYPE[coinType] ?? null
            const totalDepositsRaw = extractBalanceValue(content?.fields?.total_deposits)
            const totalBorrowsRaw = BigInt(String(content?.fields?.total_borrows ?? '0'))
            const supplyAmount = toDecimalNumber(totalDepositsRaw, coin?.decimals ?? 0)
            const borrowAmount = toDecimalNumber(totalBorrowsRaw, coin?.decimals ?? 0)
            const price = pricesByCoinType[coinType] ?? 0
            return {
              marketId: data.objectId,
              coinType,
              collateralFactor: Number(content?.fields?.collateral_factor ?? 0),
              logoUrl: coin?.logoUrl ?? '/aquadex-logo.png',
              symbol: coin?.symbol ?? shortTypeName(coinType),
              name: coin?.name ?? shortTypeName(coinType),
              price: '$0.00',
              categories: categorizeCoin(coin),
              supply: formatBaseUnits(totalDepositsRaw, coin?.decimals ?? 0, 6),
              supplyValue: formatUsdNumber(supplyAmount * price),
              borrow: formatBaseUnits(totalBorrowsRaw, coin?.decimals ?? 0, 6),
              borrowValue: formatUsdNumber(borrowAmount * price),
              supplyApr: '0.00%',
              borrowApr: '0.00%',
            } as LendAsset
          })
          .filter((row): row is LendAsset => Boolean(row))
          .sort((a, b) => a.symbol.localeCompare(b.symbol))

        setMarkets(parsed)
      }

      if (!account?.address) {
        setPositions([])
        setWalletBalances({})
      } else {
        let cursor: string | null | undefined = null
        const all: Array<PositionRow & { previousTransaction: string | null }> = []
        do {
          const owned = await client.getOwnedObjects({
            owner: account.address,
            filter: { StructType: POSITION_TYPE },
            options: { showContent: true, showPreviousTransaction: true },
            cursor,
            limit: 50,
          })

          for (const item of owned.data) {
            const id = item.data?.objectId
            const fields = (item.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields
            if (!id) continue
            all.push({
              id,
              collateralValue: BigInt(String(fields?.collateral_value ?? '0')),
              borrowedValue: BigInt(String(fields?.borrowed_value ?? '0')),
              previousTransaction: item.data?.previousTransaction ?? null,
              coinType: null,
            })
          }

          cursor = owned.hasNextPage ? owned.nextCursor : null
        } while (cursor)

        const previousTxDigests = Array.from(
          new Set(all.map((item) => item.previousTransaction).filter((tx): tx is string => Boolean(tx))),
        )
        const coinTypeByTx: Record<string, string | null> = {}
        await Promise.all(
          previousTxDigests.map(async (digest) => {
            try {
              const txBlock = await client.getTransactionBlock({
                digest,
                options: { showInput: true },
              })
              coinTypeByTx[digest] = extractCoinTypeFromTxInput(txBlock)
            } catch {
              coinTypeByTx[digest] = null
            }
          }),
        )

        const normalized = all.map((item) => ({
          id: item.id,
          collateralValue: item.collateralValue,
          borrowedValue: item.borrowedValue,
          coinType: item.previousTransaction ? (coinTypeByTx[item.previousTransaction] ?? null) : null,
        }))

        setPositions(normalized)

        const totalsByCoinType = await fetchWalletCoinTotals(client, account.address)
        setWalletBalances(totalsByCoinType)
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to load AquaLend data.')
    } finally {
      setLoading(false)
    }
  }, [account?.address, client, pricesByCoinType])

  useEffect(() => {
    void loadOnchainData()
  }, [loadOnchainData])

  useEffect(() => {
    const loadPrices = async () => {
      const fallback = Object.fromEntries(COINS.map((coin) => [coin.coinType, 0])) as Record<
        string,
        number
      >
      const tracked = COINS.filter((coin) => Boolean(coin.mainnetType))
      const body = tracked.map((coin) => ({
        coinType: coin.mainnetType,
        chain: NAVI_CHAIN,
      }))

      try {
        const response = await fetch(NAVI_PRICE_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error('Price fetch failed')
        const data = await response.json()
        const naviPricesByMainnetType = extractNaviPrices(data)
        const mapped: Record<string, number> = { ...fallback }
        for (const coin of tracked) {
          mapped[coin.coinType] = naviPricesByMainnetType[coin.mainnetType] ?? 0
        }
        mapped['0x1faf161a7eaebaeca42f65a7781691176df8e5a1c62d23397409a066e23aa0dc::k_coin::K_COIN'] = 0

        setPricesByCoinType(mapped)
      } catch {
        setPricesByCoinType(fallback)
      }
    }

    void loadPrices()
  }, [])

  useEffect(() => {
    const hasOpenModal =
      showCreateMarketModal ||
      showPauseConfirmModal ||
      showActionModal ||
      showWithdrawModal ||
      showRepayModal
    if (!hasOpenModal) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [showActionModal, showCreateMarketModal, showPauseConfirmModal, showWithdrawModal, showRepayModal])

  const filteredAssets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return markets.filter((asset) => {
      const matchesCategory =
        selectedCategory === 'All' || asset.categories.includes(selectedCategory)
      const matchesQuery =
        !needle ||
        asset.symbol.toLowerCase().includes(needle) ||
        asset.name.toLowerCase().includes(needle)
      return matchesCategory && matchesQuery
    })
  }, [markets, query, selectedCategory])

  const suppliedValue = useMemo(() => {
    return positions.reduce((sum, item) => {
      const decimals = COIN_BY_TYPE[item.coinType ?? '']?.decimals ?? 9
      return sum + toDecimalNumber(item.collateralValue, decimals + 6)
    }, 0)
  }, [positions])
  const borrowedValue = useMemo(() => {
    return positions.reduce((sum, item) => {
      const decimals = COIN_BY_TYPE[item.coinType ?? '']?.decimals ?? 9
      return sum + toDecimalNumber(item.borrowedValue, decimals + 6)
    }, 0)
  }, [positions])
  const walletNetWorth = useMemo(() => {
    if (!account?.address) return 0
    return Object.entries(walletBalances).reduce((sum, [coinType, rawBalance]) => {
      const coin = COIN_BY_TYPE[coinType]
      if (!coin) return sum
      const amount = toDecimalNumber(BigInt(rawBalance), coin.decimals)
      const usdPrice = pricesByCoinType[coin.coinType] ?? 0
      return sum + amount * usdPrice
    }, 0)
  }, [account?.address, pricesByCoinType, walletBalances])

  const supplyPositions = useMemo(
    () =>
      positions.filter((item) => {
        const decimals = COIN_BY_TYPE[item.coinType ?? '']?.decimals ?? 9
        const collateralUsd = toDecimalNumber(item.collateralValue, decimals + 6)
        return collateralUsd > POSITION_DUST_USD
      }),
    [positions],
  )
  const activePositions = useMemo(
    () =>
      positions.filter((item) => {
        const decimals = COIN_BY_TYPE[item.coinType ?? '']?.decimals ?? 9
        const collateralUsd = toDecimalNumber(item.collateralValue, decimals + 6)
        const borrowedUsd = toDecimalNumber(item.borrowedValue, decimals + 6)
        return collateralUsd > POSITION_DUST_USD || borrowedUsd > POSITION_DUST_USD
      }),
    [positions],
  )
  const borrowPositions = useMemo(
    () =>
      positions.filter((item) => {
        const decimals = COIN_BY_TYPE[item.coinType ?? '']?.decimals ?? 9
        const borrowedUsd = toDecimalNumber(item.borrowedValue, decimals + 6)
        return borrowedUsd > POSITION_DUST_USD
      }),
    [positions],
  )

  const marketTotals = useMemo(() => {
    const totals = { supplyUsd: 0, borrowUsd: 0 }
    for (const market of markets) {
      const price = pricesByCoinType[market.coinType] ?? 0
      const supplyAmount = Number(market.supply)
      const borrowAmount = Number(market.borrow)
      if (Number.isFinite(supplyAmount)) totals.supplyUsd += supplyAmount * price
      if (Number.isFinite(borrowAmount)) totals.borrowUsd += borrowAmount * price
    }
    return totals
  }, [markets, pricesByCoinType])

  const tvlDisplay = formatUsdNumber(Math.max(0, marketTotals.supplyUsd - marketTotals.borrowUsd))
  const totalSupplyDisplay = formatUsdNumber(marketTotals.supplyUsd)
  const totalBorrowDisplay = formatUsdNumber(marketTotals.borrowUsd)

  const marketByCoinType = useMemo(
    () => Object.fromEntries(markets.map((market) => [market.coinType, market])) as Record<string, LendAsset>,
    [markets],
  )

  const activeBorrowPosition = useMemo(() => {
    if (!selectedPositionId) return null
    return positions.find((item) => item.id === selectedPositionId) ?? null
  }, [positions, selectedPositionId])

  const borrowPriceNum = useMemo(() => {
    if (!actionMarket) return 0
    const parsed = Number(actionPrice)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    return pricesByCoinType[actionMarket.coinType] ?? 0
  }, [actionMarket, actionPrice, pricesByCoinType])

  const borrowPriceScaled = useMemo(() => {
    return BigInt(Math.max(0, Math.floor(borrowPriceNum * PRICE_SCALE)))
  }, [borrowPriceNum])

  const availableBorrowRaw = useMemo(() => {
    if (actionKind !== 'borrow' || !actionMarket || !activeBorrowPosition) return 0n
    if (activeBorrowPosition.collateralValue <= 0n || borrowPriceScaled <= 0n) return 0n
    const collateralFactor = BigInt(Math.max(0, actionMarket.collateralFactor))
    const maxBorrowValue = (activeBorrowPosition.collateralValue * collateralFactor) / 10000n
    const remainingValue = maxBorrowValue - activeBorrowPosition.borrowedValue
    if (remainingValue <= 0n) return 0n
    return remainingValue / borrowPriceScaled
  }, [actionKind, actionMarket, activeBorrowPosition, borrowPriceScaled])

  const borrowAmountUsd = useMemo(() => {
    if (!actionMarket || actionKind !== 'borrow') return 0
    if (!actionAmount.trim()) return 0
    const coin = COIN_BY_TYPE[actionMarket.coinType]
    if (!coin || borrowPriceNum <= 0) return 0
    try {
      const amountRaw = parseAmountToBaseUnits(actionAmount, coin.decimals)
      const amount = toDecimalNumber(amountRaw, coin.decimals)
      return amount * borrowPriceNum
    } catch {
      return 0
    }
  }, [actionAmount, actionKind, actionMarket, borrowPriceNum])

  const availableBorrowDisplay = useMemo(() => {
    if (!actionMarket) return '0'
    const coin = COIN_BY_TYPE[actionMarket.coinType]
    if (!coin) return '0'
    return formatBaseUnits(availableBorrowRaw, coin.decimals, 6)
  }, [actionMarket, availableBorrowRaw])

  const availableSupplyRaw = useMemo(() => {
    if (actionKind !== 'supply' || !actionMarket) return 0n
    return BigInt(walletBalances[actionMarket.coinType] ?? '0')
  }, [actionKind, actionMarket, walletBalances])

  const supplyAmountUsd = useMemo(() => {
    if (!actionMarket || actionKind !== 'supply') return 0
    if (!actionAmount.trim()) return 0
    const coin = COIN_BY_TYPE[actionMarket.coinType]
    if (!coin || borrowPriceNum <= 0) return 0
    try {
      const amountRaw = parseAmountToBaseUnits(actionAmount, coin.decimals)
      const amount = toDecimalNumber(amountRaw, coin.decimals)
      return amount * borrowPriceNum
    } catch {
      return 0
    }
  }, [actionAmount, actionKind, actionMarket, borrowPriceNum])

  const availableSupplyDisplay = useMemo(() => {
    if (!actionMarket) return '0'
    const coin = COIN_BY_TYPE[actionMarket.coinType]
    if (!coin) return '0'
    return formatBaseUnits(availableSupplyRaw, coin.decimals, 6)
  }, [actionMarket, availableSupplyRaw])

  const activeAvailableRaw = actionKind === 'borrow' ? availableBorrowRaw : availableSupplyRaw
  const activeAmountUsd = actionKind === 'borrow' ? borrowAmountUsd : supplyAmountUsd
  const activeAvailableDisplay =
    actionKind === 'borrow' ? availableBorrowDisplay : availableSupplyDisplay

  const selectedWithdrawCoinType = selectedWithdrawPosition?.coinType ?? ''
  const selectedWithdrawCoin = COIN_BY_TYPE[selectedWithdrawCoinType] ?? null
  const selectedWithdrawMarket = marketByCoinType[selectedWithdrawCoinType]
  const withdrawPriceNum = useMemo(() => {
    const parsed = Number(withdrawPrice)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    if (!selectedWithdrawCoinType) return 0
    return pricesByCoinType[selectedWithdrawCoinType] ?? 0
  }, [pricesByCoinType, selectedWithdrawCoinType, withdrawPrice])
  const withdrawPriceScaled = useMemo(
    () => BigInt(Math.max(0, Math.floor(withdrawPriceNum * PRICE_SCALE))),
    [withdrawPriceNum],
  )
  const withdrawableRaw = useMemo(() => {
    if (!selectedWithdrawPosition || !selectedWithdrawMarket) return 0n
    if (withdrawPriceScaled <= 0n) return 0n
    const collateralValue = selectedWithdrawPosition.collateralValue
    const borrowedValueRaw = selectedWithdrawPosition.borrowedValue
    const collateralFactor = BigInt(Math.max(1, selectedWithdrawMarket.collateralFactor))
    const requiredCollateralValue = (borrowedValueRaw * 10000n) / collateralFactor
    const maxWithdrawValue = collateralValue > requiredCollateralValue ? collateralValue - requiredCollateralValue : 0n
    if (maxWithdrawValue <= 0n) return 0n
    return maxWithdrawValue / withdrawPriceScaled
  }, [selectedWithdrawMarket, selectedWithdrawPosition, withdrawPriceScaled])
  const withdrawableDisplay = useMemo(() => {
    if (!selectedWithdrawCoin) return '0'
    return formatBaseUnits(withdrawableRaw, selectedWithdrawCoin.decimals, 6)
  }, [selectedWithdrawCoin, withdrawableRaw])
  const withdrawAmountUsd = useMemo(() => {
    if (!selectedWithdrawCoin || !withdrawAmount.trim() || withdrawPriceNum <= 0) return 0
    try {
      const amountRaw = parseAmountToBaseUnits(withdrawAmount, selectedWithdrawCoin.decimals)
      const amount = toDecimalNumber(amountRaw, selectedWithdrawCoin.decimals)
      return amount * withdrawPriceNum
    } catch {
      return 0
    }
  }, [selectedWithdrawCoin, withdrawAmount, withdrawPriceNum])

  const selectedRepayCoinType = selectedRepayPosition?.coinType ?? ''
  const selectedRepayCoin = COIN_BY_TYPE[selectedRepayCoinType] ?? null
  const selectedRepayMarket = marketByCoinType[selectedRepayCoinType]
  const repayPriceNum = useMemo(() => {
    const parsed = Number(repayPrice)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    if (!selectedRepayCoinType) return 0
    return pricesByCoinType[selectedRepayCoinType] ?? 0
  }, [pricesByCoinType, repayPrice, selectedRepayCoinType])
  const repayPriceScaled = useMemo(
    () => BigInt(Math.max(0, Math.floor(repayPriceNum * PRICE_SCALE))),
    [repayPriceNum],
  )
  const repayDebtRaw = useMemo(() => {
    if (!selectedRepayPosition) return 0n
    if (repayPriceScaled <= 0n) return 0n
    // ceil(borrowedValue / price) so dust debt can still be repaid with one base unit
    return (selectedRepayPosition.borrowedValue + repayPriceScaled - 1n) / repayPriceScaled
  }, [repayPriceScaled, selectedRepayPosition])
  const repayWalletRaw = useMemo(() => {
    if (!selectedRepayCoinType) return 0n
    return BigInt(walletBalances[selectedRepayCoinType] ?? '0')
  }, [selectedRepayCoinType, walletBalances])
  const repayAvailableRaw = useMemo(() => {
    if (!selectedRepayPosition || !selectedRepayMarket) return 0n
    return repayWalletRaw < repayDebtRaw ? repayWalletRaw : repayDebtRaw
  }, [repayDebtRaw, repayWalletRaw, selectedRepayMarket, selectedRepayPosition])
  const repayAvailableDisplay = useMemo(() => {
    if (!selectedRepayCoin) return '0'
    return formatBaseUnits(repayAvailableRaw, selectedRepayCoin.decimals, 6)
  }, [repayAvailableRaw, selectedRepayCoin])
  const repayAmountUsd = useMemo(() => {
    if (!selectedRepayCoin || !repayAmount.trim() || repayPriceNum <= 0) return 0
    try {
      const amountRaw = parseAmountToBaseUnits(repayAmount, selectedRepayCoin.decimals)
      const amount = toDecimalNumber(amountRaw, selectedRepayCoin.decimals)
      return amount * repayPriceNum
    } catch {
      return 0
    }
  }, [repayAmount, repayPriceNum, selectedRepayCoin])

  const openActionModal = (kind: ActionKind, market: LendAsset) => {
    setActionKind(kind)
    setActionMarket(market)
    setActionAmount('')
    setActionPrice(String(pricesByCoinType[market.coinType] ?? 0))
    const supplyPosition = supplyPositions[0]
    setSelectedPositionId((prev) => prev || supplyPosition?.id || activePositions[0]?.id || '')
    setBorrowSliderPct(0)
    setShowActionModal(true)
  }

  const onActionAmountChange = (value: string) => {
    setActionAmount(value)
    if (!actionMarket) {
      setBorrowSliderPct(0)
      return
    }
    const coin = COIN_BY_TYPE[actionMarket.coinType]
    if (!coin || activeAvailableRaw <= 0n || !value.trim()) {
      setBorrowSliderPct(0)
      return
    }
    try {
      const amountRaw = parseAmountToBaseUnits(value, coin.decimals)
      const pct = Number((amountRaw * 10000n) / activeAvailableRaw) / 100
      setBorrowSliderPct(Math.max(0, Math.min(100, pct)))
    } catch {
      setBorrowSliderPct(0)
    }
  }

  const onActionSliderChange = (nextPct: number) => {
    setBorrowSliderPct(nextPct)
    if (!actionMarket) return
    const coin = COIN_BY_TYPE[actionMarket.coinType]
    if (!coin || activeAvailableRaw <= 0n) {
      setActionAmount('')
      return
    }
    const amountRaw = (activeAvailableRaw * BigInt(Math.round(nextPct * 100))) / 10000n
    if (amountRaw <= 0n) {
      setActionAmount('')
      return
    }
    setActionAmount(formatBaseUnits(amountRaw, coin.decimals, 6))
  }

  const onCreateMarket = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      setFeedback('')
      setTxDigest('')

      if (!isAdmin) throw new Error('Only admin can create markets.')
      if (!configId) throw new Error('GlobalConfig not found on-chain.')

      const collateralFactor = Number(collateralFactorInput)
      if (!Number.isInteger(collateralFactor) || collateralFactor <= 0 || collateralFactor > 10000) {
        throw new Error('Collateral factor must be an integer between 1 and 10000.')
      }

      setSubmitting(true)
      const selectedCoinType = marketCoinType
      const selectedCoin = COIN_BY_TYPE[selectedCoinType] ?? null
      const tx = new Transaction()
      tx.moveCall({
        target: `${AQUALEND_PACKAGE_ID}::market::create_market`,
        typeArguments: [selectedCoinType],
        arguments: [tx.object(configId), tx.pure.u64(collateralFactor)],
      })

      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      setMarkets((prev) => {
        if (prev.some((item) => item.coinType === selectedCoinType)) return prev
        return [
          {
            marketId: `pending-${result.digest}`,
            coinType: selectedCoinType,
            collateralFactor,
            logoUrl: selectedCoin?.logoUrl ?? '/aquadex-logo.png',
            symbol: selectedCoin?.symbol ?? shortTypeName(selectedCoinType),
            name: selectedCoin?.name ?? shortTypeName(selectedCoinType),
            price: formatUsdNumber(pricesByCoinType[selectedCoinType] ?? 0),
            categories: categorizeCoin(selectedCoin),
            supply: '0',
            supplyValue: formatUsdNumber(0),
            borrow: '0',
            borrowValue: formatUsdNumber(0),
            supplyApr: '0.00%',
            borrowApr: '0.00%',
          },
          ...prev,
        ]
      })

      setTxDigest(result.digest)
      setFeedback('Market created successfully.')
      setShowCreateMarketModal(false)
      setCoinPickerOpen(false)

      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const marketIds = await findMarketIds(client)
          if (marketIds.length > 0) {
            const objects = await client.multiGetObjects({
              ids: marketIds,
              options: { showType: true },
            })

            const found = objects.some((item) => parseMarketCoinType(item.data?.type) === selectedCoinType)
            if (found) break
          }
        } catch {
          // ignore transient indexer errors and retry
        }
        await delay(600 * (attempt + 1))
      }

      await loadOnchainData()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to create market.')
    } finally {
      setSubmitting(false)
    }
  }

  const onTogglePause = async (pause: boolean) => {
    try {
      setFeedback('')
      setTxDigest('')

      if (!isAdmin) throw new Error('Only admin can manage pause state.')
      if (!configId) throw new Error('GlobalConfig not found on-chain.')

      setSubmitting(true)
      const tx = new Transaction()
      tx.moveCall({
        target: `${AQUALEND_PACKAGE_ID}::config::${pause ? 'pause' : 'unpause'}`,
        arguments: [tx.object(configId)],
      })

      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      // Optimistic state update so UI reflects the action immediately.
      setConfigPaused(pause)
      setTxDigest(result.digest)
      setFeedback(pause ? 'Protocol paused.' : 'Protocol unpaused.')

      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const onchainPaused = await readPausedState(client)
          setConfigPaused(onchainPaused)
          if (onchainPaused === pause) break
        } catch {
          // ignore transient read errors and retry
        }
        await delay(500 * (attempt + 1))
      }

      await loadOnchainData()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to update protocol state.')
    } finally {
      setSubmitting(false)
    }
  }

  const onSubmitAction = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      setFeedback('')
      setTxDigest('')

      if (!account?.address) throw new Error('Connect wallet first.')
      if (!actionMarket) throw new Error('Select a market first.')
      if (!configId) throw new Error('Missing GlobalConfig object.')

      const coin = COIN_BY_TYPE[actionMarket.coinType]
      if (!coin) throw new Error('Unsupported coin metadata.')

      const priceNum = Number(actionPrice)
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        throw new Error('Enter a valid price greater than 0.')
      }
      const priceU64 = BigInt(Math.floor(priceNum * PRICE_SCALE))
      if (priceU64 <= 0n) throw new Error('Price parameter is too small.')

      const tx = new Transaction()

      if (actionKind === 'supply') {
        const amountRaw = parseAmountToBaseUnits(actionAmount, coin.decimals)
        if (amountRaw <= 0n) throw new Error('Supply amount must be greater than 0.')
        if (amountRaw > availableSupplyRaw) throw new Error('Supply amount exceeds available wallet balance.')

        const coinObjects =
          actionMarket.coinType === SUI_COIN_TYPE
            ? []
            : await getAllCoinsByType(client, account.address, actionMarket.coinType)
        const coinInput = buildCoinInput(tx, actionMarket.coinType, amountRaw, coinObjects)

        if (activePositions.length === 0) {
          tx.moveCall({
            target: `${AQUALEND_PACKAGE_ID}::vault::new_deposit`,
            typeArguments: [actionMarket.coinType],
            arguments: [
              tx.object(configId),
              coinInput,
              tx.pure.u64(priceU64),
              tx.object(actionMarket.marketId),
            ],
          })
        } else {
          if (!selectedPositionId) throw new Error('Select a position for add_deposits.')
          tx.moveCall({
            target: `${AQUALEND_PACKAGE_ID}::vault::add_deposits`,
            typeArguments: [actionMarket.coinType],
            arguments: [
              tx.object(configId),
              tx.object(actionMarket.marketId),
              tx.object(selectedPositionId),
              coinInput,
              tx.pure.u64(priceU64),
            ],
          })
        }
      } else {
        if (!selectedPositionId) throw new Error('Select a position first.')
        const amountRaw = parseAmountToBaseUnits(actionAmount, coin.decimals)
        if (amountRaw <= 0n) throw new Error('Borrow amount must be greater than 0.')
        if (amountRaw > availableBorrowRaw) throw new Error('Borrow amount exceeds available borrow balance.')

        tx.moveCall({
          target: `${AQUALEND_PACKAGE_ID}::vault::borrow`,
          typeArguments: [actionMarket.coinType],
          arguments: [
            tx.object(configId),
            tx.object(actionMarket.marketId),
            tx.object(selectedPositionId),
            tx.pure.u128(amountRaw),
            tx.pure.u64(priceU64),
          ],
        })
      }

      setSubmitting(true)
      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      setTxDigest(result.digest)
      setFeedback(`${actionKind === 'supply' ? 'Supply' : 'Borrow'} transaction submitted.`)
      setShowActionModal(false)

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await delay(500 * (attempt + 1))
        await loadOnchainData()
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to submit action.')
    } finally {
      setSubmitting(false)
    }
  }

  const onOpenWithdrawModal = (position: PositionRow) => {
    setSelectedWithdrawPosition(position)
    const coinType = position.coinType ?? ''
    setWithdrawAmount('')
    setWithdrawPrice(String(pricesByCoinType[coinType] ?? 0))
    setWithdrawSliderPct(0)
    setShowWithdrawModal(true)
  }

  const onOpenRepayModal = (position: PositionRow) => {
    setSelectedRepayPosition(position)
    const coinType = position.coinType ?? ''
    setRepayAmount('')
    setRepayPrice(String(pricesByCoinType[coinType] ?? 0))
    setRepaySliderPct(0)
    setShowRepayModal(true)
  }

  const onWithdrawAmountChange = (value: string) => {
    setWithdrawAmount(value)
    if (!selectedWithdrawCoin || withdrawableRaw <= 0n || !value.trim()) {
      setWithdrawSliderPct(0)
      return
    }
    try {
      const amountRaw = parseAmountToBaseUnits(value, selectedWithdrawCoin.decimals)
      const pct = Number((amountRaw * 10000n) / withdrawableRaw) / 100
      setWithdrawSliderPct(Math.max(0, Math.min(100, pct)))
    } catch {
      setWithdrawSliderPct(0)
    }
  }

  const onWithdrawSliderChange = (nextPct: number) => {
    setWithdrawSliderPct(nextPct)
    if (!selectedWithdrawCoin || withdrawableRaw <= 0n) {
      setWithdrawAmount('')
      return
    }
    const amountRaw = (withdrawableRaw * BigInt(Math.round(nextPct * 100))) / 10000n
    if (amountRaw <= 0n) {
      setWithdrawAmount('')
      return
    }
    setWithdrawAmount(formatBaseUnits(amountRaw, selectedWithdrawCoin.decimals, 6))
  }

  const onSubmitWithdraw = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      setFeedback('')
      setTxDigest('')

      if (!account?.address) throw new Error('Connect wallet first.')
      if (!selectedWithdrawPosition) throw new Error('Select a position first.')
      if (!selectedWithdrawPosition.coinType) {
        throw new Error('Could not infer coin type for this position.')
      }
      if (!configId) throw new Error('Missing GlobalConfig object.')

      const coinType = selectedWithdrawPosition.coinType
      const coin = COIN_BY_TYPE[coinType]
      if (!coin) throw new Error('Unsupported coin metadata for this position.')

      const market = marketByCoinType[coinType]
      if (!market) throw new Error('Matching market not found for this position.')

      const amountRaw = parseAmountToBaseUnits(withdrawAmount, coin.decimals)
      if (amountRaw <= 0n) throw new Error('Withdraw amount must be greater than 0.')
      if (amountRaw > withdrawableRaw) throw new Error('Withdraw amount exceeds withdrawable balance.')

      const priceNum = Number(withdrawPrice)
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        throw new Error('Enter a valid price greater than 0.')
      }
      const priceU64 = BigInt(Math.floor(priceNum * PRICE_SCALE))
      if (priceU64 <= 0n) throw new Error('Price parameter is too small.')

      const tx = new Transaction()
      tx.moveCall({
        target: `${AQUALEND_PACKAGE_ID}::vault::withdraw`,
        typeArguments: [coinType],
        arguments: [
          tx.object(configId),
          tx.object(market.marketId),
          tx.object(selectedWithdrawPosition.id),
          tx.pure.u128(amountRaw),
          tx.pure.u64(priceU64),
        ],
      })

      setSubmitting(true)
      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      setTxDigest(result.digest)
      setFeedback('Withdraw transaction submitted.')
      setShowWithdrawModal(false)
      setSelectedWithdrawPosition(null)

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await delay(500 * (attempt + 1))
        await loadOnchainData()
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to withdraw.')
    } finally {
      setSubmitting(false)
    }
  }

  const onRepayAmountChange = (value: string) => {
    setRepayAmount(value)
    if (!selectedRepayCoin || repayAvailableRaw <= 0n || !value.trim()) {
      setRepaySliderPct(0)
      return
    }
    try {
      const amountRaw = parseAmountToBaseUnits(value, selectedRepayCoin.decimals)
      const pct = Number((amountRaw * 10000n) / repayAvailableRaw) / 100
      setRepaySliderPct(Math.max(0, Math.min(100, pct)))
    } catch {
      setRepaySliderPct(0)
    }
  }

  const onRepaySliderChange = (nextPct: number) => {
    setRepaySliderPct(nextPct)
    if (!selectedRepayCoin || repayAvailableRaw <= 0n) {
      setRepayAmount('')
      return
    }
    const amountRaw = (repayAvailableRaw * BigInt(Math.round(nextPct * 100))) / 10000n
    if (amountRaw <= 0n) {
      setRepayAmount('')
      return
    }
    setRepayAmount(formatBaseUnits(amountRaw, selectedRepayCoin.decimals, 6))
  }

  const onSubmitRepay = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      setFeedback('')
      setTxDigest('')

      if (!account?.address) throw new Error('Connect wallet first.')
      if (!selectedRepayPosition) throw new Error('Select a borrow position first.')
      if (!selectedRepayPosition.coinType) {
        throw new Error('Could not infer coin type for this position.')
      }
      if (!configId) throw new Error('Missing GlobalConfig object.')

      const coinType = selectedRepayPosition.coinType
      const coin = COIN_BY_TYPE[coinType]
      if (!coin) throw new Error('Unsupported coin metadata for this position.')

      const market = marketByCoinType[coinType]
      if (!market) throw new Error('Matching market not found for this position.')

      const amountRaw = parseAmountToBaseUnits(repayAmount, coin.decimals)
      if (amountRaw <= 0n) throw new Error('Repay amount must be greater than 0.')
      if (amountRaw > repayAvailableRaw) throw new Error('Repay amount exceeds available repay balance.')

      const priceNum = Number(repayPrice)
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        throw new Error('Enter a valid price greater than 0.')
      }
      let priceU64 = BigInt(Math.floor(priceNum * PRICE_SCALE))
      if (priceU64 <= 0n) throw new Error('Price parameter is too small.')

      // For full repay, maximize repay_value safely to avoid tiny leftover dust.
      if (amountRaw === repayAvailableRaw && selectedRepayPosition.borrowedValue > 0n) {
        const maxSafePrice = selectedRepayPosition.borrowedValue / amountRaw
        if (maxSafePrice > 0n && maxSafePrice <= U64_MAX) {
          priceU64 = maxSafePrice
        }
      }

      const tx = new Transaction()
      const coinObjects =
        coinType === SUI_COIN_TYPE ? [] : await getAllCoinsByType(client, account.address, coinType)
      const coinInput = buildCoinInput(tx, coinType, amountRaw, coinObjects)

      tx.moveCall({
        target: `${AQUALEND_PACKAGE_ID}::vault::repay`,
        typeArguments: [coinType],
        arguments: [
          tx.object(configId),
          tx.object(market.marketId),
          tx.object(selectedRepayPosition.id),
          coinInput,
          tx.pure.u64(priceU64),
        ],
      })

      setSubmitting(true)
      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      setTxDigest(result.digest)
      setFeedback('Repay transaction submitted.')
      setShowRepayModal(false)
      setSelectedRepayPosition(null)

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await delay(500 * (attempt + 1))
        await loadOnchainData()
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to repay.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="content-section aqualend-page">
      <header className="aqualend-header">
        <h2>AquaLend Market</h2>
        <div className="aqualend-stats">
          <article>
            <p>TVL</p>
            <strong>{tvlDisplay}</strong>
          </article>
          <article>
            <p>Total Supply</p>
            <strong>{totalSupplyDisplay}</strong>
          </article>
          <article>
            <p>Total Borrow</p>
            <strong>{totalBorrowDisplay}</strong>
          </article>
        </div>
      </header>

      <article className="aqualend-banner">
        <div>
          <p className="detail-sub">AquaLend Security Portal</p>
          <h3>Built in Public. Audited, Monitored, and Verified.</h3>
          <p>Isolated lending pools, transparent interest curves, and real-time risk controls.</p>
        </div>
        <span className="security-mark" aria-hidden>
          ✓
        </span>
      </article>

      {isAdmin ? (
        <div className="aqualend-admin-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowCreateMarketModal(true)}
            disabled={submitting}
          >
            Create Market
          </button>
          {configPaused ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void onTogglePause(false)}
              disabled={submitting || !configId}
            >
              Unpause
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setShowPauseConfirmModal(true)}
              disabled={submitting || !configId}
            >
              Pause
            </button>
          )}
          <span className="admin-status">
            <span className={`status-dot ${configPaused ? 'paused' : 'live'}`} aria-hidden />
            <span>{configPaused ? 'Paused' : 'Active'}</span>
          </span>
        </div>
      ) : null}

      <div className="aqualend-filters">
        <div className="aqualend-tabs" role="tablist" aria-label="Asset Categories">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={selectedCategory === tab ? 'active' : ''}
              onClick={() => setSelectedCategory(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Search assets"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search assets"
        />
      </div>

      <div className="aqualend-market-grid">
        <div className="aqualend-main">
          <div className="aqualend-table-wrap">
            <table className="aqualend-table">
              <thead>
                <tr>
                  <th>Assets</th>
                  <th>Supply</th>
                  <th>Borrow</th>
                  <th>Supply APR</th>
                  <th>Borrow APR</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {!loading && filteredAssets.length === 0 ? (
                  <tr>
                    <td colSpan={6}>No markets found on-chain yet.</td>
                  </tr>
                ) : null}
                {filteredAssets.map((asset) => (
                  <tr key={asset.marketId}>
                    {(() => {
                      const coinPrice = pricesByCoinType[asset.coinType] ?? 0
                      const supplyAmount = Number(asset.supply)
                      const borrowAmount = Number(asset.borrow)
                      const supplyUsd = Number.isFinite(supplyAmount) ? supplyAmount * coinPrice : 0
                      const borrowUsd = Number.isFinite(borrowAmount) ? borrowAmount * coinPrice : 0

                      return (
                        <>
                    <td>
                      <div className="aqualend-asset">
                        <img src={asset.logoUrl} alt={`${asset.symbol} logo`} className="aqualend-asset-logo" />
                        <div>
                          <strong>{asset.symbol}</strong>
                          <p>{formatUsdNumber(pricesByCoinType[asset.coinType] ?? 0)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="metric-col">
                      <div className="metric-stack">
                        <strong>{asset.supply}</strong>
                        <p>{formatUsdNumber(supplyUsd)}</p>
                      </div>
                    </td>
                    <td className="metric-col">
                      <div className="metric-stack">
                        <strong>{asset.borrow}</strong>
                        <p>{formatUsdNumber(borrowUsd)}</p>
                      </div>
                    </td>
                    <td className="metric-col">
                      <strong className="apr-positive">{asset.supplyApr}</strong>
                    </td>
                    <td className="metric-col">
                      <strong className="apr-warn">{asset.borrowApr}</strong>
                    </td>
                    <td className="actions-col">
                      <div className="aqualend-actions">
                        <button
                          type="button"
                          onClick={() => openActionModal('borrow', asset)}
                          disabled={submitting || configPaused || supplyPositions.length === 0}
                        >
                          Borrow
                        </button>
                        <button
                          type="button"
                          onClick={() => openActionModal('supply', asset)}
                          disabled={submitting || configPaused}
                        >
                          Supply
                        </button>
                      </div>
                    </td>
                        </>
                      )
                    })()}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="aqualend-side">
          <section className="account-card">
            <div className="account-top">
              <h3>Your Account</h3>
            </div>
            <div className="net-worth-row">
              <div>
                <p>Net Worth</p>
                <strong>{formatUsdNumber(walletNetWorth)}</strong>
              </div>
            </div>
            <div className="account-split">
              <article>
                <p>Your Borrowed</p>
                <strong>{formatUsdNumber(borrowedValue)}</strong>
              </article>
              <article>
                <p>Your Supplied</p>
                <strong>{formatUsdNumber(suppliedValue)}</strong>
              </article>
            </div>
            <div className="risk-row">
              <div>
                <p>Health Factor</p>
                <strong>{borrowedValue === 0 ? '∞' : '1.00'}</strong>
              </div>
              <div>
                <p>Borrow Limit</p>
                <strong>{formatUsdNumber(0)}</strong>
              </div>
              <div>
                <p>Liq. Level</p>
                <strong>{formatUsdNumber(0)}</strong>
              </div>
            </div>
          </section>

          <section className="positions-card">
            <div className="positions-head">
              <h3>Your Positions</h3>
              <p>Net APR 0.00%</p>
            </div>
            <div className="positions-tabs">
              <button
                type="button"
                className={positionTab === 'supply' ? 'active' : ''}
                onClick={() => setPositionTab('supply')}
              >
                Supply ({supplyPositions.length})
              </button>
              <button
                type="button"
                className={positionTab === 'borrow' ? 'active' : ''}
                onClick={() => setPositionTab('borrow')}
              >
                Borrow ({borrowPositions.length})
              </button>
            </div>
            <div className="positions-list">
              {(positionTab === 'supply' ? supplyPositions : borrowPositions).length === 0 ? (
                <p className="positions-empty">No {positionTab} positions yet.</p>
              ) : (
                (positionTab === 'supply' ? supplyPositions : borrowPositions).map((position) => (
                  <article
                    key={position.id}
                    onClick={() =>
                      positionTab === 'supply' ? onOpenWithdrawModal(position) : onOpenRepayModal(position)
                    }
                    className="position-row-btn"
                  >
                    {(() => {
                      const coin = COIN_BY_TYPE[position.coinType ?? ''] ?? null
                      const price = pricesByCoinType[position.coinType ?? ''] ?? 0
                      const collateralUsd = toDecimalNumber(position.collateralValue, (coin?.decimals ?? 9) + 6)
                      const borrowedUsd = toDecimalNumber(position.borrowedValue, (coin?.decimals ?? 9) + 6)
                      const suppliedCoins = price > 0 ? collateralUsd / price : 0
                      const borrowedCoins = price > 0 ? borrowedUsd / price : 0

                      return (
                        <>
                          <div className="aqualend-asset">
                            <img
                              src={coin?.logoUrl ?? '/aquadex-logo.png'}
                              alt={`${coin?.symbol ?? 'coin'} logo`}
                              className="aqualend-asset-logo"
                            />
                            <strong>{coin?.symbol ?? shortTypeName(position.coinType ?? 'Unknown')}</strong>
                          </div>
                          <div className="position-amount">
                            {positionTab === 'supply' ? (
                              <>
                                <strong>{suppliedCoins.toFixed(6)} {coin?.symbol ?? ''}</strong>
                                <p>Collateral: {formatUsdNumber(collateralUsd)}</p>
                              </>
                            ) : (
                              <>
                                <strong>{borrowedCoins.toFixed(6)} {coin?.symbol ?? ''}</strong>
                                <p>Borrowed: {formatUsdNumber(borrowedUsd)}</p>
                              </>
                            )}
                          </div>
                        </>
                      )
                    })()}
                  </article>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>

      {feedback ? <p className="status-line">{feedback}</p> : null}
      {txDigest ? (
        <a className="status-link" href={suiscTxUrl(txDigest)} target="_blank" rel="noreferrer">
          View transaction on SuiScan
        </a>
      ) : null}

      {showCreateMarketModal ? (
        <div className="modal-overlay" role="presentation" onClick={() => setShowCreateMarketModal(false)}>
          <div className="create-market-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>Create Market</h3>
            <p className="section-copy">Package: {AQUALEND_PACKAGE_ID}</p>
            <p className="section-copy">GlobalConfig: {AQUALEND_GLOBAL_CONFIG_ID}</p>
            <form onSubmit={onCreateMarket} className="create-market-form">
              <label htmlFor="market-asset">Asset</label>
              <div className="coin-picker">
                <button
                  id="market-asset"
                  type="button"
                  className="coin-picker-trigger"
                  onClick={() => setCoinPickerOpen((prev) => !prev)}
                >
                  <span className="coin-picker-trigger-left">
                    <img
                      src={COIN_BY_TYPE[marketCoinType]?.logoUrl ?? '/aquadex-logo.png'}
                      alt={`${COIN_BY_TYPE[marketCoinType]?.symbol ?? 'coin'} logo`}
                    />
                    <span>{COIN_BY_TYPE[marketCoinType]?.symbol ?? shortTypeName(marketCoinType)}</span>
                  </span>
                  <span>{coinPickerOpen ? '▲' : '▼'}</span>
                </button>

                {coinPickerOpen ? (
                  <div className="coin-picker-menu" role="listbox" aria-label="Market coin type">
                    {COINS.map((coin) => (
                      <button
                        key={coin.coinType}
                        type="button"
                        role="option"
                        aria-selected={marketCoinType === coin.coinType}
                        className={marketCoinType === coin.coinType ? 'selected' : ''}
                        onClick={() => {
                          setMarketCoinType(coin.coinType)
                          setCoinPickerOpen(false)
                        }}
                      >
                        <span>
                          <img src={coin.logoUrl} alt={`${coin.symbol} logo`} />
                          <strong>{coin.symbol}</strong>
                        </span>
                        <small>{coin.name}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <label htmlFor="collateral-factor">Collateral Factor (bps)</label>
              <input
                id="collateral-factor"
                type="number"
                min={1}
                max={10000}
                value={collateralFactorInput}
                onChange={(event) => setCollateralFactorInput(event.target.value)}
              />

              <label htmlFor="config-id">Global Config Object</label>
              <input id="config-id" value={configId} readOnly />

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowCreateMarketModal(false)
                    setCoinPickerOpen(false)
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting || !configId}>
                  {submitting ? 'Creating...' : 'Create Market'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showPauseConfirmModal ? (
        <div className="modal-overlay" role="presentation" onClick={() => setShowPauseConfirmModal(false)}>
          <div className="create-market-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>Pause AquaLend Protocol</h3>
            <p className="section-copy">
              This will pause protocol operations guarded by <code>assert_not_paused</code>.
              Make sure you want to continue.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowPauseConfirmModal(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={submitting || !configId}
                onClick={async () => {
                  setShowPauseConfirmModal(false)
                  await onTogglePause(true)
                }}
              >
                Yes, Pause Protocol
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showActionModal && actionMarket ? (
        <div className="modal-overlay" role="presentation" onClick={() => setShowActionModal(false)}>
          <div className="create-market-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            {actionKind === 'borrow' ? (
              <>
                <div className="borrow-modal-head">
                  <h3>Borrow Position</h3>
                  <button
                    type="button"
                    className="borrow-modal-close"
                    aria-label="Close borrow modal"
                    onClick={() => setShowActionModal(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="borrow-asset-strip">
                  <img src={actionMarket.logoUrl} alt={`${actionMarket.symbol} logo`} className="aqualend-asset-logo" />
                  <div>
                    <strong>{actionMarket.symbol}</strong>
                    <p>{actionMarket.name}</p>
                  </div>
                </div>
                <form onSubmit={onSubmitAction} className="borrow-modal-form">
                  <label htmlFor="action-amount">Amount</label>
                  <div className="borrow-amount-card">
                    <div className="borrow-amount-meta">
                      <span>{formatUsdNumber(activeAmountUsd)}</span>
                      <span>
                        Available: {activeAvailableDisplay} {actionMarket.symbol}
                      </span>
                    </div>
                    <input
                      id="action-amount"
                      type="text"
                      inputMode="decimal"
                      placeholder={`0.0 ${actionMarket.symbol}`}
                      value={actionAmount}
                      onChange={(event) => onActionAmountChange(event.target.value)}
                    />
                  </div>

                  <div className="borrow-slider-wrap">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(borrowSliderPct)}
                      onChange={(event) => onActionSliderChange(Number(event.target.value))}
                      disabled={activeAvailableRaw <= 0n}
                    />
                    <div className="borrow-slider-labels">
                      <span>0%</span>
                      <span>25%</span>
                      <span>50%</span>
                      <span>75%</span>
                      <span>100%</span>
                    </div>
                  </div>

                  <div className="borrow-overview">
                    <h4>Transaction Overview</h4>
                    <div className="borrow-overview-row">
                      <span>Borrow Fee</span>
                      <strong>0.3%</strong>
                    </div>
                    <div className="borrow-overview-row">
                      <span>Borrow APR</span>
                      <strong>{actionMarket.borrowApr}</strong>
                    </div>
                    <div className="borrow-overview-row">
                      <span>Health Factor</span>
                      <strong>{activeBorrowPosition?.collateralValue ? '1.00' : '∞'}</strong>
                    </div>
                  </div>

                  <div className="modal-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => setShowActionModal(false)}>
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={submitting || supplyPositions.length === 0 || availableBorrowRaw <= 0n}
                    >
                      {submitting ? 'Submitting...' : actionAmount.trim() ? 'Confirm Borrow' : 'Enter An Amount'}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
                <div className="borrow-modal-head">
                  <h3>Supply Position</h3>
                  <button
                    type="button"
                    className="borrow-modal-close"
                    aria-label="Close supply modal"
                    onClick={() => setShowActionModal(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="borrow-asset-strip">
                  <img src={actionMarket.logoUrl} alt={`${actionMarket.symbol} logo`} className="aqualend-asset-logo" />
                  <div>
                    <strong>{actionMarket.symbol}</strong>
                    <p>{actionMarket.name}</p>
                  </div>
                </div>
                <form onSubmit={onSubmitAction} className="borrow-modal-form">
                  <label htmlFor="action-amount">Amount</label>
                  <div className="borrow-amount-card">
                    <div className="borrow-amount-meta">
                      <span>{formatUsdNumber(activeAmountUsd)}</span>
                      <span>
                        Available: {activeAvailableDisplay} {actionMarket.symbol}
                      </span>
                    </div>
                    <input
                      id="action-amount"
                      type="text"
                      inputMode="decimal"
                      placeholder={`0.0 ${actionMarket.symbol}`}
                      value={actionAmount}
                      onChange={(event) => onActionAmountChange(event.target.value)}
                    />
                  </div>

                  <div className="borrow-slider-wrap">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(borrowSliderPct)}
                      onChange={(event) => onActionSliderChange(Number(event.target.value))}
                      disabled={activeAvailableRaw <= 0n}
                    />
                    <div className="borrow-slider-labels">
                      <span>0%</span>
                      <span>25%</span>
                      <span>50%</span>
                      <span>75%</span>
                      <span>100%</span>
                    </div>
                  </div>

                  <div className="borrow-overview">
                    <h4>Transaction Overview</h4>
                    <div className="borrow-overview-row">
                      <span>Supply Fee</span>
                      <strong>0.0%</strong>
                    </div>
                    <div className="borrow-overview-row">
                      <span>Supply APR</span>
                      <strong>{actionMarket.supplyApr}</strong>
                    </div>
                    <div className="borrow-overview-row">
                      <span>Health Factor</span>
                      <strong>{supplyPositions.length > 0 ? '1.00' : '∞'}</strong>
                    </div>
                  </div>

                  <div className="modal-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => setShowActionModal(false)}>
                      Cancel
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={submitting || activeAvailableRaw <= 0n}>
                      {submitting ? 'Submitting...' : actionAmount.trim() ? 'Confirm Supply' : 'Enter An Amount'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      ) : null}

      {showWithdrawModal && selectedWithdrawPosition ? (
        <div className="modal-overlay" role="presentation" onClick={() => setShowWithdrawModal(false)}>
          <div className="create-market-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="borrow-modal-head">
              <h3>Withdraw Position</h3>
              <button
                type="button"
                className="borrow-modal-close"
                aria-label="Close withdraw modal"
                onClick={() => {
                  setShowWithdrawModal(false)
                  setSelectedWithdrawPosition(null)
                }}
              >
                ×
              </button>
            </div>
            <div className="borrow-asset-strip">
              <img
                src={selectedWithdrawCoin?.logoUrl ?? '/aquadex-logo.png'}
                alt={`${selectedWithdrawCoin?.symbol ?? 'coin'} logo`}
                className="aqualend-asset-logo"
              />
              <div>
                <strong>{selectedWithdrawCoin?.symbol ?? shortTypeName(selectedWithdrawCoinType || 'coin')}</strong>
                <p>{selectedWithdrawCoin?.name ?? 'Unknown Coin'}</p>
              </div>
            </div>
            <form onSubmit={onSubmitWithdraw} className="borrow-modal-form">
              <label htmlFor="withdraw-amount">Amount</label>
              <div className="borrow-amount-card">
                <div className="borrow-amount-meta">
                  <span>{formatUsdNumber(withdrawAmountUsd)}</span>
                  <span>
                    Withdrawable: {withdrawableDisplay} {selectedWithdrawCoin?.symbol ?? ''}
                  </span>
                </div>
                <input
                  id="withdraw-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder={`0.0 ${selectedWithdrawCoin?.symbol ?? ''}`}
                  value={withdrawAmount}
                  onChange={(event) => onWithdrawAmountChange(event.target.value)}
                />
              </div>

              <div className="borrow-slider-wrap">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(withdrawSliderPct)}
                  onChange={(event) => onWithdrawSliderChange(Number(event.target.value))}
                  disabled={withdrawableRaw <= 0n}
                />
                <div className="borrow-slider-labels">
                  <span>0%</span>
                  <span>25%</span>
                  <span>50%</span>
                  <span>75%</span>
                  <span>100%</span>
                </div>
              </div>

              <div className="borrow-overview">
                <h4>Transaction Overview</h4>
                <div className="borrow-overview-row">
                  <span>Withdraw Fee</span>
                  <strong>0.0%</strong>
                </div>
                <div className="borrow-overview-row">
                  <span>Debt</span>
                  <strong>{formatUsdNumber(toDecimalNumber(selectedWithdrawPosition.borrowedValue, 15))}</strong>
                </div>
                <div className="borrow-overview-row">
                  <span>Health Factor</span>
                  <strong>{selectedWithdrawPosition.borrowedValue > 0n ? '1.00' : '∞'}</strong>
                </div>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowWithdrawModal(false)
                    setSelectedWithdrawPosition(null)
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting || withdrawableRaw <= 0n}>
                  {submitting ? 'Submitting...' : withdrawAmount.trim() ? 'Confirm Withdraw' : 'Enter An Amount'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showRepayModal && selectedRepayPosition ? (
        <div className="modal-overlay" role="presentation" onClick={() => setShowRepayModal(false)}>
          <div className="create-market-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="borrow-modal-head">
              <h3>Repay Position</h3>
              <button
                type="button"
                className="borrow-modal-close"
                aria-label="Close repay modal"
                onClick={() => {
                  setShowRepayModal(false)
                  setSelectedRepayPosition(null)
                }}
              >
                ×
              </button>
            </div>
            <div className="borrow-asset-strip">
              <img
                src={selectedRepayCoin?.logoUrl ?? '/aquadex-logo.png'}
                alt={`${selectedRepayCoin?.symbol ?? 'coin'} logo`}
                className="aqualend-asset-logo"
              />
              <div>
                <strong>{selectedRepayCoin?.symbol ?? shortTypeName(selectedRepayCoinType || 'coin')}</strong>
                <p>{selectedRepayCoin?.name ?? 'Unknown Coin'}</p>
              </div>
            </div>
            <form onSubmit={onSubmitRepay} className="borrow-modal-form">
              <label htmlFor="repay-amount">Amount</label>
              <div className="borrow-amount-card">
                <div className="borrow-amount-meta">
                  <span>{formatUsdNumber(repayAmountUsd)}</span>
                  <span>
                    Available: {repayAvailableDisplay} {selectedRepayCoin?.symbol ?? ''}
                  </span>
                </div>
                <input
                  id="repay-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder={`0.0 ${selectedRepayCoin?.symbol ?? ''}`}
                  value={repayAmount}
                  onChange={(event) => onRepayAmountChange(event.target.value)}
                />
              </div>

              <div className="borrow-slider-wrap">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(repaySliderPct)}
                  onChange={(event) => onRepaySliderChange(Number(event.target.value))}
                  disabled={repayAvailableRaw <= 0n}
                />
                <div className="borrow-slider-labels">
                  <span>0%</span>
                  <span>25%</span>
                  <span>50%</span>
                  <span>75%</span>
                  <span>100%</span>
                </div>
              </div>

              <div className="borrow-overview">
                <h4>Transaction Overview</h4>
                <div className="borrow-overview-row">
                  <span>Repay Fee</span>
                  <strong>0.00%</strong>
                </div>
                <div className="borrow-overview-row">
                  <span>Total Debt</span>
                  <strong>{formatUsdNumber(toDecimalNumber(selectedRepayPosition.borrowedValue, 15))}</strong>
                </div>
                <div className="borrow-overview-row">
                  <span>Health Factor</span>
                  <strong>{selectedRepayPosition.borrowedValue > 0n ? '1.00' : '∞'}</strong>
                </div>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setShowRepayModal(false)
                    setSelectedRepayPosition(null)
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting || repayAvailableRaw <= 0n}>
                  {submitting ? 'Submitting...' : repayAmount.trim() ? 'Confirm Repay' : 'Enter An Amount'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  )
}
