import type { PhaseInfo, VaultRow } from '../lib/types'
import { Chip } from './Chip'
import { Countdown } from './Countdown'
import { fmtIso } from '../lib/format'

/** Spec §S1.1. The tecTOO_SOON line is a protocol FACT, never an error state. */
export function PhaseBanner({ vault, phaseInfo, receivedAt, tick }: {
  vault: VaultRow; phaseInfo: PhaseInfo; receivedAt: number; tick: number
}) {
  const passed = phaseInfo.secondsToNextBoundary <= 0
  return (
    <section className="panel" style={{ padding: 0 }}>
      <div className="row-wrap" style={{ minHeight: 72, padding: '16px 20px', gap: 24 }}>
        <div style={{ fontSize: 'var(--t-lg)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {vault.phase}
        </div>

        <div className="row" style={{ gap: 12 }}>
          <span className="caption">deposits</span>
          <Chip tone={phaseInfo.canDeposit ? '--ok' : '--warn'}>{phaseInfo.canDeposit ? 'open' : 'closed'}</Chip>
          <span className="caption">withdrawals</span>
          <Chip tone={phaseInfo.canWithdraw ? '--ok' : '--warn'}>{phaseInfo.canWithdraw ? 'open' : 'closed'}</Chip>
        </div>

        <span className="spacer" />

        <div style={{ textAlign: 'right' }}>
          <div className="label">{passed ? 'boundary passed' : 'next boundary'}</div>
          <div style={{ fontSize: 'var(--t-lg)', marginTop: 4 }}>
            <Countdown seconds={phaseInfo.secondsToNextBoundary} receivedAt={receivedAt} tick={tick} mode="boundary" />
          </div>
          <div className="caption mono">{fmtIso(phaseInfo.nextBoundaryAt)}</div>
        </div>
      </div>

      {phaseInfo.canWithdraw === false && (
        <div style={{
          borderTop: '1px solid var(--line)', padding: '10px 20px',
          color: 'var(--fg-dim)', fontSize: 'var(--t-sm)',
        }}>
          Withdrawals are blocked for the entire {vault.phase} phase. The ledger returns{' '}
          <span className="mono" style={{ color: 'var(--read-correct)' }}>
            {phaseInfo.withdrawBlockedReason ?? 'tecTOO_SOON'}
          </span>{' '}
          — this is the protocol working as designed, not a failure.
        </div>
      )}
    </section>
  )
}
