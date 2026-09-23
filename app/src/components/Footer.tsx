import { DESKS, DOCS_URL, follow, hrefFor, type RoutePath } from '../lib/useRoute'
import { Lockup } from './Lockup'

/** Every desk again, and the two promises the whole service is built on. */
export function Footer({ vaultId, onNavigate }: {
  vaultId: string | null; onNavigate: (path: RoutePath) => void
}) {
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
        </nav>
      </div>
    </footer>
  )
}
