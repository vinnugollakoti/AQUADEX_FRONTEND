import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'
import { Transaction } from '@mysten/sui/transactions'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { COIN_BY_TYPE, type CoinInfo, SUI_COIN_TYPE } from '../constants/coins'
import { NETWORK_CHAIN, PACKAGE_ID, suiscObjectUrl, suiscTxUrl } from '../constants/sui'
import {
  formatBaseUnits,
  formatBalance,
  formatCompactNumber,
  parseAmountToBaseUnits,
  toDecimalNumber,
  truncateAddress,
} from '../utils/amounts'
import { extractBalanceValue, extractPoolTypes, shortTypeName } from '../utils/pools'
import { buildCoinInput, getAllCoinsByType } from '../utils/txCoins'

type PoolState = {
  poolId: string
  coinAType: string
  coinBType: string
  coinA: CoinInfo | null
  coinB: CoinInfo | null
  reserveARaw: bigint
  reserveBRaw: bigint
  totalLiquidityRaw: bigint
}

type BalanceByType = Record<string, string>

type PositionInfo = {
  id: string
  liquidity: bigint
}

type ActivityPoint = {
  label: string
  value: number
  kind: 'add' | 'remove'
}

const ADD_EVENT = `${PACKAGE_ID}::events::AddLiquidityEvent`
const REMOVE_EVENT = `${PACKAGE_ID}::events::RemoveLiquidityEvent`

async function fetchEventsByType(client: ReturnType<typeof useSuiClient>, moveEventType: string) {
  const events: Array<{ parsedJson?: unknown; timestampMs?: string | null }> = []
  let cursor: { txDigest: string; eventSeq: string } | null = null

  for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
    const page = await client.queryEvents({
      query: { MoveEventType: moveEventType },
      order: 'descending',
      limit: 50,
      cursor,
    })

    events.push(...page.data)

    if (!page.hasNextPage || !page.nextCursor) {
      break
    }

    cursor = page.nextCursor
  }

  return events
}

function dayLabel(tsMs?: string | null): string {
  if (!tsMs) return '-'
  return new Date(Number(tsMs)).toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
  })
}

function fractionOf(value: bigint, mode: 'quarter' | 'half' | 'max'): bigint {
  if (mode === 'max') return value
  if (mode === 'half') return value / 2n
  return value / 4n
}

