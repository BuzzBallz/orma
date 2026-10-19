import { createContext, useContext } from 'react'
import type { Wallet } from './wallet'

// Apart from the provider, so wallet.tsx exports only components and keeps fast refresh.
export const WalletContext = createContext<Wallet | null>(null)

export function useWallet(): Wallet {
  const v = useContext(WalletContext)
  if (!v) throw new Error('useWallet outside WalletProvider')
  return v
}
