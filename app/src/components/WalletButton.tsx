import { useState } from 'react'
import { Check, Copy, LogOut, UserRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { useWallet } from '../lib/wallet'
import { shortAddress } from '../lib/xrpl-address'
import { SignInDialog } from './WalletDialog'

/**
 * Top right, and deliberately quiet. Nothing on these pages is behind it: signing in
 * records who is reading, and every figure is shown either way.
 */
export function SignInButton() {
  const { state, disconnect, prefetch } = useWallet()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (state.status !== 'connected') {
    return (
      <>
        <Button
          variant="outline" size="xs" className="btn-term btn-press"
          onMouseEnter={prefetch}
          onFocus={prefetch}
          onClick={() => { prefetch(); setOpen(true) }}
        >
          <UserRound size={12} strokeWidth={2.25} /> Sign In
        </Button>
        <SignInDialog open={open} onOpenChange={setOpen} />
      </>
    )
  }

  const label = shortAddress(state.address)
  return (
    <span className="wallet" data-picker onKeyDown={e => e.stopPropagation()}>
      <Badge variant="outline" className="pill wpill" style={{ ['--pill-tone' as string]: 'var(--ok)' }}>
        <span className="dot" />
        {state.via === 'read-only' ? 'view only' : 'signed in'}
      </Badge>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger className="picker-btn waddr">
              <span className="num">{label}</span>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent className="tip" side="bottom">{state.address}</TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" sideOffset={6} data-picker className="picker-list">
          <DropdownMenuLabel className="label">
            {state.via === 'read-only' ? 'view only' : 'session'}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              navigator.clipboard?.writeText(state.address).then(() => {
                setCopied(true); setTimeout(() => setCopied(false), 1200)
                toast.success('Reference copied', { description: shortAddress(state.address) })
              }, () => toast.error('Could not reach the clipboard'))
            }}
          >
            {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2.25} />}
            copy reference
          </DropdownMenuItem>
          <DropdownMenuItem data-danger onSelect={disconnect}>
            <LogOut size={12} strokeWidth={2.25} /> sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