export function PoolDetailPage() {
  const { poolId } = useParams()
  const client = useSuiClient()
  const account = useCurrentAccount()
  const signAndExecute = useSignAndExecuteTransaction()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pool, setPool] = useState<PoolState | null>(null)
  const [balances, setBalances] = useState<BalanceByType>({})
  const [positions, setPositions] = useState<PositionInfo[]>([])
  const [activity, setActivity] = useState<ActivityPoint[]>([])

  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [removeAmountA, setRemoveAmountA] = useState('')
  const [removeAmountB, setRemoveAmountB] = useState('')
  const [selectedPositionId, setSelectedPositionId] = useState('')
  const [fullRemoveMode, setFullRemoveMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [txDigest, setTxDigest] = useState('')

  const coinA = pool?.coinA
  const coinB = pool?.coinB

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        setError('')

        if (!poolId) {
          throw new Error('Missing pool id.')
        }

        const objectResponse = await client.getObject({
          id: poolId,
          options: { showType: true, showContent: true },
        })

        if (!objectResponse.data) {
          throw new Error('Pool object not found.')
        }

        const parsedTypes = extractPoolTypes(objectResponse.data.type)
        if (!parsedTypes) {
          throw new Error('Failed to parse pool coin types.')
        }

        const content = objectResponse.data.content as
          | {
              fields?: Record<string, unknown>
            }
          | undefined

        const reserveARaw = extractBalanceValue(content?.fields?.reserve_a)
        const reserveBRaw = extractBalanceValue(content?.fields?.reserve_b)
        const totalLiquidityRaw = BigInt(String(content?.fields?.total_liquidity ?? '0'))

        const nextPool: PoolState = {
          poolId,
          coinAType: parsedTypes.coinAType,
          coinBType: parsedTypes.coinBType,
          coinA: COIN_BY_TYPE[parsedTypes.coinAType] ?? null,
          coinB: COIN_BY_TYPE[parsedTypes.coinBType] ?? null,
          reserveARaw,
          reserveBRaw,
          totalLiquidityRaw,
        }

        setPool(nextPool)

        if (account?.address) {
          const [balanceA, balanceB] = await Promise.all([
            client.getBalance({ owner: account.address, coinType: nextPool.coinAType }),
            client.getBalance({ owner: account.address, coinType: nextPool.coinBType }),
          ])

          setBalances({
            [nextPool.coinAType]: balanceA.totalBalance,
            [nextPool.coinBType]: balanceB.totalBalance,
          })

          const ownedPositions = await client.getOwnedObjects({
            owner: account.address,
            filter: { StructType: `${PACKAGE_ID}::position::LPPosition` },
            options: { showContent: true },
          })

          const filtered = ownedPositions.data
            .map((item) => {
              const id = item.data?.objectId
              const contentFields = (item.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields
              const positionPoolId = String(contentFields?.pool_id ?? '')
              const liquidity = BigInt(String(contentFields?.liquidity ?? '0'))
              if (!id || positionPoolId !== poolId) return null
              return { id, liquidity }
            })
            .filter((item): item is PositionInfo => Boolean(item))

          setPositions(filtered)
          if (filtered.length > 0) {
            setSelectedPositionId((prev) => prev || filtered[0].id)
          }
        } else {
          setBalances({})
          setPositions([])
          setSelectedPositionId('')
        }

        const [addEvents, removeEvents] = await Promise.all([
          fetchEventsByType(client, ADD_EVENT),
          fetchEventsByType(client, REMOVE_EVENT),
        ])

        const addPoints = addEvents
          .map((event) => {
            const parsed = event.parsedJson as
              | {
                  pool_id?: string
                  amount_a?: string | number
                }
              | undefined

            if (parsed?.pool_id !== poolId) return null

            const amount = BigInt(String(parsed.amount_a ?? '0'))
            const normalized = nextPool.coinA ? toDecimalNumber(amount, nextPool.coinA.decimals) : 0

            return {
              label: dayLabel(event.timestampMs),
              value: normalized,
              kind: 'add' as const,
            }
          })
          .filter(Boolean) as ActivityPoint[]

        const removePoints = removeEvents
          .map((event) => {
            const parsed = event.parsedJson as
              | {
                  pool_id?: string
                  amount_a?: string | number
                }
              | undefined

            if (parsed?.pool_id !== poolId) return null

            const amount = BigInt(String(parsed.amount_a ?? '0'))
            const normalized = nextPool.coinA ? toDecimalNumber(amount, nextPool.coinA.decimals) : 0

            return {
              label: dayLabel(event.timestampMs),
              value: normalized,
              kind: 'remove' as const,
            }
          })
          .filter(Boolean) as ActivityPoint[]

        const timeline: ActivityPoint[] = [...addPoints, ...removePoints].slice(0, 20).reverse()
        setActivity(timeline)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load pool details.')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [account?.address, client, poolId])

  const composition = useMemo(() => {
    if (!pool || !coinA || !coinB) {
      return { aPct: 0, bPct: 0, reserveA: '0', reserveB: '0' }
    }

    const a = toDecimalNumber(pool.reserveARaw, coinA.decimals)
    const b = toDecimalNumber(pool.reserveBRaw, coinB.decimals)
    const total = a + b
    const aPct = total > 0 ? (a / total) * 100 : 0
    const bPct = total > 0 ? (b / total) * 100 : 0

    return {
      aPct,
      bPct,
      reserveA: formatBaseUnits(pool.reserveARaw, coinA.decimals, 6),
      reserveB: formatBaseUnits(pool.reserveBRaw, coinB.decimals, 6),
    }
  }, [coinA, coinB, pool])

  const selectedPosition = useMemo(
    () => positions.find((position) => position.id === selectedPositionId) ?? null,
    [positions, selectedPositionId],
  )

  const removable = useMemo(() => {
    if (!pool || !coinA || !coinB || !selectedPosition || pool.totalLiquidityRaw === 0n) {
      return { amountARaw: 0n, amountBRaw: 0n, amountA: '0', amountB: '0' }
    }

    const amountARaw = (selectedPosition.liquidity * pool.reserveARaw) / pool.totalLiquidityRaw
    const amountBRaw = (selectedPosition.liquidity * pool.reserveBRaw) / pool.totalLiquidityRaw

    return {
      amountARaw,
      amountBRaw,
      amountA: formatBaseUnits(amountARaw, coinA.decimals, 6),
      amountB: formatBaseUnits(amountBRaw, coinB.decimals, 6),
    }
  }, [coinA, coinB, pool, selectedPosition])

  const onAddLiquidity = async (event: React.FormEvent) => {
    event.preventDefault()

    try {
      if (!pool || !account?.address || !coinA || !coinB) {
        throw new Error('Connect wallet and load pool first.')
      }

      const amountARaw = parseAmountToBaseUnits(amountA, coinA.decimals)
      const amountBRaw = parseAmountToBaseUnits(amountB, coinB.decimals)

      const [coinObjectsA, coinObjectsB] = await Promise.all([
        pool.coinAType === SUI_COIN_TYPE
          ? Promise.resolve([])
          : getAllCoinsByType(client, account.address, pool.coinAType),
        pool.coinBType === SUI_COIN_TYPE
          ? Promise.resolve([])
          : getAllCoinsByType(client, account.address, pool.coinBType),
      ])

      const tx = new Transaction()
      const inputA = buildCoinInput(tx, pool.coinAType, amountARaw, coinObjectsA)
      const inputB = buildCoinInput(tx, pool.coinBType, amountBRaw, coinObjectsB)

      const position = tx.moveCall({
        target: `${PACKAGE_ID}::liquidity::add_liquidity`,
        typeArguments: [pool.coinAType, pool.coinBType],
        arguments: [tx.object(pool.poolId), inputA, inputB],
      })

      tx.transferObjects([position], tx.pure.address(account.address))

      setSubmitting(true)
      setFeedback('')
      setTxDigest('')

      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      setFeedback('Liquidity added successfully.')
      setTxDigest(result.digest)
      setAmountA('')
      setAmountB('')
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to add liquidity.')
    } finally {
      setSubmitting(false)
    }
  }

  const autoFillCoinBFromCoinA = (nextAmountA: string) => {
    if (!pool || !coinA || !coinB) return
    if (!nextAmountA.trim()) {
      setAmountB('')
      return
    }
    if (pool.reserveARaw <= 0n || pool.reserveBRaw <= 0n) return
    if (!/^\d*(\.\d*)?$/.test(nextAmountA.trim())) return

    try {
      const amountARaw = parseAmountToBaseUnits(nextAmountA, coinA.decimals)
      const amountBRaw = (amountARaw * pool.reserveBRaw) / pool.reserveARaw
      setAmountB(formatBaseUnits(amountBRaw, coinB.decimals, coinB.decimals))
    } catch {
      // Allow user typing intermediate values without hard errors.
    }
  }

  const autoFillCoinAFromCoinB = (nextAmountB: string) => {
    if (!pool || !coinA || !coinB) return
    if (!nextAmountB.trim()) {
      setAmountA('')
      return
    }
    if (pool.reserveARaw <= 0n || pool.reserveBRaw <= 0n) return
    if (!/^\d*(\.\d*)?$/.test(nextAmountB.trim())) return

    try {
      const amountBRaw = parseAmountToBaseUnits(nextAmountB, coinB.decimals)
      const amountARaw = (amountBRaw * pool.reserveARaw) / pool.reserveBRaw
      setAmountA(formatBaseUnits(amountARaw, coinA.decimals, coinA.decimals))
    } catch {
      // Allow user typing intermediate values without hard errors.
    }
  }

  const onRemoveLiquidity = async (event: React.FormEvent) => {
    event.preventDefault()

    try {
      if (!pool || !account?.address || !selectedPositionId) {
        throw new Error('Select a position first.')
      }

      const tx = new Transaction()

      const removeARaw = fullRemoveMode || !coinA ? 0n : parseAmountToBaseUnits(removeAmountA, coinA.decimals)
      const removeBRaw = fullRemoveMode || !coinB ? 0n : parseAmountToBaseUnits(removeAmountB, coinB.decimals)

      const [balanceA, balanceB, optionPosition] = tx.moveCall({
        target: `${PACKAGE_ID}::liquidity::remove_liquidity`,
        typeArguments: [pool.coinAType, pool.coinBType],
        arguments: [
          tx.object(pool.poolId),
          tx.pure.bool(fullRemoveMode),
          tx.pure.u64(removeARaw),
          tx.pure.u64(removeBRaw),
          tx.object(selectedPositionId),
        ],
      })

      const coinOutA = tx.moveCall({
        target: '0x2::coin::from_balance',
        typeArguments: [pool.coinAType],
        arguments: [balanceA],
      })

      const coinOutB = tx.moveCall({
        target: '0x2::coin::from_balance',
        typeArguments: [pool.coinBType],
        arguments: [balanceB],
      })

      tx.transferObjects([coinOutA, coinOutB], tx.pure.address(account.address))

      if (fullRemoveMode) {
        tx.moveCall({
          target: '0x1::option::destroy_none',
          typeArguments: [`${PACKAGE_ID}::position::LPPosition`],
          arguments: [optionPosition],
        })
      } else {
        const returnedPosition = tx.moveCall({
          target: '0x1::option::destroy_some',
          typeArguments: [`${PACKAGE_ID}::position::LPPosition`],
          arguments: [optionPosition],
        })

        tx.transferObjects([returnedPosition], tx.pure.address(account.address))
      }

      setSubmitting(true)
      setFeedback('')
      setTxDigest('')

      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      setFeedback('Liquidity removed successfully.')
      setTxDigest(result.digest)
      setRemoveAmountA('')
      setRemoveAmountB('')
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to remove liquidity.')
    } finally {
      setSubmitting(false)
    }
  }

  const fillAddAmount = (coin: 'a' | 'b', mode: 'quarter' | 'half' | 'max') => {
    if (!pool || !coinA || !coinB) return
    const coinType = coin === 'a' ? pool.coinAType : pool.coinBType
    const decimals = coin === 'a' ? coinA.decimals : coinB.decimals
    const raw = BigInt(balances[coinType] ?? '0')
    const filled = formatBaseUnits(fractionOf(raw, mode), decimals, decimals)
    if (coin === 'a') {
      setAmountA(filled)
      autoFillCoinBFromCoinA(filled)
    } else {
      setAmountB(filled)
      autoFillCoinAFromCoinB(filled)
    }
  }

  const fillRemoveAmount = (coin: 'a' | 'b', mode: 'quarter' | 'half' | 'max') => {
    if (!coinA || !coinB) return
    const raw = coin === 'a' ? removable.amountARaw : removable.amountBRaw
    const decimals = coin === 'a' ? coinA.decimals : coinB.decimals
    const filled = formatBaseUnits(fractionOf(raw, mode), decimals, decimals)
    if (coin === 'a') setRemoveAmountA(filled)
    else setRemoveAmountB(filled)
  }

  if (loading) {
    return <section className="content-section"><p className="status-line">Loading pool details...</p></section>
  }

  if (error || !pool) {
    return (
      <section className="content-section">
        <p className="status-line">{error || 'Pool not found.'}</p>
        <Link to="/pools" className="status-link">Back to Pools</Link>
      </section>
    )
  }

  const coinALabel = coinA?.symbol ?? shortTypeName(pool.coinAType)
  const coinBLabel = coinB?.symbol ?? shortTypeName(pool.coinBType)

  const maxBar = Math.max(...activity.map((item) => item.value), 1)

  return (
    <section className="content-section pool-detail-page">
      <div className="pool-detail-header">
        <div>
          <p className="detail-sub">Pool Details</p>
          <h2>{coinALabel} / {coinBLabel}</h2>
          <p className="section-copy">
            Pool ID:{' '}
            <a href={suiscObjectUrl(pool.poolId)} target="_blank" rel="noreferrer" className="inline-link">
              {truncateAddress(pool.poolId, 10)}
            </a>
          </p>
        </div>
        <a className="status-link" href={suiscObjectUrl(pool.poolId)} target="_blank" rel="noreferrer">
          View object on SuiScan
        </a>
      </div>

      <div className="pool-detail-grid">
        <article className="pool-detail-card">
          <h3>Pool Composition</h3>
          <div className="composition-pair">
            <div className="pair-left">
              {coinA?.logoUrl ? <img src={coinA.logoUrl} alt={`${coinALabel} logo`} /> : null}
              <span>{coinALabel}: {composition.reserveA}</span>
            </div>
            <strong>{composition.aPct.toFixed(2)}%</strong>
          </div>
          <div className="composition-bar">
            <div className="composition-fill coin-a" style={{ width: `${composition.aPct}%` }} />
          </div>
          <div className="composition-pair">
            <div className="pair-left">
              {coinB?.logoUrl ? <img src={coinB.logoUrl} alt={`${coinBLabel} logo`} /> : null}
              <span>{coinBLabel}: {composition.reserveB}</span>
            </div>
            <strong>{composition.bPct.toFixed(2)}%</strong>
          </div>
          <div className="composition-bar">
            <div className="composition-fill coin-b" style={{ width: `${composition.bPct}%` }} />
          </div>
          <p className="section-copy">Total LP minted: {formatCompactNumber(toDecimalNumber(pool.totalLiquidityRaw, 6))}</p>
        </article>

        <article className="pool-detail-card">
          <h3>Liquidity Activity</h3>
          <div className="activity-chart">
            {activity.length === 0 ? <p className="section-copy">No activity yet.</p> : null}
            {activity.map((point, index) => (
              <div key={`${point.label}-${index}`} className="activity-bar-wrap">
                <div
                  className={`activity-bar ${point.kind}`}
                  style={{ height: `${Math.max((point.value / maxBar) * 130, 8)}px` }}
                  title={`${point.kind} ${point.value.toFixed(4)}`}
                />
                <span>{point.label}</span>
              </div>
            ))}
          </div>
        </article>
      </div>

      <div className="liquidity-panels">
        <article className="pool-detail-card">
          <h3>Add Liquidity</h3>
          <form onSubmit={onAddLiquidity} className="inline-form">
            <div className="amount-input-row">
              <input
                value={amountA}
                onChange={(e) => {
                  const nextValue = e.target.value
                  setAmountA(nextValue)
                  autoFillCoinBFromCoinA(nextValue)
                }}
                placeholder={`Amount ${coinALabel}`}
                inputMode="decimal"
              />
              <span className="wallet-balance-pill">
                <span className="wallet-glyph" />
                {formatBalance(balances[pool.coinAType] ?? '0', coinA?.decimals ?? 0)} {coinALabel}
              </span>
            </div>
            <div className="quick-actions">
              <button type="button" onClick={() => { fillAddAmount('a', 'quarter') }}>QUARTER</button>
              <button type="button" onClick={() => { fillAddAmount('a', 'half') }}>HALF</button>
              <button type="button" onClick={() => { fillAddAmount('a', 'max') }}>MAX</button>
            </div>
            <div className="amount-input-row">
              <input
                value={amountB}
                onChange={(e) => {
                  const nextValue = e.target.value
                  setAmountB(nextValue)
                  autoFillCoinAFromCoinB(nextValue)
                }}
                placeholder={`Amount ${coinBLabel}`}
                inputMode="decimal"
              />
              <span className="wallet-balance-pill">
                <span className="wallet-glyph" />
                {formatBalance(balances[pool.coinBType] ?? '0', coinB?.decimals ?? 0)} {coinBLabel}
              </span>
            </div>
            <div className="quick-actions">
              <button type="button" onClick={() => fillAddAmount('b', 'quarter')}>QUARTER</button>
              <button type="button" onClick={() => fillAddAmount('b', 'half')}>HALF</button>
              <button type="button" onClick={() => fillAddAmount('b', 'max')}>MAX</button>
            </div>
            <div className="liquidity-hint">
              <p>
                Pool ratio target: {composition.reserveA} {coinALabel} : {composition.reserveB} {coinBLabel}
              </p>
              <p>Adding liquidity mints/updates your LP position NFT on success.</p>
            </div>
            <button className="btn btn-primary full-width-btn" type="submit" disabled={submitting}>
              {submitting ? 'Processing...' : 'Add Liquidity'}
            </button>
          </form>
        </article>

        <article className="pool-detail-card">
          <div className="remove-header">
            <h3>Remove Liquidity</h3>
          </div>

          {positions.length === 0 ? (
            <p className="section-copy">No positions are available on your connected address for this pool.</p>
          ) : null}

          <form onSubmit={onRemoveLiquidity} className="inline-form remove-form">
            <label>
              Position
              <select value={selectedPositionId} onChange={(e) => setSelectedPositionId(e.target.value)}>
                {positions.length === 0 ? <option value="">No positions found</option> : null}
                {positions.map((position) => (
                  <option key={position.id} value={position.id}>
                    {truncateAddress(position.id, 8)} | LP {position.liquidity.toString()}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className={fullRemoveMode ? 'manage-btn remove-full-btn active' : 'manage-btn remove-full-btn'}
              onClick={() => setFullRemoveMode((prev) => !prev)}
            >
              Remove Full Liquidity
            </button>

            {!fullRemoveMode ? (
              <>
                <div className="amount-input-row">
                  <input
                    value={removeAmountA}
                    onChange={(e) => setRemoveAmountA(e.target.value)}
                    placeholder={`Remove ${coinALabel}`}
                    inputMode="decimal"
                  />
                  <span className="wallet-balance-pill">
                    <span className="wallet-glyph" />
                    Position: {removable.amountA} {coinALabel}
                  </span>
                </div>
                <div className="quick-actions">
                  <button type="button" onClick={() => fillRemoveAmount('a', 'quarter')}>QUARTER</button>
                  <button type="button" onClick={() => fillRemoveAmount('a', 'half')}>HALF</button>
                  <button type="button" onClick={() => fillRemoveAmount('a', 'max')}>MAX</button>
                </div>
                <div className="amount-input-row">
                  <input
                    value={removeAmountB}
                    onChange={(e) => setRemoveAmountB(e.target.value)}
                    placeholder={`Remove ${coinBLabel}`}
                    inputMode="decimal"
                  />
                  <span className="wallet-balance-pill">
                    <span className="wallet-glyph" />
                    Position: {removable.amountB} {coinBLabel}
                  </span>
                </div>
                <div className="quick-actions">
                  <button type="button" onClick={() => fillRemoveAmount('b', 'quarter')}>QUARTER</button>
                  <button type="button" onClick={() => fillRemoveAmount('b', 'half')}>HALF</button>
                  <button type="button" onClick={() => fillRemoveAmount('b', 'max')}>MAX</button>
                </div>
              </>
            ) : (
              <p className="section-copy">
                Full remove will redeem up to {removable.amountA} {coinALabel} and {removable.amountB} {coinBLabel}.
              </p>
            )}

            <button className="btn btn-ghost" type="submit" disabled={submitting || !selectedPositionId}>
              {submitting ? 'Processing...' : 'Confirm Remove'}
            </button>
          </form>
        </article>
      </div>

      {feedback ? <p className="status-line">{feedback}</p> : null}
      {txDigest ? (
        <a className="status-link" href={suiscTxUrl(txDigest)} target="_blank" rel="noreferrer">
          View transaction on SuiScan
        </a>
      ) : null}
    </section>
  )
}
