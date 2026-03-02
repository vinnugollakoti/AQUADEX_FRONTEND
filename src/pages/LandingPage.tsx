import { Link } from 'react-router-dom'
import { PACKAGE_ID, SUISCAN_BASE, suiscObjectUrl } from '../constants/sui'

export function LandingPage() {
  return (
    <section className="hero">
      <p className="eyebrow">Sui Testnet AMM DEX</p>
      <h1>Deep Liquidity. Smooth Flow. AquaDex.</h1>
      <p className="hero-copy">
        AquaDex is a constant-product AMM on Sui testnet with pool creation,
        liquidity positions, and transparent swaps.
      </p>

      <div className="hero-actions">
        <Link className="btn btn-primary" to="/swap">
          Start Trading
        </Link>
        <Link className="btn btn-ghost" to="/create-pool">
          Create Pool
        </Link>
      </div>

      <div className="contract-panel">
        <p>Deployed Package</p>
        <code>{PACKAGE_ID}</code>
        <div className="contract-links">
          <a href={suiscObjectUrl(PACKAGE_ID)} target="_blank" rel="noreferrer">
            View package on SuiScan
          </a>
          <a href={`${SUISCAN_BASE}/tx`} target="_blank" rel="noreferrer">
            Open testnet transactions
          </a>
        </div>
      </div>
    </section>
  )
}
