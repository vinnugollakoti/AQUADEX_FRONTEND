import { ConnectButton } from '@mysten/dapp-kit'
import { NavLink } from 'react-router-dom'

const links = [
  { to: '/', label: 'Home' },
  { to: '/swap', label: 'Swap' },
  { to: '/pools', label: 'Pools' },
  { to: '/create-pool', label: 'Create Pool' },
  { to: '/coins', label: 'Coins' },
  { to: '/about', label: 'About' },
  { to: '/contact', label: 'Contact' },
]

export function Navbar() {
  return (
    <header className="top-nav">
      <NavLink className="brand" to="/" aria-label="AquaDex Home">
        <span className="brand-mark" aria-hidden>
          <img src="/aquadex-logo.png" alt="" className="brand-mark-img" />
        </span>
        <span>AquaDex</span>
      </NavLink>

      <nav className="nav-links" aria-label="Primary">
        {links.map((item) => (
          <NavLink
            key={item.label}
            to={item.to}
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <ConnectButton connectText="Connect Wallet" className="wallet-btn" />
    </header>
  )
}
