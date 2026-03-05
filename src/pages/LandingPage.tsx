import { useSuiClient } from '@mysten/dapp-kit'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { COIN_BY_TYPE } from '../constants/coins'
import { PACKAGE_ID, SUISCAN_BASE, suiscObjectUrl } from '../constants/sui'
import { extractBalanceValue, extractPoolTypes } from '../utils/pools'
import { formatCompactNumber, toDecimalNumber } from '../utils/amounts'

type HomeStats = {
  pools: number
  combinedLiquidity: number
  volume24h: number
  cumulativeVolume: number
  swaps: number
}

const POOL_CREATED_EVENT = `${PACKAGE_ID}::events::PoolCreatedEvent`
const SWAP_EVENT = `${PACKAGE_ID}::events::SwapEvent`

async function fetchEventsByType(client: ReturnType<typeof useSuiClient>, moveEventType: string) {
  const events: Array<{ parsedJson?: unknown; timestampMs?: string | null }> = []
  let cursor: { txDigest: string; eventSeq: string } | null = null

  for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
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

export function LandingPage() {
  const client = useSuiClient()
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<HomeStats>({
    pools: 0,
    combinedLiquidity: 0,
    volume24h: 0,
    cumulativeVolume: 0,
    swaps: 0,
  })

  useEffect(() => {
    const loadStats = async () => {
      try {
        setLoading(true)

        const [poolEvents, swapEvents] = await Promise.all([
          fetchEventsByType(client, POOL_CREATED_EVENT),
          fetchEventsByType(client, SWAP_EVENT),
        ])

        const poolIds = Array.from(
          new Set(
            poolEvents
              .map((event) => (event.parsedJson as { pool_id?: string })?.pool_id)
              .filter((id): id is string => Boolean(id)),
          ),
        )

        let combinedLiquidity = 0
        const typeByPoolId: Record<string, { coinAType: string; coinBType: string } | null> = {}

        if (poolIds.length > 0) {
          const poolObjects = await client.multiGetObjects({
            ids: poolIds,
            options: { showType: true, showContent: true },
          })

          for (const object of poolObjects) {
            const objectId = object.data?.objectId
            if (!objectId) continue

            const parsed = extractPoolTypes(object.data?.type)
            typeByPoolId[objectId] = parsed

            const fields = (object.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields
            const reserveARaw = extractBalanceValue(fields?.reserve_a)
            const reserveBRaw = extractBalanceValue(fields?.reserve_b)

            const coinA = parsed ? COIN_BY_TYPE[parsed.coinAType] : null
            const coinB = parsed ? COIN_BY_TYPE[parsed.coinBType] : null

            const reserveA = coinA ? toDecimalNumber(reserveARaw, coinA.decimals) : 0
            const reserveB = coinB ? toDecimalNumber(reserveBRaw, coinB.decimals) : 0
            combinedLiquidity += reserveA + reserveB
          }
        }

        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
        let volume24h = 0
        let cumulativeVolume = 0

        for (const event of swapEvents) {
          const parsed = event.parsedJson as
            | { pool_id?: string; amount_in?: string | number; a_to_b?: boolean }
            | undefined

          const poolId = parsed?.pool_id
          if (!poolId) continue

          const typeInfo = typeByPoolId[poolId]
          if (!typeInfo) continue

          const inputCoinType = parsed.a_to_b ? typeInfo.coinAType : typeInfo.coinBType
          const inputCoin = COIN_BY_TYPE[inputCoinType]
          if (!inputCoin) continue

          const amountIn = toDecimalNumber(BigInt(String(parsed.amount_in ?? '0')), inputCoin.decimals)
          cumulativeVolume += amountIn

          const ts = event.timestampMs ? Number(event.timestampMs) : 0
          if (ts >= oneDayAgo) {
            volume24h += amountIn
          }
        }

        setStats({
          pools: poolIds.length,
          combinedLiquidity,
          volume24h,
          cumulativeVolume,
          swaps: swapEvents.length,
        })
      } finally {
        setLoading(false)
      }
    }

    void loadStats()
  }, [client])

  const statsText = useMemo(
    () => ({
      pools: loading ? '...' : stats.pools.toString(),
      combined: loading ? '...' : formatCompactNumber(stats.combinedLiquidity),
      day: loading ? '...' : formatCompactNumber(stats.volume24h),
      cumulative: loading ? '...' : formatCompactNumber(stats.cumulativeVolume),
      swaps: loading ? '...' : formatCompactNumber(stats.swaps),
    }),
    [loading, stats],
  )

  return (
    <div className="landing-page">
      <section className="home-hero">
        <div className="hero-wave-lines" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="ocean-waves" aria-hidden>
          <span className="ow one" />
          <span className="ow two" />
          <span className="ow three" />
        </div>

        <p className="eyebrow">Built On Sui Testnet</p>
        <h1>AquaDex, where Deep On-Chain Liquidity Flows.</h1>
        <p className="hero-copy">
          Swap, provide liquidity, and launch permissionless pools with a professional AMM
          experience engineered for the Sui ecosystem.
        </p>

        <div className="hero-actions">
          <Link className="btn btn-primary shine-btn" to="/swap">
            Access App
          </Link>
        </div>

        <div className="hero-glass-stats">
          <article>
            <strong>{statsText.pools}</strong>
            <span>Active Pools</span>
          </article>
          <article>
            <strong>{statsText.combined}</strong>
            <span>Combined Liquidity</span>
          </article>
          <article>
            <strong>{statsText.day}</strong>
            <span>24H Volume</span>
          </article>
        </div>
      </section>

      <section className="landing-block">
        <p className="landing-kicker">Vision</p>
        <h2>Trade, Build, and Earn in a Unified Aqua Liquidity Layer</h2>
        <p className="section-copy">
          AquaDex combines AMM swaps, pool creation, and LP position management in one streamlined
          DeFi surface tailored for fast Sui execution.
        </p>

        <div className="home-stat-grid">
          <article>
            <strong>{statsText.cumulative}</strong>
            <span>Cumulative Volume</span>
          </article>
          <article>
            <strong>{statsText.swaps}</strong>
            <span>Total On-Chain Swap Events</span>
          </article>
          <article>
            <strong>{statsText.pools}</strong>
            <span>Permissionless Pool Pairs</span>
          </article>
        </div>
      </section>

      <section className="landing-block fee-launch-panel">
        <p className="landing-kicker">LP Economics</p>
        <h2>LP-First Fee Design</h2>
        <p className="section-copy">
          This protocol takes <strong>0% reward</strong> for your LP. LPs get <strong>0.3% fee</strong>.
        </p>

        <div className="fee-scoreboard">
          <article>
            <span>Protocol Reward</span>
            <strong>0%</strong>
          </article>
          <article>
            <span>LP Fee Share</span>
            <strong>0.3%</strong>
          </article>
        </div>

        <div className="launch-strip">
          <p className="launch-title">We are launching AquaLend and AquaDex CLMM</p>
          <div className="launch-logos">
            <article className="launch-logo-card">
              <div className="launch-logo aqua">
                <img src="/aquadex-logo.png" alt="AquaDex" />
              </div>
              <strong>AquaDex</strong>
            </article>
            <article className="launch-logo-card">
              <div className="launch-logo lend" aria-hidden>
                <svg viewBox="0 0 48 48">
                  <circle cx="24" cy="24" r="21" fill="#12353a" />
                  <path d="M24 9C17 16 14 22 14 27.8C14 33.4 18.6 38 24 38C29.4 38 34 33.4 34 27.8C34 22 31 16 24 9Z" fill="#58ebda" />
                  <path d="M17.3 28.4H30.7" stroke="#082328" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
              </div>
              <strong>AquaLend</strong>
            </article>
            <article className="launch-logo-card">
              <div className="launch-logo clmm" aria-hidden>
                <svg viewBox="0 0 48 48">
                  <rect x="4" y="4" width="40" height="40" rx="12" fill="#102730" />
                  <rect x="12" y="15" width="6" height="18" rx="3" fill="#8cefe5" />
                  <rect x="21" y="11" width="6" height="26" rx="3" fill="#48dacb" />
                  <rect x="30" y="19" width="6" height="14" rx="3" fill="#2fb7e6" />
                </svg>
              </div>
              <strong>AquaDex CLMM</strong>
            </article>
          </div>
        </div>
      </section>

      <section className="landing-block aqua-coin-panel">
        <div className="aqua-coin-copy">
          <p className="landing-kicker">LP Rewards</p>
          <h2>AQUA Coin Is Launching for Liquidity Providers</h2>
          <p className="section-copy">
            Aqua coin emissions will reward long-term LPs based on active contribution, fee
            generation, and sustainable depth support across core pools.
          </p>
          <ul className="aqua-list">
            <li>Boosted rewards on strategic base pairs.</li>
            <li>Reward multiplier for stable liquidity provision.</li>
            <li>Future governance and ecosystem incentive utility.</li>
          </ul>
        </div>
        <div className="aqua-coin-logo-wrap">
          <img
            src="https://res.cloudinary.com/dxflnmfxl/image/upload/v1772266142/Frame_2_nck3gg.png"
            alt="AQUA Coin"
          />
        </div>
      </section>

      <section className="landing-block feature-grid-wrap">
        <p className="landing-kicker">Advantages</p>
        <h2>Optimize Your Trading Experience With AquaDex</h2>
        <div className="feature-grid">
          <article>
            <h3>Permissionless</h3>
            <p>Launch pools instantly with transparent AMM reserves and open participation.</p>
            <Link to="/create-pool">Create your pool</Link>
          </article>
          <article>
            <h3>Secure</h3>
            <p>Move modules are modularized for swaps, pools, liquidity, positions, and events.</p>
            <a href={suiscObjectUrl(PACKAGE_ID)} target="_blank" rel="noreferrer">Audit package on-chain</a>
          </article>
          <article>
            <h3>Sustainable</h3>
            <p>Fee-driven AMM mechanics and LP incentives designed for deep, resilient liquidity.</p>
            <Link to="/pools">View active pairs</Link>
          </article>
        </div>
      </section>

      <section className="contract-panel landing-contract-panel">
        <p>Deployed Package</p>
        <code>{PACKAGE_ID}</code>
        <div className="contract-links">
          <a href={suiscObjectUrl(PACKAGE_ID)} target="_blank" rel="noreferrer">
            <img
              src="https://suiscan.xyz/static/media/SuiFullLogoDark.410a358de5292b64a837b53bba29463f.svg"
              alt="SuiScan"
              className="suiscan-inline"
            />
            <span>View package on SuiScan</span>
          </a>
          <a href={`${SUISCAN_BASE}/tx`} target="_blank" rel="noreferrer">
            <img
              src="https://suiscan.xyz/static/media/SuiFullLogoDark.410a358de5292b64a837b53bba29463f.svg"
              alt="SuiScan"
              className="suiscan-inline"
            />
            <span>Open testnet transactions</span>
          </a>
        </div>
      </section>

      <section className="landing-block creator-panel">
        <p className="landing-kicker">Creator</p>
        <h2>Built by Vinay Reddy</h2>
        <p className="section-copy">
          AquaDex protocol and interface were created and maintained by Vinay Reddy.
        </p>
        <div className="creator-links">
          <a href="https://www.linkedin.com/in/vinay-reddy-a1aa7024b/" target="_blank" rel="noreferrer">
            <img src="https://upload.wikimedia.org/wikipedia/commons/c/ca/LinkedIn_logo_initials.png" alt="LinkedIn" />
            <span>LinkedIn</span>
          </a>
          <a href="https://x.com/VinnuGollakoti" target="_blank" rel="noreferrer">
            <img src="https://cdn.simpleicons.org/x/ffffff" alt="X" />
            <span>X (Twitter)</span>
          </a>
          <a href="https://github.com/vinnugollakoti/AQUADEX.git" target="_blank" rel="noreferrer">
            <img src="https://cdn.simpleicons.org/github/ffffff" alt="GitHub" />
            <span>Smart Contracts Repo</span>
          </a>
          <a href="https://github.com/vinnugollakoti/AQUADEX_FRONTEND.git" target="_blank" rel="noreferrer">
            <img src="https://cdn.simpleicons.org/github/ffffff" alt="GitHub" />
            <span>Frontend Repo</span>
          </a>
        </div>
      </section>
    </div>
  )
}
