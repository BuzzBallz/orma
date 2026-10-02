import { useState } from 'react'
import { DESKS, DOCS_URL, follow, hrefFor, type RoutePath } from '../lib/useRoute'
import { Lockup } from './Lockup'
import { ContactDialog } from './ContactDialog'

/** Every desk again, and the two promises the whole service is built on. */
export function Footer({ vaultId, onNavigate }: {
  vaultId: string | null; onNavigate: (path: RoutePath) => void
}) {
  const [contact, setContact] = useState(false)
  return (
    <footer className="foot">
      <div className="wrap grid12 foot-in">
        <div className="foot-brand">
          <Lockup small onClick={e => follow(e, () => onNavigate('/'))} />
        </div>
        <div className="foot-lines">
          <p>Nothing on these pages is behind a sign-in.</p>
          <p>A stale figure is never carried forward as current and never estimated.</p>
        </div>
        <nav className="foot-nav" aria-label="Footer">
          {DESKS.map(([p, label]) => (
            <a key={p} href={hrefFor(p, vaultId)} onClick={e => follow(e, () => onNavigate(p))}>{label}</a>
          ))}
          <a href={DOCS_URL} target="_blank" rel="noreferrer noopener">Docs</a>
          <button type="button" onClick={() => setContact(true)}>Contact</button>
        </nav>
      </div>
      <ContactDialog open={contact} onOpenChange={setContact} />
    </footer>
  )
}
