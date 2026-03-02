import { type SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import { Transaction } from '@mysten/sui/transactions'
import { SUI_COIN_TYPE } from '../constants/coins'

export type CoinObject = {
  coinObjectId: string
}

export async function getAllCoinsByType(
  client: SuiJsonRpcClient,
  owner: string,
  coinType: string,
): Promise<CoinObject[]> {
  const output: CoinObject[] = []
  let cursor: string | null | undefined = null

  do {
    const page = await client.getCoins({ owner, coinType, cursor, limit: 50 })
    output.push(...page.data.map((coin) => ({ coinObjectId: coin.coinObjectId })))
    cursor = page.hasNextPage ? page.nextCursor : null
  } while (cursor)

  return output
}

export function buildCoinInput(
  tx: Transaction,
  coinType: string,
  amount: bigint,
  coinObjects: CoinObject[],
) {
  if (coinType === SUI_COIN_TYPE) {
    const [coin] = tx.splitCoins(tx.gas, [amount])
    return coin
  }

  if (coinObjects.length === 0) {
    throw new Error(`No spendable ${coinType} coin objects found in wallet.`)
  }

  const destination = tx.object(coinObjects[0].coinObjectId)
  const mergeSources = coinObjects.slice(1).map((item) => tx.object(item.coinObjectId))

  if (mergeSources.length > 0) {
    tx.mergeCoins(destination, mergeSources)
  }

  const [splitCoin] = tx.splitCoins(destination, [amount])
  return splitCoin
}
