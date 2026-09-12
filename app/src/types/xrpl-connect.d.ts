/**
 * xrpl-connect@0.8.2 ships no .d.ts despite the README's "Type Safe" badge, so this is a
 * hand-written shim covering exactly the surface we use — verified against the real module
 * in the browser, not guessed from the docs.
 *
 * Two things the package gets wrong that we work around rather than fight:
 *  - it imports `xrpl` without declaring it, so `xrpl` is a direct dependency here;
 *  - `WalletManager` extends an EventEmitter, so on/off live on the parent prototype.
 */
declare module 'xrpl-connect' {
  export interface WalletAccount {
    address: string
    network?: string
    publicKey?: string
  }

  export interface WalletAdapter {
    id: string
    name: string
    icon?: string
    url?: string
    isAvailable(): Promise<boolean>
  }

  export interface XamanConnectOptions {
    apiKey?: string
    /** Called with the sign-in QR image URL (xumm.app/sign/….png). */
    onQRCode?: (url: string) => void
    onDeepLink?: (url: string) => void
  }

  export class WalletError extends Error {
    code: string
    name: 'WalletError'
  }

  export const WalletErrorCode: {
    WALLET_NOT_FOUND: 'WALLET_NOT_FOUND'
    WALLET_NOT_INSTALLED: 'WALLET_NOT_INSTALLED'
    WALLET_NOT_AVAILABLE: 'WALLET_NOT_AVAILABLE'
    CONNECTION_FAILED: 'CONNECTION_FAILED'
    CONNECTION_REJECTED: 'CONNECTION_REJECTED'
    SIGN_FAILED: 'SIGN_FAILED'
    SIGN_REJECTED: 'SIGN_REJECTED'
    NETWORK_NOT_SUPPORTED: 'NETWORK_NOT_SUPPORTED'
    NETWORK_MISMATCH: 'NETWORK_MISMATCH'
    NOT_CONNECTED: 'NOT_CONNECTED'
    ALREADY_CONNECTED: 'ALREADY_CONNECTED'
    UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD'
    UNKNOWN_ERROR: 'UNKNOWN_ERROR'
  }

  export function isWalletError(e: unknown): e is WalletError

  export class WalletManager {
    constructor(opts: {
      adapters: WalletAdapter[]
      network?: string
      autoConnect?: boolean
    })
    readonly account: WalletAccount | null
    readonly connected: boolean
    readonly wallet: WalletAdapter | null
    connect(walletId: string, options?: XamanConnectOptions): Promise<WalletAccount>
    disconnect(): Promise<void>
    autoConnect(): Promise<void>
    getAvailableWallets(): Promise<WalletAdapter[]>
    cleanup(): void
    on(event: 'connect', fn: (a: WalletAccount) => void): void
    on(event: 'disconnect', fn: () => void): void
    off(event: string, fn: (...args: never[]) => void): void
  }

  export class CrossmarkAdapter implements WalletAdapter {
    id: string; name: string; icon?: string; url?: string
    isAvailable(): Promise<boolean>
  }
  export class GemWalletAdapter implements WalletAdapter {
    id: string; name: string; icon?: string; url?: string
    isAvailable(): Promise<boolean>
  }
  export class XamanAdapter implements WalletAdapter {
    constructor(options?: { apiKey?: string })
    id: string; name: string; icon?: string; url?: string
    isAvailable(): Promise<boolean>
  }

  export function isXamanQRImage(url: string): boolean
}
