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
          <svg viewBox="0 0 24 24" className="brand-mark-svg">
            <path
              d="M12 2C9.6 5.8 6 9.3 6 13.8C6 17.2 8.7 20 12 20C15.3 20 18 17.2 18 13.8C18 9.3 14.4 5.8 12 2Z"
              fill="#40c8b8"
            />
            <path
              d="M8.6 12.8C9.6 13.8 10.8 14.3 12 14.3C13.2 14.3 14.4 13.8 15.4 12.8"
              stroke="#08312c"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <path
              d="M9.1 16.1C10 16.6 11 16.9 12 16.9C13 16.9 14 16.6 14.9 16.1"
              stroke="#08312c"
              strokeWidth="1.2"
              strokeLinecap="round"
              opacity="0.85"
            />
          </svg>
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
