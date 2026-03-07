import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'
import { useEffect, useMemo, useState } from 'react'
import { Transaction } from '@mysten/sui/transactions'
import { COINS, COIN_BY_TYPE, SUI_COIN_TYPE } from '../constants/coins'
import { NETWORK_CHAIN, PACKAGE_ID, suiscObjectUrl, suiscTxUrl } from '../constants/sui'
import { formatBalance, formatBaseUnits, parseAmountToBaseUnits } from '../utils/amounts'
import { buildCoinInput, getAllCoinsByType } from '../utils/txCoins'

type BalanceByType = Record<string, string>

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function CreatePoolPage() {
  const client = useSuiClient()
  const account = useCurrentAccount()
  const signAndExecute = useSignAndExecuteTransaction()

  const [coinAType, setCoinAType] = useState(COINS[0].coinType)
  const [coinBType, setCoinBType] = useState(COINS[1].coinType)
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [balances, setBalances] = useState<BalanceByType>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<string>('')
  const [txDigest, setTxDigest] = useState('')
  const [createdPoolId, setCreatedPoolId] = useState('')

  const coinA = useMemo(() => COIN_BY_TYPE[coinAType], [coinAType])
  const coinB = useMemo(() => COIN_BY_TYPE[coinBType], [coinBType])
  const balanceARaw = useMemo(() => BigInt(balances[coinAType] ?? '0'), [balances, coinAType])
  const balanceBRaw = useMemo(() => BigInt(balances[coinBType] ?? '0'), [balances, coinBType])

  const amountARaw = useMemo(() => {
    try {
      return amountA.trim() ? parseAmountToBaseUnits(amountA, coinA.decimals) : null
    } catch {
      return null
    }
  }, [amountA, coinA.decimals])

  const amountBRaw = useMemo(() => {
    try {
      return amountB.trim() ? parseAmountToBaseUnits(amountB, coinB.decimals) : null
    } catch {
      return null
    }
  }, [amountB, coinB.decimals])
  const hasAnyAmount = Boolean(amountA.trim() || amountB.trim())
  const hasBothAmounts = Boolean(amountA.trim() && amountB.trim())

  const addValidation = useMemo(() => {
    if (!account?.address) return hasAnyAmount ? 'Connect wallet first.' : ''
    if (coinAType === coinBType) return 'Coin A and Coin B must be different.'
    if (!amountA.trim() || !amountB.trim()) return hasAnyAmount ? 'Enter both token amounts.' : ''
    if (amountARaw === null || amountBRaw === null) return 'Enter valid token amounts.'
    if (amountARaw <= 0n || amountBRaw <= 0n) return 'Amounts must be greater than zero.'
    if (amountARaw > balanceARaw) return `Insufficient ${coinA.symbol} balance.`
    if (amountBRaw > balanceBRaw) return `Insufficient ${coinB.symbol} balance.`
    return ''
  }, [
    account?.address,
    amountA,
    amountARaw,
    amountB,
    amountBRaw,
    balanceARaw,
    balanceBRaw,
    hasAnyAmount,
    coinA.symbol,
    coinAType,
    coinB.symbol,
    coinBType,
  ])

  useEffect(() => {
    const loadBalances = async () => {
      if (!account?.address) {
        setBalances({})
        return
      }

      const entries = await Promise.all(
        COINS.map(async (coin) => {
          const response = await client.getBalance({
            owner: account.address,
            coinType: coin.coinType,
          })
          return [coin.coinType, response.totalBalance] as const
        }),
      )

      setBalances(Object.fromEntries(entries))
    }

    void loadBalances()
  }, [account?.address, client])

  const onCreatePool = async (event: React.FormEvent) => {
    event.preventDefault()

    try {
      setFeedback('')
      setTxDigest('')
      setCreatedPoolId('')

      if (!account?.address) {
        throw new Error('Connect wallet first.')
      }
      if (coinAType === coinBType) {
        throw new Error('Coin A and Coin B must be different.')
      }
      if (addValidation) {
        throw new Error(addValidation)
      }

      const amountABase = amountARaw as bigint
      const amountBBase = amountBRaw as bigint

      const [coinObjectsA, coinObjectsB] = await Promise.all([
        coinAType === SUI_COIN_TYPE
          ? Promise.resolve([])
          : getAllCoinsByType(client, account.address, coinAType),
        coinBType === SUI_COIN_TYPE
          ? Promise.resolve([])
          : getAllCoinsByType(client, account.address, coinBType),
      ])

      const tx = new Transaction()

      const coinAInput = buildCoinInput(tx, coinAType, amountABase, coinObjectsA)
      const coinBInput = buildCoinInput(tx, coinBType, amountBBase, coinObjectsB)

      const position = tx.moveCall({
        target: `${PACKAGE_ID}::pool::create_pool`,
        typeArguments: [coinAType, coinBType],
        arguments: [coinAInput, coinBInput],
      })

      tx.transferObjects([position], tx.pure.address(account.address))

      setIsSubmitting(true)
      const result = await signAndExecute.mutateAsync({
        transaction: tx,
        chain: NETWORK_CHAIN,
      })

      setTxDigest(result.digest)
      setFeedback('Pool created successfully.')
      setAmountA('')
      setAmountB('')

      const refreshed = await Promise.all(
        COINS.map(async (coin) => {
          const response = await client.getBalance({
            owner: account.address,
            coinType: coin.coinType,
          })
          return [coin.coinType, response.totalBalance] as const
        }),
      )
      setBalances(Object.fromEntries(refreshed))

      let createdEvent:
        | {
            type?: string
            parsedJson?: unknown
          }
        | undefined

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const txResult = await client.getTransactionBlock({
            digest: result.digest,
            options: { showEvents: true },
          })
          createdEvent = txResult.events?.find(
            (evt) => evt.type === `${PACKAGE_ID}::events::PoolCreatedEvent`,
          )
        } catch (txError) {
          const message = txError instanceof Error ? txError.message : String(txError)
          const isLaggingLookup = message.includes('Could not find the referenced transaction')
          if (!isLaggingLookup) break
          await delay(400 * (attempt + 1))
        }
      }

      const poolId = (createdEvent?.parsedJson as { pool_id?: string } | undefined)?.pool_id
      if (poolId) setCreatedPoolId(poolId)
      else {
        setFeedback(
          'Pool created successfully. Pool object link may appear after a short indexer delay.',
        )
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to create pool.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const fillAmount = (coin: 'a' | 'b', mode: 'quarter' | 'half' | 'max') => {
    const coinType = coin === 'a' ? coinAType : coinBType
    const decimals = coin === 'a' ? coinA.decimals : coinB.decimals
    const raw = BigInt(balances[coinType] ?? '0')
    let nextRaw = raw
    if (mode === 'half') nextRaw = raw / 2n
    if (mode === 'quarter') nextRaw = raw / 4n
    const nextAmount = formatBaseUnits(nextRaw, decimals, decimals)
    if (coin === 'a') setAmountA(nextAmount)
    else setAmountB(nextAmount)
  }

  return (
    <section className="content-section">
      <h2>Create Pool</h2>
      <p className="section-copy">
        Calls <code>{PACKAGE_ID}::pool::create_pool</code> and transfers the returned LP
        position to your wallet.
      </p>

      <form className="create-pool-form" onSubmit={onCreatePool}>
        <div className="asset-card">
          <label htmlFor="coin-a">Coin A</label>
          <select id="coin-a" value={coinAType} onChange={(e) => setCoinAType(e.target.value)}>
            {COINS.map((coin) => (
              <option key={coin.coinType} value={coin.coinType}>
                {coin.symbol}
              </option>
            ))}
          </select>
          <div className="selected-coin">
            <img src={coinA.logoUrl} alt={`${coinA.symbol} logo`} />
            <div>
              <strong>{coinA.symbol}</strong>
              <span>{coinA.name}</span>
            </div>
          </div>
          <div className="amount-input-row">
            <input
              value={amountA}
              onChange={(e) => setAmountA(e.target.value)}
              placeholder={`Amount in ${coinA.symbol}`}
              inputMode="decimal"
            />
            <span className="wallet-balance-pill">
              <span className="wallet-glyph" />
              {formatBalance(balances[coinAType] ?? '0', coinA.decimals)} {coinA.symbol}
            </span>
          </div>
          <div className="quick-actions">
            <button type="button" onClick={() => fillAmount('a', 'quarter')}>QUARTER</button>
            <button type="button" onClick={() => fillAmount('a', 'half')}>HALF</button>
            <button type="button" onClick={() => fillAmount('a', 'max')}>MAX</button>
          </div>
        </div>

        <div className="asset-card">
          <label htmlFor="coin-b">Coin B</label>
          <select id="coin-b" value={coinBType} onChange={(e) => setCoinBType(e.target.value)}>
            {COINS.map((coin) => (
              <option key={coin.coinType} value={coin.coinType}>
                {coin.symbol}
              </option>
            ))}
          </select>
          <div className="selected-coin">
            <img src={coinB.logoUrl} alt={`${coinB.symbol} logo`} />
            <div>
              <strong>{coinB.symbol}</strong>
              <span>{coinB.name}</span>
            </div>
          </div>
          <div className="amount-input-row">
            <input
              value={amountB}
              onChange={(e) => setAmountB(e.target.value)}
              placeholder={`Amount in ${coinB.symbol}`}
              inputMode="decimal"
            />
            <span className="wallet-balance-pill">
              <span className="wallet-glyph" />
              {formatBalance(balances[coinBType] ?? '0', coinB.decimals)} {coinB.symbol}
            </span>
          </div>
          <div className="quick-actions">
            <button type="button" onClick={() => fillAmount('b', 'quarter')}>QUARTER</button>
            <button type="button" onClick={() => fillAmount('b', 'half')}>HALF</button>
            <button type="button" onClick={() => fillAmount('b', 'max')}>MAX</button>
          </div>
        </div>

        <div className="create-action-wrap">
          {addValidation ? <p className="validation-line">{addValidation}</p> : null}
          <button
            type="submit"
            className="btn btn-primary full-width-btn create-pool-btn"
            disabled={isSubmitting || !hasBothAmounts || coinAType === coinBType || !account?.address || Boolean(addValidation)}
          >
            {isSubmitting ? 'Creating Pool...' : 'Create Pool'}
          </button>
        </div>
      </form>

      {feedback ? <p className="status-line">{feedback}</p> : null}
      {txDigest ? (
        <a className="status-link" href={suiscTxUrl(txDigest)} target="_blank" rel="noreferrer">
          View transaction on SuiScan
        </a>
      ) : null}
      {createdPoolId ? (
        <a className="pool-suiscan-link" href={suiscObjectUrl(createdPoolId)} target="_blank" rel="noreferrer">
          <img
            src="https://suiscan.xyz/static/media/SuiFullLogoDark.410a358de5292b64a837b53bba29463f.svg"
            alt="SuiScan"
          />
          <span>View your pool on-chain</span>
        </a>
      ) : null}
    </section>
  )
}
