import { useState } from 'react'
import { KeyRound, QrCode, ShieldCheck, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WALLETS, XAMAN_CONFIGURED, useWallet, type WalletKind } from '../lib/wallet'

const ICON: Record<WalletKind, typeof ShieldCheck> = {
  crossmark: ShieldCheck, gemwallet: ShieldCheck, xaman: Smartphone,
}

/** What a reader chooses by. The product name is a detail, and lives in the tooltip. */
const KIND_LABEL: Record<WalletKind, string> = {
  crossmark: 'Desktop app', gemwallet: 'Desktop app (alternate)', xaman: 'Mobile app',
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
            Sign-in records the reader. It does not send an instruction.
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
                <Tooltip>
                  <TooltipTrigger asChild><span className="wname">{KIND_LABEL[w.kind]}</span></TooltipTrigger>
                  <TooltipContent className="tip" side="top">{w.name}</TooltipContent>
                </Tooltip>
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
            <KeyRound size={11} strokeWidth={2.25} aria-hidden /> View only — account reference
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
          <span className="wnote">Nothing can be signed.</span>
        </form>
      </DialogContent>
    </Dialog>
  )
}
