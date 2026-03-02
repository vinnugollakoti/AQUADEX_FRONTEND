import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useEffect, useMemo, useState } from 'react'
import { COIN_BY_TYPE, type CoinInfo, SUI_COIN_TYPE } from '../constants/coins'
import { NETWORK_CHAIN, PACKAGE_ID, suiscObjectUrl, suiscTxUrl } from '../constants/sui'
import { formatBalance, formatBaseUnits, parseAmountToBaseUnits, toDecimalNumber } from '../utils/amounts'
import { extractBalanceValue, extractPoolTypes, shortTypeName } from '../utils/pools'
import { buildCoinInput, getAllCoinsByType } from '../utils/txCoins'

type PoolInfo = {
  id: string
  coinAType: string
  coinBType: string
  coinA: CoinInfo | null
  coinB: CoinInfo | null
  reserveARaw: bigint
  reserveBRaw: bigint
}

type BalanceByType = Record<string, string>

type SwapQuote = {
  amountInRaw: bigint
  amountOutRaw: bigint
  minOutRaw: bigint
  reserveInRaw: bigint
  reserveOutRaw: bigint
  aToB: boolean
}

const POOL_CREATED_EVENT = `${PACKAGE_ID}::events::PoolCreatedEvent`

function parseU64LE(bytes: Uint8Array): bigint {
  if (bytes.length < 8) return 0n
  let value = 0n
  for (let i = 0; i < 8; i += 1) {
    value += BigInt(bytes[i]) << BigInt(8 * i)
  }
  return value
}

async function fetchPools(client: ReturnType<typeof useSuiClient>) {
  const events = await client.queryEvents({
    query: { MoveEventType: POOL_CREATED_EVENT },
    order: 'descending',
    limit: 100,
  })

  const poolIds = Array.from(
    new Set(
      events.data
        .map((event) => (event.parsedJson as { pool_id?: string })?.pool_id)
        .filter((id): id is string => Boolean(id)),
    ),
  )

  if (poolIds.length === 0) return [] as PoolInfo[]

  const objects = await client.multiGetObjects({
    ids: poolIds,
    options: { showType: true, showContent: true },
  })

  const pools: PoolInfo[] = []

  for (const object of objects) {
    const data = object.data
    if (!data?.objectId) continue

    const parsedTypes = extractPoolTypes(data.type)
    if (!parsedTypes) continue

    const content = data.content as { fields?: Record<string, unknown> } | undefined

    pools.push({
      id: data.objectId,
      coinAType: parsedTypes.coinAType,
      coinBType: parsedTypes.coinBType,
      coinA: COIN_BY_TYPE[parsedTypes.coinAType] ?? null,
      coinB: COIN_BY_TYPE[parsedTypes.coinBType] ?? null,
      reserveARaw: extractBalanceValue(content?.fields?.reserve_a),
      reserveBRaw: extractBalanceValue(content?.fields?.reserve_b),
    })
  }

  return pools
}

