import { useCallback, useEffect, useState } from 'react'

export type RoutePath = '/' | '/vault' | '/moment' | '/oracle'
const ROUTES: RoutePath[] = ['/', '/vault', '/moment', '/oracle']

function read(): { path: RoutePath; vaultId: string | null } {
  const raw = location.pathname.replace(/\/+$/, '') || '/'
  const path = (ROUTES as string[]).includes(raw) ? (raw as RoutePath) : '/'
  return { path, vaultId: new URLSearchParams(location.search).get('vault') }
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
