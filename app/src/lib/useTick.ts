import { useEffect, useState } from 'react'

/** One shared 1 Hz ticker for the whole app: the page re-renders once per second, not once per countdown. */
export function useTick(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN(v => v + 1), 1000)
    return () => clearInterval(id)
  }, [])
  return n
}
