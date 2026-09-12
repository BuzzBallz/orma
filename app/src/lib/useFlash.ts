import { useEffect, useRef, useState } from 'react'

/**
 * Returns true for 120ms after `value` actually changes.
 *
 * The trigger is a real change in a value that came from an HTTP payload — never a
 * timer, never a mount. The first render never flashes, so arriving data does not
 * light the whole screen up.
 */
export function useFlash(value: unknown, ms = 120): boolean {
  const prev = useRef(value)
  const first = useRef(true)
  const [on, setOn] = useState(false)

  useEffect(() => {
    if (first.current) { first.current = false; prev.current = value; return }
    if (Object.is(prev.current, value)) return
    prev.current = value
    setOn(true)
    const t = setTimeout(() => setOn(false), ms)
    return () => clearTimeout(t)
  }, [value, ms])

  return on
}
