import { useState } from 'react'
import { KeyRound, Puzzle, QrCode, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { WALLETS, useWallet, type WalletKind } from '../lib/wallet'

const ICON: Record<WalletKind, typeof Puzzle> = {
  crossmark: Puzzle, gemwallet: Puzzle, xaman: Smartphone,
}

/**
 * B2 — three rows, and only three. Each says what it is and whether it is actually here;
 * an extension that is not installed is stated, never hidden and never guessed at.
 * Below the rule, the read-only path: a judge with no extension pastes an address and
 * follows the desk. The address is checked against the ledger's own base58 + checksum
 * before anything is shown.
 */
export function WalletDialog({ open, onOpenChange }: {
  open: boolean; onOpenChange: (v: boolean) => void
}) {
  const { detected, connect, connectReadOnly } = useWallet()
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="dlg" showCloseButton>
        <DialogHeader className="dlg-head">
          <DialogTitle className="dlg-title">choose a wallet</DialogTitle>
          <DialogDescription className="dlg-sub">
            The desk reads the ledger with or without you. Connecting only puts your
            account on screen — nothing is signed and nothing is sent.
          </DialogDescription>
        </DialogHeader>

        <div className="wrows">
          {WALLETS.map(w => {
            const here = detected[w.kind]
            const Icon = ICON[w.kind]
            return (
              <div className="wrow" key={w.kind} data-here={here}>
                <Icon size={14} strokeWidth={2} aria-hidden />
                <span className="wname">{w.name}</span>
                <span className="wnote">{w.note}</span>
                <span className="spacer" />
                <span className="wstate">
                  {here ? 'detected'
                    : w.kind === 'xaman' ? 'no api key'
                    : 'not installed'}
                </span>
                <Button
                  variant={here ? 'outline' : 'ghost'}
                  size="xs"
                  className="btn-term"
                  onClick={() => connect(w.kind)}
                >
                  {w.kind === 'xaman' && here
                    ? <><QrCode size={11} strokeWidth={2.25} /> qr</>
                    : 'connect'}
                </Button>
              </div>
            )
          })}
        </div>

        {/* B8 */}
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
            <KeyRound size={11} strokeWidth={2.25} aria-hidden /> no extension — follow read-only
          </label>
          <div className="wpaste-row">
            <input
              id="ro-addr" className="wfield" spellCheck={false} autoComplete="off"
              placeholder="r… classic address"
              value={paste} onChange={e => setPaste(e.target.value)}
            />
            <Button type="submit" size="xs" className="btn-term" variant="outline" disabled={busy}>
              follow
            </Button>
          </div>
          <span className="wnote">
            Checked against the ledger's base58 and checksum. Read-only: no key, no signing.
          </span>
        </form>
      </DialogContent>
    </Dialog>
  )
}
