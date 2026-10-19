import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { shortAddress, validateClassicAddress } from './xrpl-address'

/**
 * Viewing an account: a reference the reader typed, kept in this browser and shown in the
 * masthead. Nothing is signed and nothing leaves the page. Signing applications were offered
 * here once, but nothing on these pages ever asked them to sign, so they are gone.
 */
export type WalletState =
  | { status: 'disconnected' }
  | { status: 'connected'; address: string }

const STORE_KEY = 'vfo.wallet'

interface Wallet {
  state: WalletState
  connectReadOnly: (raw: string) => Promise<boolean>
  disconnect: () => void
}

const Ctx = createContext<Wallet | null>(null)

function remember(address: string | null) {
  try {
    if (address) localStorage.setItem(STORE_KEY, JSON.stringify({ address }))
    else localStorage.removeItem(STORE_KEY)
  } catch { /* a browser that refuses storage is not an error worth showing */ }
}

function restored(): WalletState {
  try {
    const saved = localStorage.getItem(STORE_KEY)
    const address = saved ? (JSON.parse(saved) as { address?: unknown }).address : null
    return typeof address === 'string' && address ? { status: 'connected', address } : { status: 'disconnected' }
  } catch {
    return { status: 'disconnected' }
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  // The app renders on the client only, so the stored reference can be read at once.
  const [state, setState] = useState<WalletState>(restored)

  const connectReadOnly = useCallback(async (raw: string) => {
    const check = await validateClassicAddress(raw)
    if (!check.ok) {
      toast.error('That reference is not valid', { description: check.reason })
      return false
    }
    setState({ status: 'connected', address: check.address })
    remember(check.address)
    toast.success('Viewing an account', { description: shortAddress(check.address) })
    return true
  }, [])

  const disconnect = useCallback(() => {
    setState({ status: 'disconnected' })
    remember(null)
    toast('Stopped viewing', { description: 'Every figure is still shown.' })
  }, [])

  const value = useMemo<Wallet>(() => ({ state, connectReadOnly, disconnect }), [state, connectReadOnly, disconnect])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWallet(): Wallet {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWallet outside WalletProvider')
  return v
}
