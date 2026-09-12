import type { VaultDetail as Detail } from '../lib/types'
import { PhaseBanner } from '../components/PhaseBanner'
import { NavSplit } from '../components/NavSplit'
import { ScoreVector } from '../components/ScoreVector'
import { NotchTrace } from '../components/NotchTrace'
import { AlertList } from '../components/AlertList'
import { LoanTable } from '../components/LoanTable'
import { BrokerStrip } from '../components/BrokerStrip'

/** S1 — spec §S1. One poll of /api/vaults/:id paints all of it. */
export function VaultDetail({ d, receivedAt, tick }: { d: Detail; receivedAt: number; tick: number }) {
  return (
    <div className="stack">
      <PhaseBanner vault={d.vault} phaseInfo={d.phaseInfo} receivedAt={receivedAt} tick={tick} />

      <div className="grid12">
        <div className="col-1-7"><NavSplit vault={d.vault} /></div>
        <div className="col-8-12"><ScoreVector score={d.score} /></div>
        <div className="col-1-7"><NotchTrace trace={d.score.notchTrace} /></div>
        <div className="col-8-12"><AlertList alerts={d.alerts} /></div>
      </div>

      <LoanTable loans={d.loans} receivedAt={receivedAt} tick={tick} />
      <BrokerStrip broker={d.broker} />
    </div>
  )
}
