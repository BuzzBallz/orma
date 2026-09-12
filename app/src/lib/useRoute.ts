import { useCallback, useEffect, useState } from 'react'

export type RoutePath = '/' | '/vault' | '/moment' | '/oracle'
const ROUTES: RoutePath[] = ['/', '/vault', '/moment', '/oracle']

function read(): { path: RoutePath; vaultId: string | null } {
  const raw = location.pathname.replace(/\/+$/, '') || '/'
  const known = (ROUTES as string[]).includes(raw)
  // An unknown path renders the book, so the address bar must say so too — otherwise
  // /nope shows the book while the URL claims something else, which is confusing to
  // anyone reading over a shoulder.
  if (!known) history.replaceState(null, '', '/' + location.search)
  return { path: known ? (raw as RoutePath) : '/', vaultId: new URLSearchParams(location.search).get('vault') }
}

export function useRoute() {
  const [route, setRoute] = useState(read)

  useEffect(() => {
    const onPop = () => setRoute(read())
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((path: RoutePath, vaultId?: string | null) => {
    const id = vaultId === undefined ? new URLSearchParams(location.search).get('vault') : vaultId
    const url = path + (id && path !== '/' ? '?vault=' + id : '')
    history.pushState(null, '', url)
    setRoute(read())
  }, [])

  return { ...route, navigate }
}
