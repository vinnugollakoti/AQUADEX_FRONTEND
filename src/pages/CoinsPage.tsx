import { COINS } from '../constants/coins'

export function CoinsPage() {
  return (
    <section className="content-section">
      <h2>Coin Dictionary</h2>
      <p className="section-copy">
        Central coin metadata used across Create Pool, Pools, and Swap pages.
      </p>

      <div className="table-wrap">
        <table className="coin-table">
          <thead>
            <tr>
              <th>Coin</th>
              <th>Coin Type</th>
              <th>Decimals</th>
            </tr>
          </thead>
          <tbody>
            {COINS.map((coin) => (
              <tr key={coin.coinType}>
                <td>
                  <div className="coin-cell">
                    <img src={coin.logoUrl} alt={`${coin.symbol} logo`} />
                    <div>
                      <strong>{coin.symbol}</strong>
                      <span>{coin.name}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <code>{coin.coinType}</code>
                </td>
                <td>{coin.decimals}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
