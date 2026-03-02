import { useSuiClient } from '@mysten/dapp-kit'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { COIN_BY_TYPE, type CoinInfo } from '../constants/coins'
import { PACKAGE_ID } from '../constants/sui'
import { formatBaseUnits, formatCompactNumber, toDecimalNumber } from '../utils/amounts'
import { extractBalanceValue, extractPoolTypes, shortTypeName } from '../utils/pools'

type PoolObject = {
  id: string
  type?: string
  reserveARaw: bigint
  reserveBRaw: bigint
}

type PoolRow = {
  poolId: string
  coinA: CoinInfo | null
  coinB: CoinInfo | null
  coinAType: string
  coinBType: string
  reserveARaw: bigint
  reserveBRaw: bigint
  volume24h: number
  volumeAll: number
}

const POOL_CREATED_EVENT = `${PACKAGE_ID}::events::PoolCreatedEvent`
const SWAP_EVENT = `${PACKAGE_ID}::events::SwapEvent`

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

function parsePoolObjects(
  rawObjects: Array<{
    data?:
      | {
          objectId?: string | null
          type?: string | null
          content?: unknown
        }
      | null
  }>,
) {
  const pools: PoolObject[] = []

  for (const object of rawObjects) {
    const id = object.data?.objectId
    if (!id) continue

    const content = object.data?.content as
      | {
          fields?: Record<string, unknown>
        }
      | undefined

    const reserveARaw = extractBalanceValue(content?.fields?.reserve_a)
    const reserveBRaw = extractBalanceValue(content?.fields?.reserve_b)

    pools.push({
      id,
      type: object.data?.type ?? undefined,
      reserveARaw,
      reserveBRaw,
    })
  }

  return pools
}

