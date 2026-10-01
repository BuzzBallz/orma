import { useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { compact, dropsToXrp } from '../lib/format'

/**
 * An amount, without its run of zeros. 41.000000 reads 4.1×10¹, underlined so it can be
 * seen to say more; the cursor over it, or a tap, shows the whole number. Nothing is lost
 * to the compact form but zeros, so a reader without a pointer still has every digit.
 * An amount with no run of zeros is plain text.
 */
export function Amount({ drops }: { drops: string }) {
  const full = dropsToXrp(drops)
  const c = compact(full)
  const [whole, setWhole] = useState(false)
  if (!c) return <>{full}</>

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="sci" role="img" aria-label={full} onClick={() => setWhole(w => !w)}>
            {whole ? full : <>{c.mantissa}{c.exp !== 0 && <>×10<sup>{c.exp}</sup></>}</>}
          </span>
        </TooltipTrigger>
        <TooltipContent className="tip" side="top">{full}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
