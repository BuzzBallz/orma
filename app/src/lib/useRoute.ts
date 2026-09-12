import { useCallback, useEffect, useState } from 'react'

export type RoutePath = '/' | '/facility' | '/event' | '/methodology' | '/evidence'
const ROUTES: RoutePath[] = ['/', '/facility', '/event', '/methodology', '/evidence']

/** Older links keep working; the address bar is rewritten to the current wording. */
const MOVED: Record<string, RoutePath> = {
  '/vault': '/facility', '/moment': '/event', '/oracle': '/methodology',
}

/** The address bar is read too. `facility=` is the current spelling; `vault=` still works. */
function readId(): string | null {
  const q = new URLSearchParams(location.search)
  return q.get('facility') ?? q.get('vault')
}

function read(): { path: RoutePath; vaultId: string | null } {
  const raw = location.pathname.replace(/\/+$/, '') || '/'
  const moved = MOVED[raw]
  if (moved) {
    history.replaceState(null, '', moved + location.search)
    return { path: moved, vaultId: readId() }
  }
  const known = (ROUTES as string[]).includes(raw)
  // An unknown path renders the book, so the address bar must say so too — otherwise
  // /nope shows the book while the URL claims something else, which is confusing to
  // anyone reading over a shoulder.
  if (!known) history.replaceState(null, '', '/' + location.search)
  return { path: known ? (raw as RoutePath) : '/', vaultId: readId() }
}

export function useRoute() {
  const [route, setRoute] = useState(read)

  useEffect(() => {
    const onPop = () => setRoute(read())
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((path: RoutePath, vaultId?: string | null) => {
    const id = vaultId === undefined ? readId() : vaultId
    const url = path + (id && path !== '/' ? '?facility=' + id : '')
    history.pushState(null, '', url)
    setRoute(read())
  }, [])

  return { ...route, navigate }
}
