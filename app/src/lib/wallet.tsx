import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { WalletManager } from 'xrpl-connect'
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
const XAMAN_KEY: string | undefined = import.meta.env.VITE_XAMAN_API_KEY
export const XAMAN_CONFIGURED = Boolean(XAMAN_KEY)

const STORE_KEY = 'vfo.wallet'
/** The toolkit's own localStorage prefix — see LocalStorageAdapter in xrpl-connect. */
const TOOLKIT_PREFIX = 'xrpl-connect:'

interface Wallet {
  state: WalletState
  network: string
  detected: Record<WalletKind, boolean>
  /** The kind whose last connect attempt found nothing installed — drives the one banner. */
  missing: WalletKind | null
  /** Xaman sign-in QR, while that flow is open. */
  qr: string | null
  dismissMissing: () => void
  /** Opening the dialog is intent to connect: start fetching the toolkit chunk then. */
  prefetch: () => void
  connect: (kind: WalletKind) => Promise<void>
  connectReadOnly: (raw: string) => Promise<boolean>
  disconnect: () => void
}

const Ctx = createContext<Wallet | null>(null)

/**
 * xrpl-connect pulls in the whole xrpl client — well over a megabyte. It is imported
 * dynamically so the desk paints, and reaches first light, without it: nobody waits on a
 * wallet bundle to read the book. It loads when someone opens the dialog, or straight
 * after first paint when a previous session is sitting in storage waiting to be restored.
 */
let managerPromise: Promise<WalletManager> | null = null

function hasStoredSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(TOOLKIT_PREFIX)) return true
    }
  } catch { /* storage refused: treat as no session */ }
  return false
}

async function getManager(
  onConnect: (address: string, via: WalletKind) => void,
  onDisconnect: () => void,
): Promise<WalletManager> {
  if (managerPromise) return managerPromise
  managerPromise = (async () => {
    const xc = await import('xrpl-connect')
    const adapters = [
      new xc.CrossmarkAdapter(),
      new xc.GemWalletAdapter(),
      ...(XAMAN_KEY ? [new xc.XamanAdapter({ apiKey: XAMAN_KEY })] : []),
    ]
    // autoConnect is started by hand AFTER the listeners are attached. Left to the
    // constructor it can emit `connect` before anything is listening — the README says
    // so itself, and a restored session that nobody hears is a wallet that silently
    // does not appear.
    const mgr = new xc.WalletManager({ adapters, network: WALLET_NETWORK, autoConnect: false })
    mgr.on('connect', a => {
      const via = (mgr.wallet?.id ?? 'crossmark') as WalletKind
      if (a?.address) onConnect(a.address, via)
    })
    mgr.on('disconnect', onDisconnect)
    return mgr
  })()
  return managerPromise
}

