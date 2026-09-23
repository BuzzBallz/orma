import { useState } from 'react'
import { QrCode } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { WALLETS, XAMAN_CONFIGURED, useWallet } from '../lib/wallet'
import { validateClassicAddress } from '../lib/xrpl-address'

/**
 * Sign in. Three signing applications, and a view-only route for anyone who has none.
 * Each row says whether it is actually available here; an application that is not
 * installed is stated, never hidden and never guessed at.
 *
 * A mistyped reference is answered under the field, where the eye already is, rather than
 * in a toast in the far corner. The check is the same one the wallet runs on submit.
 */
export function SignInDialog({ open, onOpenChange }: {
  open: boolean; onOpenChange: (v: boolean) => void
}) {
  const { detected, connect, connectReadOnly, qr, state } = useWallet()
  const [paste, setPaste] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="dlg" showCloseButton>
        <span className="grab" aria-hidden />
        <DialogHeader className="dlg-head">
          <DialogTitle className="dlg-title">Sign in</DialogTitle>
          <DialogDescription className="dlg-sub">
            Nothing on these pages is behind a sign-in. It records who is reading, and
            authorises nothing: no instruction is sent and no amount is moved.
          </DialogDescription>
        </DialogHeader>

        <div className="wrows">
          {WALLETS.map(w => {
            const here = detected[w.kind]
            const busyRow = state.status === 'connecting' && state.kind === w.kind
            return (
              <div className="wrow" key={w.kind} data-here={here}>
                <span className="wrow-id">
                  <span className="wname">{w.name}</span>
                  <span className="wnote">{w.note}</span>
                </span>
                <span className="wstate">
                  {busyRow ? 'waiting…'
                    : here ? 'available'
                    : w.kind === 'xaman' ? 'not configured'
                    : 'not installed'}
                </span>
                <button
                  type="button" className="btn btn-secondary btn-small" disabled={busyRow}
                  onClick={() => connect(w.kind)}
                >
                  {w.kind === 'xaman' && here
                    ? <><QrCode size={16} strokeWidth={1.75} aria-hidden /> Code</>
                    : 'Use'}
                </button>
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

        {!XAMAN_CONFIGURED && <p className="wnote">Mobile sign-in is not available here.</p>}

        <form
          className="wpaste"
          noValidate
          onSubmit={async e => {
            e.preventDefault()
            setBusy(true)
            const check = await validateClassicAddress(paste)
            if (!check.ok) {
              setError(check.reason[0].toUpperCase() + check.reason.slice(1))
              setBusy(false)
              return
            }
            const ok = await connectReadOnly(paste)
            setBusy(false)
            if (ok) { setPaste(''); setError(null); onOpenChange(false) }
          }}
        >
          <h3 className="t-label-m">No signing application, read as view only</h3>
          <div className="field">
            <label htmlFor="ro-addr">Account reference</label>
            <input
              id="ro-addr" spellCheck={false} autoComplete="off" autoCapitalize="off"
              aria-invalid={error ? true : undefined} aria-describedby="ro-note"
              value={paste} onChange={e => { setPaste(e.target.value); setError(null) }}
            />
            {error
              ? <span id="ro-note" className="field-error" role="alert"><b>That reference is not valid</b>. {error}.</span>
              : <span id="ro-note" className="field-help">The reference is checked before it is accepted. View only: nothing can be signed.</span>}
          </div>
          <div className="wpaste-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>Continue</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
