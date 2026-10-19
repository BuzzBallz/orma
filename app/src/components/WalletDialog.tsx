import { useState } from 'react'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useWallet } from '../lib/useWallet'
import { validateClassicAddress } from '../lib/xrpl-address'

/**
 * View an account: type a reference, see it in the masthead. Nothing is signed.
 *
 * A mistyped reference is answered under the field, where the eye already is, rather than
 * in a toast in the far corner. The check is the same one the provider runs on submit.
 */
export function SignInDialog({ open, onOpenChange }: {
  open: boolean; onOpenChange: (v: boolean) => void
}) {
  const { connectReadOnly } = useWallet()
  const [paste, setPaste] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="dlg" showCloseButton>
        <DialogHeader className="dlg-head">
          <DialogTitle className="dlg-title">View an account</DialogTitle>
          <DialogDescription className="dlg-sub">
            Nothing on these pages is behind a sign-in. The reference is kept in this browser
            only: nothing is recorded, nothing is signed and no amount is moved.
          </DialogDescription>
        </DialogHeader>

        <form
          className="wpaste"
          noValidate
          onSubmit={async e => {
            e.preventDefault()
            setBusy(true)
            try {
              const check = await validateClassicAddress(paste)
              if (!check.ok) {
                setError(check.reason[0].toUpperCase() + check.reason.slice(1))
                return
              }
              if (await connectReadOnly(paste)) { setPaste(''); setError(null); onOpenChange(false) }
            } finally {
              // crypto.subtle is missing outside a secure context; the button must not stay stuck.
              setBusy(false)
            }
          }}
        >
          <div className="field">
            <label htmlFor="ro-addr">Account reference</label>
            <input
              id="ro-addr" spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off" enterKeyHint="go"
              aria-invalid={error ? true : undefined} aria-describedby="ro-note"
              value={paste} onChange={e => { setPaste(e.target.value); setError(null) }}
            />
            {error
              ? <span id="ro-note" className="field-error" role="alert"><b>That reference is not valid</b>. {error}.</span>
              : <span id="ro-note" className="field-help">The reference is checked before it is accepted.</span>}
          </div>
          <div className="wpaste-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>Continue</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
