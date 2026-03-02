import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit'
import { useEffect, useMemo, useState } from 'react'
import { Transaction } from '@mysten/sui/transactions'
import { COINS, COIN_BY_TYPE, SUI_COIN_TYPE } from '../constants/coins'
import { NETWORK_CHAIN, PACKAGE_ID, suiscTxUrl } from '../constants/sui'
import { formatBalance, parseAmountToBaseUnits } from '../utils/amounts'
import { buildCoinInput, getAllCoinsByType } from '../utils/txCoins'

type BalanceByType = Record<string, string>

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

  const coinA = useMemo(() => COIN_BY_TYPE[coinAType], [coinAType])
  const coinB = useMemo(() => COIN_BY_TYPE[coinBType], [coinBType])

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

      if (!account?.address) {
        throw new Error('Connect wallet first.')
      }
      if (coinAType === coinBType) {
        throw new Error('Coin A and Coin B must be different.')
      }

      const amountABase = parseAmountToBaseUnits(amountA, coinA.decimals)
      const amountBBase = parseAmountToBaseUnits(amountB, coinB.decimals)

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
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to create pool.')
    } finally {
      setIsSubmitting(false)
    }
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
          <p className="balance-text">
            Balance: {formatBalance(balances[coinAType] ?? '0', coinA.decimals)} {coinA.symbol}
          </p>
          <input
            value={amountA}
            onChange={(e) => setAmountA(e.target.value)}
            placeholder={`Amount in ${coinA.symbol}`}
            inputMode="decimal"
          />
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
          <p className="balance-text">
            Balance: {formatBalance(balances[coinBType] ?? '0', coinB.decimals)} {coinB.symbol}
          </p>
          <input
            value={amountB}
            onChange={(e) => setAmountB(e.target.value)}
            placeholder={`Amount in ${coinB.symbol}`}
            inputMode="decimal"
          />
        </div>

        <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
          {isSubmitting ? 'Creating Pool...' : 'Create Pool'}
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
