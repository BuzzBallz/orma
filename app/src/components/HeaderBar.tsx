import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { ArrowUpRight, Menu, X } from 'lucide-react'
import type { VaultRow } from '../lib/types'
import { DESKS, DOCS_URL, follow, hrefFor, type RoutePath } from '../lib/useRoute'
import { fmtIso } from '../lib/format'
import { FacilityPicker } from './VaultPicker'
import { SignInButton } from './WalletButton'
import { SignInDialog } from './WalletDialog'
import { Lockup } from './Lockup'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'

/**
 * Received, or withheld — said by the timestamp itself. A desk that is current says so
 * by showing the time it is current to; it does not need a badge agreeing with the clock.
 * Withheld, the time goes to an em-dash and one word stands beside it.
 */
function Stamp({ asOf, withheld }: { asOf: string | null; withheld: boolean }) {
  return (
    <span className="stamp">
      As of {!withheld && asOf ? fmtIso(asOf) : '—'}
      {withheld && <span className="stamp-state">Withheld</span>}
    </span>
  )
}

/**
 * The masthead. Five desks as real links, the documentation beside them (it leaves this
 * application, so it is not dressed as a desk), and the two controls a reader needs: which
 * facility, and who is reading.
 *
 * The facility picker only appears on the two desks that cover one facility. On the
 * portfolio the list itself is the picker, and on the other two there is nothing to pick.
 * Narrow, all of it folds into one menu.
 */
export function HeaderBar({ vaults, activeVaultId, path, asOf, withheld, slide, onNavigate, onSelect }: {
  vaults: VaultRow[]
  activeVaultId: string | null
  path: RoutePath
  asOf: string | null
  withheld: boolean
  /** Whether a desk change should slide the underline: a click, not a shortcut. */
  slide: boolean
  onNavigate: (path: RoutePath) => void
  onSelect: (vaultId: string) => void
}) {
  const [menu, setMenu] = useState(false)
  const [signIn, setSignIn] = useState(false)

  // The active underline is one element moved by transform. It slides when the desk
  // changes and snaps when the layout changes under it (a resize, the fonts arriving).
  const nav = useRef<HTMLElement>(null)
  const [ind, setInd] = useState<{ x: number; w: number; slide: boolean } | null>(null)
  const measure = useCallback((slide: boolean) => {
    const a = nav.current?.querySelector<HTMLElement>('[aria-current="page"]')
    if (a) setInd(prev => ({ x: a.offsetLeft, w: a.offsetWidth, slide: slide && prev !== null }))
  }, [])
  useLayoutEffect(() => { measure(slide) }, [path, slide, measure])
  useEffect(() => {
    const snap = () => measure(false)
    addEventListener('resize', snap)
    document.fonts?.ready.then(snap)
    return () => removeEventListener('resize', snap)
  }, [measure])

  const home = (e: MouseEvent) => follow(e, () => { setMenu(false); onNavigate('/') })
  const showStamp = path === '/' || path === '/evidence'
  const showPicker = path === '/facility' || path === '/event'
  const openSignIn = () => { setMenu(false); setSignIn(true) }

  return (
    <header className="mast">
      <div className="wrap mast-in">
        <Lockup onClick={home} />

        <nav className="desks" aria-label="Sections" ref={nav}>
          {DESKS.map(([p, label]) => (
            <a
              key={p} className="desk" data-label={label}
              href={hrefFor(p, activeVaultId)}
              aria-current={path === p ? 'page' : undefined}
              onClick={e => follow(e, () => onNavigate(p))}
            >{label}</a>
          ))}
          <span
            className="desk-ind" aria-hidden
            data-slide={ind?.slide || undefined}
            style={ind ? { transform: `translateX(${ind.x}px) scaleX(${ind.w})` } : { opacity: 0 }}
          />
        </nav>

        <div className="mast-right">
          {showStamp && <Stamp asOf={asOf} withheld={withheld} />}
          <a className="lnk lnk-plain" href={DOCS_URL} target="_blank" rel="noreferrer noopener">
            Docs <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden />
          </a>
          {showPicker && <FacilityPicker vaults={vaults} activeVaultId={activeVaultId} onSelect={onSelect} />}
          <SignInButton onOpen={openSignIn} />
        </div>

        <button type="button" className="menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(true)}>
          <Menu size={22} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <Dialog open={menu} onOpenChange={setMenu}>
        <DialogContent className="menu-sheet" showCloseButton={false} aria-describedby={undefined}>
          <DialogTitle className="sr-only">Menu</DialogTitle>
          <div className="menu-top">
            <Lockup small onClick={home} />
            <DialogClose className="menu-x" aria-label="Close menu">
              <X size={22} strokeWidth={1.75} aria-hidden />
            </DialogClose>
          </div>
          <nav className="menu-list" aria-label="Sections">
            {DESKS.map(([p, label]) => (
              <a
                key={p} href={hrefFor(p, activeVaultId)}
                aria-current={path === p ? 'page' : undefined}
                onClick={e => follow(e, () => { setMenu(false); onNavigate(p) })}
              >{label}</a>
            ))}
          </nav>
          <div className="menu-more">
            <a className="lnk" href={DOCS_URL} target="_blank" rel="noreferrer noopener">
              Docs <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden />
            </a>
            <SignInButton onOpen={openSignIn} />
          </div>
          <p className="menu-stamp"><Stamp asOf={asOf} withheld={withheld} /></p>
        </DialogContent>
      </Dialog>

      <SignInDialog open={signIn} onOpenChange={setSignIn} />
    </header>
  )
}
