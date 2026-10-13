import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { compact, dropsToXrp, trimZeros } from '../lib/format'

/** The unit follows the figure, held to it by a no-break space. Marked for the vocabulary audit. */
const Unit = () => <span data-vocab-exempt>{'\u00a0'}XRP</span>

/**
 * An amount in XRP: decimals and the unit, "10 XRP". Only a run of three zeros that the
 * decimals themselves hold ("1000000") is written 1×10⁶, underlined so it can be seen to
 * say more; the cursor over it, or a tap, shows the whole number. Nothing is lost to the
 * compact form but zeros, so a reader without a pointer still has every digit.
 */
export function Amount({ drops }: { drops: string }) {
  const full = trimZeros(dropsToXrp(drops))
  const c = compact(full)
  const [whole, setWhole] = useState(false)
  if (!c) return <>{full}<Unit /></>

  return (
    <>
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="sci" role="img" aria-label={`${full} XRP`} onClick={() => setWhole(w => !w)}>
              {whole ? full : <>{c.mantissa}{c.exp !== 0 && <>×10<sup>{c.exp}</sup></>}</>}
            </span>
          </TooltipTrigger>
          <TooltipContent className="tip" side="top">{full}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Unit />
    </>
  )
}
