import { useState } from 'react'
import { Check, Copy, LogOut } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { useWallet } from '../lib/useWallet'
import { shortAddress } from '../lib/xrpl-address'

/**
 * Top right, and deliberately quiet. Nothing on these pages is behind it: viewing an
 * account only shows its reference, and every figure is shown either way. The dialog it opens
 * lives with the masthead, so the phone menu can close itself and still open it.
 */
export function SignInButton({ onOpen }: { onOpen: () => void }) {
  const { state, disconnect } = useWallet()
  const [copied, setCopied] = useState(false)

  if (state.status !== 'connected') {
    return (
      <button type="button" className="lnk lnk-plain" onClick={onOpen}>
        View an Account
      </button>
    )
  }

  const label = shortAddress(state.address)
  return (
    <span className="wallet" data-picker onKeyDown={e => e.stopPropagation()}>
      <span className="wpill">View only</span>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger className="waddr">{label}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent className="tip" side="bottom">{state.address}</TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" sideOffset={6} data-picker className="picker-list wallet-menu">
          <DropdownMenuLabel className="picker-head">
            View only
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="picker-sep" />
          <DropdownMenuItem
            onSelect={() => {
              navigator.clipboard?.writeText(state.address).then(() => {
                setCopied(true); setTimeout(() => setCopied(false), 1200)
                toast.success('Reference copied', { description: shortAddress(state.address) })
              }, () => toast.error('Could not reach the clipboard'))
            }}
          >
            {copied ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />}
            Copy reference
          </DropdownMenuItem>
          <DropdownMenuItem data-danger onSelect={disconnect}>
            <LogOut size={14} strokeWidth={1.75} /> Stop viewing
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
