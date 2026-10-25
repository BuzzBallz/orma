import { useContext, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { UNREADABLE, compact, dropsToXrp, inUnit, trimZeros } from '../lib/format'
import { AmountAsset } from '../lib/asset'

/** The unit follows the figure, held to it by a no-break space. Marked for the vocabulary audit. */
const Unit = ({ u }: { u: string }) => <span data-vocab-exempt>{'\u00a0'}{u}</span>

/**
 * An amount in XRP: decimals and the unit, "10 XRP". Only a run of three zeros that the
 * decimals themselves hold ("1000000") is written 1×10⁶, underlined so it can be seen to
 * say more; the cursor over it, a tap, or Enter on it shows the whole number. Nothing is lost to the
 * compact form but zeros, so a reader without a pointer still has every digit.
 */
export function Amount({ drops }: { drops: string }) {
  const asset = useContext(AmountAsset)
  const [whole, setWhole] = useState(false)
  const xrp = !asset || asset.kind === 'XRP'
  const value = xrp ? dropsToXrp(drops) : inUnit(drops)
  if (value === UNREADABLE) return <>{value}</>
  const unit = xrp ? 'XRP' : asset.kind === 'IOU' ? asset.currency : 'units'
  const full = trimZeros(value)
  const c = compact(full)
  if (!c) return <>{full}<Unit u={unit} /></>

  return (
    <>
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A key reaches it too: focusable, Enter or Space toggles the digits. Not a <button>: every button is a .btn. */}
            <span
              className="sci" role="button" tabIndex={0} aria-label={`${full} ${unit}`} aria-pressed={whole}
              onClick={() => setWhole(w => !w)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWhole(w => !w) } }}
            >
              {whole ? full : <>{c.mantissa}{c.exp !== 0 && <>×10<sup>{c.exp}</sup></>}</>}
            </span>
          </TooltipTrigger>
          <TooltipContent className="tip" side="top">{full}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Unit u={unit} />
    </>
  )
}
