import { ConnectModal, useAccounts, useCurrentAccount, useDisconnectWallet, useSwitchAccount } from '@mysten/dapp-kit'
import { useEffect, useRef, useState } from 'react'
import { truncateAddress } from '../utils/amounts'

export function WalletMenu() {
  const account = useCurrentAccount()
  const accounts = useAccounts()
  const disconnectWallet = useDisconnectWallet()
  const switchAccount = useSwitchAccount()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  if (!account) {
    return (
      <ConnectModal
        trigger={
          <button type="button" className="wallet-btn themed-wallet-btn">
            Connect Wallet
          </button>
        }
      />
    )
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(account.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="wallet-menu" ref={menuRef}>
      <button
        type="button"
        className="wallet-btn themed-wallet-btn connected-wallet-btn"
        onClick={() => setOpen((prev) => !prev)}
      >
        {truncateAddress(account.address, 6)}
      </button>

      {open ? (
        <div className="wallet-dropdown">
          <button type="button" onClick={() => void onCopy()}>
            {copied ? 'Copied' : 'Copy Address'}
          </button>

          {accounts.length > 1 ? (
            <div className="wallet-dropdown-group">
              {accounts.map((item) => (
                <button
                  key={item.address}
                  type="button"
                  onClick={() => {
                    switchAccount.mutate({ account: item })
                    setOpen(false)
                  }}
                  disabled={item.address === account.address}
                >
                  Use {truncateAddress(item.address, 6)}
                </button>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => {
              disconnectWallet.mutate()
              setOpen(false)
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  )
}
