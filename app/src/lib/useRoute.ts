import { useCallback, useEffect, useState, type MouseEvent } from 'react'

export type RoutePath = '/' | '/facility' | '/event' | '/methodology' | '/evidence' | '/desk'
const ROUTES: RoutePath[] = ['/', '/facility', '/event', '/methodology', '/evidence', '/desk']

// 'Evidence' last of the reading desks, and named for what it proves rather than for how it
// works: it is the only desk addressed to an engineer, and it should not be the first thing an
// analyst reaches for. 'Desk', the lending desk, comes after them.
export const DESKS: [RoutePath, string][] = [
  ['/', 'Portfolio'], ['/facility', 'Facility'], ['/event', 'Event'], ['/methodology', 'Methodology'],
  ['/evidence', 'Evidence'], ['/desk', 'Desk'],
]

/** Protocol documentation. Overridable so a preview build can point at its own copy. */
export const DOCS_URL: string = import.meta.env?.VITE_DOCS_URL ?? 'https://buzzballz.github.io/orma/'

/** Older links keep working; the address bar is rewritten to the current wording. */
const MOVED: Record<string, RoutePath> = {
  '/vault': '/facility', '/moment': '/event', '/oracle': '/methodology',
}

/**
 * The address bar is read too. `facility=` is the current spelling; `vault=` still works,
 * and is rewritten to it so a copied address carries the current wording.
 */
function readId(): string | null {
  const q = new URLSearchParams(location.search)
  const legacy = q.get('vault')
  if (legacy !== null && !q.has('facility')) {
    q.set('facility', legacy)
    q.delete('vault')
    history.replaceState(null, '', location.pathname + '?' + q)
  }
  return q.get('facility')
}

/** The desk's tab, raw: App.tsx resolves it against DESK_TABS, so this module never imports Desk.tsx. */
const readTab = () => new URLSearchParams(location.search).get('tab') ?? 'ticket'

function read(): { path: RoutePath; vaultId: string | null; tab: string } {
  const raw = location.pathname.replace(/\/+$/, '') || '/'
  const moved = MOVED[raw]
  if (moved) {
    history.replaceState(null, '', moved + location.search)
    return { path: moved, vaultId: readId(), tab: readTab() }
  }
  const known = (ROUTES as string[]).includes(raw)
  // An unknown path renders the book, so the address bar must say so too — otherwise
  // /nope shows the book while the URL claims something else, which is confusing to
  // anyone reading over a shoulder.
  if (!known) history.replaceState(null, '', '/' + location.search)
  return { path: known ? (raw as RoutePath) : '/', vaultId: readId(), tab: readTab() }
}

/** A desk tab's address: only `tab` changes, every other key of the query is kept, `facility` first of all. */
export function tabHref(search: string, id: string): string {
  const q = new URLSearchParams(search)
  q.set('tab', id)
  return '/desk?' + q
}

/** The address a desk link points at: the same one `navigate` pushes. */
export function hrefFor(path: RoutePath, vaultId: string | null): string {
  return path + (vaultId && path !== '/' ? '?facility=' + vaultId : '')
}

/**
 * Links are real links, so a new tab, a copied address and a middle click all work. A
 * plain left click stays in the page; anything with a modifier is left to the browser.
 */
export function follow(e: MouseEvent, go: () => void) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go()
}

export function useRoute() {
  const [route, setRoute] = useState(read)

  useEffect(() => {
    const onPop = () => setRoute(read())
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((path: RoutePath, vaultId?: string | null) => {
    history.pushState(null, '', hrefFor(path, vaultId === undefined ? readId() : vaultId))
    // A desk opens at its top. Back and forward keep the browser's own restored position.
    scrollTo(0, 0)
    setRoute(read())
  }, [])

  return { ...route, navigate }
}
