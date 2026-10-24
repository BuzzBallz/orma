import type { Mark, Ticket } from '../lib/types'
import { Figure, Panel, Recompute, TestNetBanner, Verdict } from '../components/Ledger'
import type { Figure as FigureDoc } from '../lib/types'

/**
 * Orma Desk, layer 1 of the ticket: the withdrawal value against the value read by all (N1), what each
 * loan's default would cost (N2), when the capital comes back (N3), the largest loan the mandate allows,
 * and the verdict. Every figure is the server's, shown with its ledger inputs and recomputed in place.
 * The /desk route is wired at step 11; until then the smoke renders this screen directly.
 */

export interface DeskTab {
  id: string
  label: string
  /** The API path the tab reads, or null when it polls nothing. */
  source: (ctx: { deskPlan?: unknown; facility?: string }) => string | null
  /** How often the tab is read again, 3 s by default. */
  pollMs?: number
  mustContain: string[]
  mustShowKeys?: string[]
}

export const DESK_TABS: DeskTab[] = [
  { id: 'ticket', label: 'Ticket', source: () => null, mustContain: ['Withdrawal value', 'Value read by all', 'Test network'] },
]

function Line({ label, meaning, figure }: { label: string; meaning: string; figure: FigureDoc }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <Figure label={label} meaning={meaning} figure={figure} />
      <Recompute figure={figure} />
    </div>
  )
}

/** `data`, the answer of the current tab's source, is read by the tabs step 11 adds; the ticket tab needs none. */
export function DeskScreen({ ticket, mark, tab }: { ticket: Ticket | null; mark: Mark | null; tab: string; data?: unknown }) {
  const f = ticket?.figures
  return (
    <main style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <TestNetBanner />
      <h1 className="exh-title">Credit desk · loan against closed-ended vault shares</h1>
      {tab !== 'ticket' ? null : !ticket || !f ? (
        <p className="caption">Reading the ticket at the last validated ledger…</p>
      ) : (
        <>
          <p className="caption">
            Ticket {ticket.ticketId.slice(0, 16)} · read at ledger {ticket.ledgerIndex} · {ticket.share.units} share units of {ticket.share.mptId}
            {mark && <> · nav pointer check: {mark.verdict}</>}
          </p>

          <Panel provenance={f.heldValue.provenance} title="N1 · What the shares are worth" source="Orma">
            <Line label="Withdrawal value" meaning="What these units redeem for at the XLS-65 withdraw rate: the vault's assets net of the loss it has recognised." figure={f.heldValue} />
            <Line label="Value read by all" meaning="AssetsTotal / shares: what a reader that ignores recognised loss quotes for the same units." figure={f.naiveValue} />
            <Line label="Overpayment if valued at the value read by all" meaning="What a lender would overpay by pricing these units at the value read by all." figure={f.n1Overpayment} />
          </Panel>

          <Panel provenance="MODELLED" title="N2 · If a loan of the vault defaults" source="Orma">
            {f.n2.length === 0 && <p className="caption">The vault has no outstanding loan.</p>}
            {f.n2.map((e) => (
              <div key={e.loanId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                <p className="caption"><b>{e.label}</b> · {e.scenario}</p>
                {e.alreadyInHeld
                  ? <p className="caption">Loss after cover: already in the withdrawal value (impaired).</p>
                  : <Line label="Loss after cover" meaning="What the pledged units lose at the withdrawal value if this loan defaults, after the first-loss cover." figure={e.lossAfterCover} />}
                <Line label="First-loss cover liquidated" meaning="The broker's cover the vault receives on this default." figure={e.cover} />
                <Line label="Withdrawal value per unit after default" meaning="The withdraw rate once this default is recognised." figure={e.heldPerUnitIfDefault} />
              </div>
            ))}
          </Panel>

          <Panel provenance="REAL" title="N3 · When the capital comes back" source="Orma">
            <Line label="Locked until redemption" meaning="Time left before the vault's redemption date: the capital stays committed until then, as the first institutional clients asked." figure={f.n3.lockedUntil} />
            <p className="caption">Redemption opens {f.n3.redemptionAt}.</p>
            <Line label="Cash available in the vault" meaning="The vault's assets not lent out." figure={f.n3.cashAvailable} />
            <Line label="Claim at redemption" meaning="What these units claim at the withdrawal value." figure={f.n3.claim} />
          </Panel>

          {f.maxLoan && (
            <Panel provenance="MODELLED" title="Largest loan the mandate allows">
              <Line label="Maximum loan" meaning="The mandate's loan-to-value limit applied to the withdrawal value." figure={f.maxLoan} />
              {f.requested && <Line label="Loan requested" meaning="The principal of the planned loan." figure={f.requested} />}
              {f.ltvHeld && <Line label="Loan-to-value at the withdrawal value" meaning="Requested principal over the withdrawal value of the pledged units." figure={f.ltvHeld} />}
              {f.lender1to1 && <Line label="Loan-to-value for a lender at 1:1" meaning="Requested principal over the units valued at one XRP each, as a lender pricing shares at par would." figure={f.lender1to1} />}
            </Panel>
          )}

          <Panel provenance="DECLARED" title="Mandate of the risk officer">
            <p className="caption">Mandate {ticket.mandate.id} · hash {ticket.mandate.hash} · anchored by {ticket.mandate.anchorTx}</p>
          </Panel>

          <Panel provenance="MODELLED" title="Verdict">
            <p><Verdict status={ticket.verdict.status} /></p>
            {ticket.verdict.breaches.map((b) => (
              <p key={b.limit} className="caption">{b.limit}: {b.value} over the limit of {b.threshold}</p>
            ))}
            {ticket.verdict1to1 && <p className="caption">For a lender at 1:1: <Verdict status={ticket.verdict1to1.status} /></p>}
          </Panel>
        </>
      )}
    </main>
  )
}
