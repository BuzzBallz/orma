import { useState } from 'react'
import { KeyRound, QrCode, ShieldCheck, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { WALLETS, XAMAN_CONFIGURED, useWallet, type WalletKind } from '../lib/wallet'

const ICON: Record<WalletKind, typeof ShieldCheck> = {
  crossmark: ShieldCheck, gemwallet: ShieldCheck, xaman: Smartphone,
}

/**
 * Sign in. Three signing applications, and a view-only route for anyone who has none.
 * Each row says whether it is actually available here; an application that is not
 * installed is stated, never hidden and never guessed at.
 */
export function SignInDialog({ open, onOpenChange }: {
  open: boolean; onOpenChange: (v: boolean) => void
}) {
  const { detected, connect, connectReadOnly, qr, state } = useWallet()
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="dlg" showCloseButton>
        <DialogHeader className="dlg-head">
          <DialogTitle className="dlg-title">sign in</DialogTitle>
          <DialogDescription className="dlg-sub">
            Nothing on these pages is behind a sign-in. It records who is reading, and
            authorises nothing: no instruction is sent and no amount is moved.
          </DialogDescription>
        </DialogHeader>

        <div className="wrows">
          {WALLETS.map(w => {
            const here = detected[w.kind]
            const Icon = ICON[w.kind]
            const busyRow = state.status === 'connecting' && state.kind === w.kind
            return (
              <div className="wrow" key={w.kind} data-here={here}>
                <Icon size={14} strokeWidth={2} aria-hidden />
                <span className="wname">{w.name}</span>
                <span className="wnote">{w.note}</span>
                <span className="spacer" />
                <span className="wstate">
                  {busyRow ? 'waiting…'
                    : here ? 'available'
                    : w.kind === 'xaman' ? 'not configured'
                    : 'not installed'}
                </span>
                <Button
                  variant={here ? 'outline' : 'ghost'}
                  size="xs" className="btn-term" disabled={busyRow}
                  onClick={() => connect(w.kind)}
                >
                  {w.kind === 'xaman' && here
                    ? <><QrCode size={11} strokeWidth={2.25} /> code</>
                    : 'use'}
                </Button>
              </div>
            )
          })}
        </div>

        {qr && (
          <div className="wqr">
            <img src={qr} alt="sign-in code" width={180} height={180} />
            <span className="wnote">scan with the signing application on your phone</span>
          </div>
        )}

        {!XAMAN_CONFIGURED && (
          <span className="wnote wxaman">Mobile sign-in is not available here.</span>
        )}

        <Separator className="dlg-sep" />

        <form
          className="wpaste"
          onSubmit={async e => {
            e.preventDefault()
            setBusy(true)
            const ok = await connectReadOnly(paste)
            setBusy(false)
            if (ok) { setPaste(''); onOpenChange(false) }
          }}
        >
          <label className="label" htmlFor="ro-addr">
            <KeyRound size={11} strokeWidth={2.25} aria-hidden /> no signing application — read as view only
          </label>
          <div className="wpaste-row">
            <input
              id="ro-addr" className="wfield" spellCheck={false} autoComplete="off"
              placeholder="account reference"
              value={paste} onChange={e => setPaste(e.target.value)}
            />
            <Button type="submit" size="xs" className="btn-term" variant="outline" disabled={busy}>
              continue
            </Button>
          </div>
          <span className="wnote">
            The reference is checked before it is accepted. View only: nothing can be signed.
          </span>
        </form>
      </DialogContent>
    </Dialog>
  )
}