/**
 * A cheap hint for the dialog rows, so it can say what is here without paying for the
 * toolkit first. It is a hint and nothing more: the authoritative check is the adapter's
 * own isAvailable(), which runs inside connect() and throws WALLET_NOT_AVAILABLE.
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
  const [qr, setQr] = useState<string | null>(null)
  const detected = useDetected()
  const booted = useRef(false)

  const remember = (s: WalletState) => {
    try {
      if (s.status === 'connected' && s.via === 'read-only') {
        localStorage.setItem(STORE_KEY, JSON.stringify({ address: s.address, via: s.via }))
      } else localStorage.removeItem(STORE_KEY)
    } catch { /* a browser that refuses storage is not an error worth showing */ }
  }

  const onConnect = useCallback((address: string, via: WalletKind) => {
    setQr(null); setMissing(null)
    setState({ status: 'connected', address, via })
    toast.success(`Connected with ${WALLETS.find(w => w.kind === via)?.name ?? via}`, {
      description: `${shortAddress(address)} · ${WALLET_NETWORK}`,
    })
  }, [])

  const onDisconnect = useCallback(() => {
    setQr(null)
    setState({ status: 'disconnected' })
  }, [])

  // Boot once, after first paint. The read-only session is local and free; the toolkit is
  // only fetched when there is actually a session of its own to bring back.
  useEffect(() => {
    if (booted.current) return
    booted.current = true

    try {
      const saved = localStorage.getItem(STORE_KEY)
      if (saved) {
        const { address, via } = JSON.parse(saved) as { address: string; via: Via }
        if (address && via === 'read-only') setState({ status: 'connected', address, via })
      }
    } catch { /* ignore */ }

    if (!hasStoredSession()) return
    const idle = (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 400)))
    idle(() => { getManager(onConnect, onDisconnect).then(m => m.autoConnect()).catch(() => {}) })
  }, [onConnect, onDisconnect])

  const connect = useCallback(async (kind: WalletKind) => {
    if (kind === 'xaman' && !XAMAN_CONFIGURED) {
      setMissing('xaman')
      toast.error('Xaman is not configured', {
        description: 'Set VITE_XAMAN_API_KEY to issue a sign-in QR. Crossmark and GemWallet are unaffected.',
      })
      return
    }
    setState({ status: 'connecting', kind })
    try {
      const mgr = await getManager(onConnect, onDisconnect)
      // onQRCode is the adapter's own callback: the QR is whatever Xaman minted for this
      // sign-in, never an image we compose ourselves.
      await mgr.connect(kind, kind === 'xaman' ? { onQRCode: url => setQr(url) } : undefined)
      // the `connect` event does the rest — one path for a fresh connect and a restore
    } catch (e) {
      setQr(null)
      setState({ status: 'disconnected' })
      const code = (e as { code?: string })?.code ?? ''
      const name = WALLETS.find(w => w.kind === kind)?.name ?? kind

      if (code === 'WALLET_NOT_AVAILABLE' || code === 'WALLET_NOT_INSTALLED' || code === 'WALLET_NOT_FOUND') {
        setMissing(kind)
        toast.error(`${name} not detected`, {
          description: `Install the ${name} extension, then reload this page.`,
        })
        return
      }
      if (code === 'CONNECTION_REJECTED' || code === 'SIGN_REJECTED' || code === 'SIGN_FAILED') {
        toast.error('Request rejected', { description: `${name} closed without connecting.` })
        return
      }
      toast.error(`${name} could not connect`, {
        description: (e as Error)?.message ?? 'the wallet did not say why',
      })
    }
  }, [onConnect, onDisconnect])

  const connectReadOnly = useCallback(async (raw: string) => {
    const check = await validateClassicAddress(raw)
    if (!check.ok) {
      toast.error('Not a classic address', { description: check.reason })
      return false
    }
    const next: WalletState = { status: 'connected', address: check.address, via: 'read-only' }
    setState(next); remember(next); setMissing(null)
    toast.success('Following read-only', { description: `${shortAddress(check.address)} · ${WALLET_NETWORK}` })
    return true
  }, [])

  const disconnect = useCallback(() => {
    const wasReadOnly = state.status === 'connected' && state.via === 'read-only'
    setState({ status: 'disconnected' })
    remember({ status: 'disconnected' })
    setQr(null)
    if (!wasReadOnly && managerPromise) managerPromise.then(m => m.disconnect()).catch(() => {})
    toast('Disconnected', { description: 'The desk keeps reading the ledger.' })
  }, [state])

  const prefetch = useCallback(() => {
    getManager(onConnect, onDisconnect).catch(() => {})
  }, [onConnect, onDisconnect])

  const value = useMemo<Wallet>(() => ({
    state, network: WALLET_NETWORK, detected, missing, qr,
    dismissMissing: () => setMissing(null),
    prefetch, connect, connectReadOnly, disconnect,
  }), [state, detected, missing, qr, prefetch, connect, connectReadOnly, disconnect])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWallet(): Wallet {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWallet outside WalletProvider')
  return v
}
