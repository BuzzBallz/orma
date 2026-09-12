import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { shortAddress, validateClassicAddress } from './xrpl-address'

export type WalletKind = 'crossmark' | 'gemwallet' | 'xaman'
export type Via = WalletKind | 'read-only'

export type WalletState =
  | { status: 'disconnected' }
  | { status: 'connecting'; kind: Via }
  | { status: 'connected'; address: string; via: Via }

export const WALLETS: { kind: WalletKind; name: string; note: string; site: string }[] = [
  { kind: 'crossmark', name: 'Crossmark', note: 'browser extension', site: 'https://crossmark.io' },
  { kind: 'gemwallet', name: 'GemWallet', note: 'browser extension', site: 'https://gemwallet.app' },
  { kind: 'xaman',     name: 'Xaman',     note: 'phone, by QR',      site: 'https://xaman.app' },
]

/** Configuration, not a reading: the network the wallet side is pointed at. */
export const WALLET_NETWORK: string = import.meta.env.VITE_XRPL_NETWORK ?? 'testnet'
export const XAMAN_CONFIGURED = Boolean(import.meta.env.VITE_XAMAN_API_KEY)

const STORE_KEY = 'vfo.wallet'

interface Wallet {
  state: WalletState
  network: string
  detected: Record<WalletKind, boolean>
  /** The kind whose last connect attempt found nothing installed — drives the one banner. */
  missing: WalletKind | null
  dismissMissing: () => void
  connect: (kind: WalletKind) => Promise<void>
  connectReadOnly: (raw: string) => Promise<boolean>
  disconnect: () => void
}

const Ctx = createContext<Wallet | null>(null)

/**
 * Extensions inject on their own schedule, so a single check at mount misses them.
 * Look a few times over the first couple of seconds, then stop asking.
 */
function useDetected(): Record<WalletKind, boolean> {
  const read = (): Record<WalletKind, boolean> => {
    const w = window as unknown as Record<string, unknown>
    return {
      crossmark: Boolean(w.crossmark),
      gemwallet: Boolean(w.gemWallet ?? w.gemwallet),
      xaman: XAMAN_CONFIGURED,       // no extension: Xaman is a phone and an API key
    }
  }
  const [d, setD] = useState(read)
  useEffect(() => {
    const timers = [150, 400, 900, 1800].map(ms => setTimeout(() => setD(read()), ms))
    return () => timers.forEach(clearTimeout)
  }, [])
  return d
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>({ status: 'disconnected' })
  const [missing, setMissing] = useState<WalletKind | null>(null)
  const detected = useDetected()
  const restored = useRef(false)

  // Session restore, read-only side. The toolkit restores its own sessions in stage 3.
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    try {
      const saved = localStorage.getItem(STORE_KEY)
      if (!saved) return
      const { address, via } = JSON.parse(saved) as { address: string; via: Via }
      if (address && via === 'read-only') setState({ status: 'connected', address, via })
    } catch { /* a browser that refuses storage is not an error worth showing */ }
  }, [])

  const remember = (s: WalletState) => {
    try {
      if (s.status === 'connected' && s.via === 'read-only') {
        localStorage.setItem(STORE_KEY, JSON.stringify({ address: s.address, via: s.via }))
      } else localStorage.removeItem(STORE_KEY)
    } catch { /* ignore */ }
  }

  const connect = useCallback(async (kind: WalletKind) => {
    if (!detected[kind]) {
      setMissing(kind)
      const w = WALLETS.find(x => x.kind === kind)!
      toast.error(`${w.name} not detected`, {
        description: kind === 'xaman'
          ? 'Xaman needs VITE_XAMAN_API_KEY to issue a sign-in QR.'
          : `Install the ${w.name} extension, then reload this page.`,
      })
      return
    }
    // Stage 3 puts the real adapter behind this seam. Until then a detected extension
    // is reported honestly as not wired rather than faked with an address.
    setMissing(null)
    toast.error('Adapter not wired yet', {
      description: 'Paste a classic address below to follow the desk read-only.',
    })
  }, [detected])

  const connectReadOnly = useCallback(async (raw: string) => {
    const check = await validateClassicAddress(raw)
    if (!check.ok) {
      toast.error('Not a classic address', { description: check.reason })
      return false
    }
    const next: WalletState = { status: 'connected', address: check.address, via: 'read-only' }
    setState(next); remember(next); setMissing(null)
    toast.success('Connected read-only', { description: shortAddress(check.address) })
    return true
  }, [])

  const disconnect = useCallback(() => {
    setState({ status: 'disconnected' })
    remember({ status: 'disconnected' })
    toast('Disconnected', { description: 'The desk keeps reading the ledger.' })
  }, [])

  const value = useMemo<Wallet>(() => ({
    state, network: WALLET_NETWORK, detected, missing,
    dismissMissing: () => setMissing(null),
    connect, connectReadOnly, disconnect,
  }), [state, detected, missing, connect, connectReadOnly, disconnect])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWallet(): Wallet {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWallet outside WalletProvider')
  return v
}
