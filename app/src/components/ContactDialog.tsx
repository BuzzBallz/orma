import { useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

const TO = 'gonzalez.andrea.pro@gmail.com'

/**
 * Contact. The site has no server of its own to send mail from, so the message goes by a
 * form relay that forwards it to the inbox above; the dialog says so, because the relay
 * reads what is written. When it does not answer, the address is printed under the form
 * so the reader is never left with a message they cannot send.
 */
export function ContactDialog({ open, onOpenChange }: {
  open: boolean; onOpenChange: (v: boolean) => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [trap, setTrap] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const done = () => {
    setName(''); setEmail(''); setMessage(''); setFailed(false)
    onOpenChange(false)
    toast.success('Message sent', { description: 'Thank you. The answer comes by email.' })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* On a phone the first field would raise the keyboard over the very text that says where the message goes. */}
      <DialogContent
        className="dlg" showCloseButton
        onOpenAutoFocus={e => { if (matchMedia('(pointer: coarse)').matches) e.preventDefault() }}
      >
        <DialogHeader className="dlg-head">
          <DialogTitle className="dlg-title">Contact</DialogTitle>
          <DialogDescription className="dlg-sub">
            A question about a facility, or about how a figure is read. The answer comes by email.
          </DialogDescription>
        </DialogHeader>

        <form
          className="contact"
          onSubmit={async e => {
            e.preventDefault()
            // A person never sees the trap field; whatever fills it is a script, and is thanked, not sent.
            if (trap) return done()
            setBusy(true); setFailed(false)
            try {
              const r = await fetch(`https://formsubmit.co/ajax/${TO}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ name, email, message, _subject: 'Orma: message from the site', _template: 'table', _captcha: 'false' }),
              })
              const body = await r.json()
              if (!r.ok || String(body.success) !== 'true') throw new Error('relay refused')
              done()
            } catch {
              setFailed(true)
            }
            setBusy(false)
          }}
        >
          <div className="field">
            <label htmlFor="ct-name">Name</label>
            <input id="ct-name" required maxLength={120} autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ct-email">Email</label>
            <input id="ct-email" type="email" required maxLength={200} autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ct-message">Message</label>
            <textarea id="ct-message" required maxLength={2000} rows={5} aria-describedby="ct-note" value={message} onChange={e => setMessage(e.target.value)} />
            <span id="ct-note" className="field-help">Sent by email through FormSubmit. Nothing is stored on this site.</span>
          </div>
          <div className="hp" aria-hidden>
            <label htmlFor="ct-trap">Leave this field empty</label>
            <input id="ct-trap" name="_honey" tabIndex={-1} autoComplete="off" value={trap} onChange={e => setTrap(e.target.value)} />
          </div>

          {failed && (
            <span className="field-error" role="alert">
              <b>The message could not be sent</b>. Write to <a className="lnk" href={`mailto:${TO}`}>{TO}</a> instead.
            </span>
          )}
          <div className="wpaste-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
