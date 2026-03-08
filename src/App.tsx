import { Navigate, Route, Routes } from 'react-router-dom'
import { Navbar } from './components/Navbar'
import { LandingPage } from './pages/LandingPage'
import { CoinsPage } from './pages/CoinsPage'
import { CreatePoolPage } from './pages/CreatePoolPage'
import { PoolsPage } from './pages/PoolsPage'
import { PoolDetailPage } from './pages/PoolDetailPage'
import { SwapPage } from './pages/SwapPage'
import { SimplePage } from './pages/SimplePage'
import { AquaLendPage } from './pages/AquaLendPage'
import './App.css'

function App() {
  return (
    <div className="site-shell">
      <div className="bg-layers" aria-hidden>
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="orb orb-c" />
        <div className="wave wave-a" />
        <div className="wave wave-b" />
      </div>

      <Navbar />

      <main>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/swap" element={<SwapPage />} />
          <Route path="/aqualend" element={<AquaLendPage />} />
          <Route path="/pools" element={<PoolsPage />} />
          <Route path="/pools/:poolId" element={<PoolDetailPage />} />
          <Route path="/create-pool" element={<CreatePoolPage />} />
          <Route path="/coins" element={<CoinsPage />} />
          <Route
            path="/about"
            element={
              <SimplePage
                title="About AquaDex"
                description="AquaDex is an AMM DEX on Sui testnet focused on permissionless pools and transparent liquidity."
              />
            }
          />
          <Route
            path="/contact"
            element={
              <SimplePage
                title="Contact"
                description="For partnerships and support: aquadex@protocol.test"
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
