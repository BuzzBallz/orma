import { useState } from 'react'
import { Check, Copy, LogOut, Wallet } from 'lucide-react'
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
import { WalletDialog } from './WalletDialog'

/**
 * Topbar, far right. Disconnected it is one button — never "connect to unlock", because
 * nothing on this desk is locked. Connected it is the account and the network, stated,
 * with the full address a hover away (B7) and two real actions behind it (B5).
 */
export function WalletButton() {
  const { state, network, disconnect } = useWallet()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (state.status !== 'connected') {
    return (
      <>
        <Button
          variant="outline" size="xs" className="btn-term btn-press"
          onClick={() => setOpen(true)}
        >
          <Wallet size={12} strokeWidth={2.25} /> connect
        </Button>
        <WalletDialog open={open} onOpenChange={setOpen} />
      </>
    )
  }

  const label = shortAddress(state.address)
  return (
    <span className="wallet" data-picker onKeyDown={e => e.stopPropagation()}>
      <Badge variant="outline" className="pill wpill" style={{ ['--pill-tone' as string]: 'var(--ok)' }}>
        <span className="dot" />
        {state.via === 'read-only' ? 'read-only' : 'connected'}
      </Badge>
      <Badge variant="outline" className="chip wnet" style={{ ['--chip-tone' as string]: 'var(--read-correct)' }}>
        {network}
      </Badge>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger className="picker-btn waddr">
              <span className="num">{label}</span>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {/* B7 — the whole address, because a truncation is not an address. */}
          <TooltipContent className="tip" side="bottom">{state.address}</TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" sideOffset={6} data-picker className="picker-list">
          <DropdownMenuLabel className="label">
            {state.via === 'read-only' ? 'followed read-only' : `via ${state.via}`} · {network}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              navigator.clipboard?.writeText(state.address).then(() => {
                setCopied(true); setTimeout(() => setCopied(false), 1200)
                toast.success('Address copied', { description: shortAddress(state.address) })
              }, () => toast.error('Could not reach the clipboard'))
            }}
          >
            {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2.25} />}
            copy address
          </DropdownMenuItem>
          <DropdownMenuItem data-danger onSelect={disconnect}>
            <LogOut size={12} strokeWidth={2.25} /> disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