export function PoolsPage() {
  const client = useSuiClient()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<PoolRow[]>([])

  useEffect(() => {
    const loadPools = async () => {
      try {
        setLoading(true)
        setError('')

        const [createdEvents, swapEvents] = await Promise.all([
          fetchEventsByType(client, POOL_CREATED_EVENT),
          fetchEventsByType(client, SWAP_EVENT),
        ])

        const poolIds = createdEvents
          .map((event) => {
            const parsed = event.parsedJson as { pool_id?: string }
            return parsed.pool_id
          })
          .filter((poolId): poolId is string => Boolean(poolId))

        const uniquePoolIds = Array.from(new Set(poolIds))

        if (uniquePoolIds.length === 0) {
          setRows([])
          return
        }

        const objects = await client.multiGetObjects({
          ids: uniquePoolIds,
          options: { showType: true, showContent: true },
        })

        const parsedPools = parsePoolObjects(objects)

        const volume24hByPool: Record<string, number> = {}
        const volumeAllByPool: Record<string, number> = {}
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000

        const typesByPoolId: Record<string, { coinAType: string; coinBType: string } | null> = {}
        for (const pool of parsedPools) {
          typesByPoolId[pool.id] = extractPoolTypes(pool.type)
        }

        for (const event of swapEvents) {
          const parsed = event.parsedJson as
            | {
                pool_id?: string
                amount_in?: string | number
                a_to_b?: boolean
              }
            | undefined

          const poolId = parsed?.pool_id
          if (!poolId) continue

          const typeInfo = typesByPoolId[poolId]
          if (!typeInfo) continue

          const inputCoinType = parsed.a_to_b ? typeInfo.coinAType : typeInfo.coinBType
          const inputCoin = COIN_BY_TYPE[inputCoinType]
          if (!inputCoin) continue

          const amountInRaw = BigInt(String(parsed.amount_in ?? '0'))
          const amountIn = toDecimalNumber(amountInRaw, inputCoin.decimals)

          volumeAllByPool[poolId] = (volumeAllByPool[poolId] ?? 0) + amountIn

          const ts = event.timestampMs ? Number(event.timestampMs) : 0
          if (ts >= dayAgo) {
            volume24hByPool[poolId] = (volume24hByPool[poolId] ?? 0) + amountIn
          }
        }

        const poolRows: PoolRow[] = parsedPools.map((pool) => {
          const parsedTypes = extractPoolTypes(pool.type)
          const coinAType = parsedTypes?.coinAType ?? 'UnknownA'
          const coinBType = parsedTypes?.coinBType ?? 'UnknownB'

          return {
            poolId: pool.id,
            coinA: COIN_BY_TYPE[coinAType] ?? null,
            coinB: COIN_BY_TYPE[coinBType] ?? null,
            coinAType,
            coinBType,
            reserveARaw: pool.reserveARaw,
            reserveBRaw: pool.reserveBRaw,
            volume24h: volume24hByPool[pool.id] ?? 0,
            volumeAll: volumeAllByPool[pool.id] ?? 0,
          }
        })

        setRows(poolRows)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load pools.')
      } finally {
        setLoading(false)
      }
    }

    void loadPools()
  }, [client])

  const stats = useMemo(() => {
    const totalPools = rows.length
    const totalVolume24h = rows.reduce((acc, row) => acc + row.volume24h, 0)
    const totalVolumeAll = rows.reduce((acc, row) => acc + row.volumeAll, 0)

    const totalReserveUnits = rows.reduce((acc, row) => {
      const a = row.coinA ? toDecimalNumber(row.reserveARaw, row.coinA.decimals) : 0
      const b = row.coinB ? toDecimalNumber(row.reserveBRaw, row.coinB.decimals) : 0
      return acc + a + b
    }, 0)

    return {
      totalPools,
      totalVolume24h,
      totalVolumeAll,
      totalReserveUnits,
    }
  }, [rows])

  return (
    <section className="content-section pools-dashboard">
      <h2>Liquidity Pools</h2>
      <p className="section-copy">On-chain pools with decimal-correct liquidity and volume stats.</p>

      <div className="pool-stats-grid">
        <article className="pool-stat-card">
          <p>Active Pools</p>
          <strong>{stats.totalPools}</strong>
        </article>
        <article className="pool-stat-card">
          <p>Combined Liquidity (token units)</p>
          <strong>{formatCompactNumber(stats.totalReserveUnits)}</strong>
        </article>
        <article className="pool-stat-card">
          <p>Trading Volume (24H)</p>
          <strong>{formatCompactNumber(stats.totalVolume24h)}</strong>
        </article>
        <article className="pool-stat-card">
          <p>Cumulative Volume</p>
          <strong>{formatCompactNumber(stats.totalVolumeAll)}</strong>
        </article>
      </div>

      {loading ? <p className="status-line">Loading pools...</p> : null}
      {error ? <p className="status-line">{error}</p> : null}

      {!loading && !error && rows.length === 0 ? <p className="status-line">No pools found yet.</p> : null}

      {!loading && !error && rows.length > 0 ? (
        <div className="pools-table-wrap">
          <table className="pools-table">
            <thead>
              <tr>
                <th>Pools</th>
                <th>Liquidity</th>
                <th>Volume (24H)</th>
                <th>Manage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const coinALabel = row.coinA?.symbol ?? shortTypeName(row.coinAType)
                const coinBLabel = row.coinB?.symbol ?? shortTypeName(row.coinBType)

                const reserveA = row.coinA ? formatBaseUnits(row.reserveARaw, row.coinA.decimals, 4) : '-'
                const reserveB = row.coinB ? formatBaseUnits(row.reserveBRaw, row.coinB.decimals, 4) : '-'

                return (
                  <tr key={row.poolId}>
                    <td>
                      <Link to={`/pools/${row.poolId}`} className="pool-pair pool-link">
                        <div className="pair-logos">
                          {row.coinA?.logoUrl ? (
                            <img src={row.coinA.logoUrl} alt={`${coinALabel} logo`} className="pair-logo pair-logo-a" />
                          ) : (
                            <span className="pair-fallback pair-logo-a">{coinALabel.slice(0, 1)}</span>
                          )}
                          {row.coinB?.logoUrl ? (
                            <img src={row.coinB.logoUrl} alt={`${coinBLabel} logo`} className="pair-logo pair-logo-b" />
                          ) : (
                            <span className="pair-fallback pair-logo-b">{coinBLabel.slice(0, 1)}</span>
                          )}
                        </div>
                        <div>
                          <strong>
                            {coinALabel} / {coinBLabel}
                          </strong>
                          <span className="pool-id-link">Open pool details</span>
                        </div>
                      </Link>
                    </td>
                    <td>
                      {reserveA} {coinALabel} + {reserveB} {coinBLabel}
                    </td>
                    <td>{row.volume24h.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                    <td>
                      <Link to={`/pools/${row.poolId}`} className="manage-btn">
                        Manage
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