export function SwapPage() {
  const client = useSuiClient()
  const account = useCurrentAccount()
  const signAndExecute = useSignAndExecuteTransaction()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pools, setPools] = useState<PoolInfo[]>([])
  const [balances, setBalances] = useState<BalanceByType>({})

  const [fromType, setFromType] = useState('')
  const [toType, setToType] = useState('')
  const [amountIn, setAmountIn] = useState('')
  const [slippage, setSlippage] = useState('0.5')
  const [onchainPriceRaw, setOnchainPriceRaw] = useState<bigint | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [txDigest, setTxDigest] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        setError('')

        const nextPools = await fetchPools(client)
        setPools(nextPools)

        const availableTypes = Array.from(
          new Set(nextPools.flatMap((pool) => [pool.coinAType, pool.coinBType])),
        )

        if (availableTypes.length > 0) {
          setFromType((prev) => prev || availableTypes[0])
          const second = availableTypes[1] ?? availableTypes[0]
          setToType((prev) => prev || second)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load pools for swap.')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [client])

  useEffect(() => {
    const loadBalances = async () => {
      if (!account?.address) {
        setBalances({})
        return
      }

      const types = Array.from(new Set(pools.flatMap((pool) => [pool.coinAType, pool.coinBType])))
      const entries = await Promise.all(
        types.map(async (coinType) => {
          const balance = await client.getBalance({ owner: account.address, coinType })
          return [coinType, balance.totalBalance] as const
        }),
      )

      setBalances(Object.fromEntries(entries))
    }

    void loadBalances()
  }, [account?.address, client, pools])

  const availableCoinTypes = useMemo(
    () => Array.from(new Set(pools.flatMap((pool) => [pool.coinAType, pool.coinBType]))),
    [pools],
  )

  const selectedPool = useMemo(() => {
    return (
      pools.find((pool) => pool.coinAType === fromType && pool.coinBType === toType) ??
      pools.find((pool) => pool.coinAType === toType && pool.coinBType === fromType) ??
      null
    )
  }, [fromType, pools, toType])

  const quote = useMemo((): SwapQuote | null => {
    if (!selectedPool || !fromType || !toType || !amountIn || fromType === toType) {
      return null
    }

    const fromCoin = COIN_BY_TYPE[fromType]
    const toCoin = COIN_BY_TYPE[toType]
    if (!fromCoin || !toCoin) return null

    try {
      const amountInRaw = parseAmountToBaseUnits(amountIn, fromCoin.decimals)
      if (amountInRaw <= 0n) return null

      const aToB = selectedPool.coinAType === fromType
      const reserveInRaw = aToB ? selectedPool.reserveARaw : selectedPool.reserveBRaw
      const reserveOutRaw = aToB ? selectedPool.reserveBRaw : selectedPool.reserveARaw
      if (reserveInRaw <= 0n || reserveOutRaw <= 0n) return null

      const amountInWithFee = amountInRaw * 997n
      const numerator = amountInWithFee * reserveOutRaw
      const denominator = reserveInRaw * 1000n + amountInWithFee
      const amountOutRaw = numerator / denominator

      const slippageValue = Number(slippage)
      const bps = Number.isFinite(slippageValue) && slippageValue >= 0 ? Math.floor(slippageValue * 100) : 0
      const minOutRaw = (amountOutRaw * BigInt(10000 - Math.min(bps, 9900))) / 10000n

      return {
        amountInRaw,
        amountOutRaw,
        minOutRaw,
        reserveInRaw,
        reserveOutRaw,
        aToB,
      }
    } catch {
      return null
    }
  }, [amountIn, fromType, selectedPool, slippage, toType])

  useEffect(() => {
    const readOnchainPrice = async () => {
      try {
        if (!selectedPool || !account?.address) {
          setOnchainPriceRaw(null)
          return
        }

        const tx = new Transaction()
        tx.moveCall({
          target: `${PACKAGE_ID}::pool::get_price`,
          typeArguments: [selectedPool.coinAType, selectedPool.coinBType],
          arguments: [tx.object(selectedPool.id)],
        })

        const result = await client.devInspectTransactionBlock({
          sender: account.address,
          transactionBlock: tx,
        })

        const bytes = result.results?.[0]?.returnValues?.[0]?.[0]
        if (!bytes) {
          setOnchainPriceRaw(null)
          return
        }

        setOnchainPriceRaw(parseU64LE(new Uint8Array(bytes)))
      } catch {
        setOnchainPriceRaw(null)
      }
    }

    void readOnchainPrice()
  }, [account?.address, client, selectedPool])

  const fromCoin = COIN_BY_TYPE[fromType]
  const toCoin = COIN_BY_TYPE[toType]

  const derivedPrice = useMemo(() => {
    if (!quote || !fromCoin || !toCoin) return null
    const inValue = toDecimalNumber(quote.reserveInRaw, fromCoin.decimals)
    const outValue = toDecimalNumber(quote.reserveOutRaw, toCoin.decimals)
    if (inValue <= 0) return null
    return outValue / inValue
  }, [fromCoin, quote, toCoin])

  const onSwap = async (event: React.FormEvent) => {
    event.preventDefault()

    try {
      if (!account?.address) {
        throw new Error('Connect wallet first.')
      }
      if (!selectedPool || !quote || !fromCoin || !toCoin) {
        throw new Error('Select a valid pool pair and amount.')
      }

      const coinObjects =
        fromType === SUI_COIN_TYPE
          ? []
          : await getAllCoinsByType(client, account.address, fromType)

      const tx = new Transaction()
      const coinIn = buildCoinInput(tx, fromType, quote.amountInRaw, coinObjects)

      const target = quote.aToB
        ? `${PACKAGE_ID}::swap::swap_a_for_b`
        : `${PACKAGE_ID}::swap::swap_b_for_a`

      const coinOut = tx.moveCall({
        target,
        typeArguments: [selectedPool.coinAType, selectedPool.coinBType],
        arguments: [tx.object(selectedPool.id), coinIn, tx.pure.u64(quote.minOutRaw)],
      })

      tx.transferObjects([coinOut], tx.pure.address(account.address))

      setSubmitting(true)
      setFeedback('')
      setTxDigest('')

      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      setFeedback('Swap executed successfully.')
      setTxDigest(result.digest)
      setAmountIn('')
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Swap failed.')
    } finally {
      setSubmitting(false)
    }
  }

  const onFlip = () => {
    setFromType(toType)
    setToType(fromType)
  }

  if (loading) {
    return <section className="content-section"><p className="status-line">Loading swap pools...</p></section>
  }

  return (
    <section className="content-section swap-page">
      <h2>Swap</h2>
      <p className="section-copy">AMM swap uses available AquaDex pools only.</p>
      {error ? <p className="status-line">{error}</p> : null}

      <form className="swap-card" onSubmit={onSwap}>
        <div className="swap-token-row">
          <label>From</label>
          <select value={fromType} onChange={(e) => setFromType(e.target.value)}>
            {availableCoinTypes.map((type) => {
              const coin = COIN_BY_TYPE[type]
              const label = coin?.symbol ?? shortTypeName(type)
              return <option key={type} value={type}>{label}</option>
            })}
          </select>
        </div>

        <div className="swap-amount-row">
          <input
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
            placeholder={`Amount ${fromCoin?.symbol ?? ''}`}
            inputMode="decimal"
          />
          <span className="wallet-balance-pill">
            <span className="wallet-glyph" />
            {fromCoin
              ? `${formatBalance(balances[fromType] ?? '0', fromCoin.decimals)} ${fromCoin.symbol}`
              : '0'}
          </span>
        </div>

        <button type="button" className="swap-flip" onClick={onFlip}>⇅</button>

        <div className="swap-token-row">
          <label>To</label>
          <select value={toType} onChange={(e) => setToType(e.target.value)}>
            {availableCoinTypes.map((type) => {
              const coin = COIN_BY_TYPE[type]
              const label = coin?.symbol ?? shortTypeName(type)
              return <option key={type} value={type}>{label}</option>
            })}
          </select>
        </div>

        <div className="swap-out-row">
          <p>Estimated Output</p>
          <strong>
            {quote && toCoin ? `${formatBaseUnits(quote.amountOutRaw, toCoin.decimals, 6)} ${toCoin.symbol}` : '-'}
          </strong>
        </div>

        <div className="swap-meta-grid">
          <label>
            Slippage %
            <input value={slippage} onChange={(e) => setSlippage(e.target.value)} inputMode="decimal" />
          </label>
          <div className="swap-meta-box">
            <p>Min Received</p>
            <strong>
              {quote && toCoin ? `${formatBaseUnits(quote.minOutRaw, toCoin.decimals, 6)} ${toCoin.symbol}` : '-'}
            </strong>
          </div>
        </div>

        <div className="swap-prices">
          <p>
            Derived price:{' '}
            {derivedPrice && fromCoin && toCoin
              ? `1 ${fromCoin.symbol} ≈ ${derivedPrice.toFixed(8)} ${toCoin.symbol}`
              : '-'}
          </p>
          <p>
            pool::get_price (A/B raw): {onchainPriceRaw !== null ? onchainPriceRaw.toString() : '-'}
          </p>
          {selectedPool ? (
            <a className="status-link" href={suiscObjectUrl(selectedPool.id)} target="_blank" rel="noreferrer">
              Selected Pool: {selectedPool.id.slice(0, 12)}...
            </a>
          ) : (
            <p className="status-line">No pool found for selected pair.</p>
          )}
        </div>

        <button
          className="btn btn-primary full-width-btn"
          type="submit"
          disabled={submitting || !selectedPool || !quote || fromType === toType}
        >
          {submitting ? 'Swapping...' : 'Swap'}
        </button>
      </form>

      {feedback ? <p className="status-line">{feedback}</p> : null}
      {txDigest ? (
        <a className="status-link" href={suiscTxUrl(txDigest)} target="_blank" rel="noreferrer">
          View transaction on SuiScan
        </a>
      ) : null}
    </section>
  )
}
