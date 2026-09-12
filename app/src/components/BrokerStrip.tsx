import type { Broker } from '../lib/types'
import { dropsToXrp, ratioToPct, rateToPct } from '../lib/format'

function Cell({ label, value, tone, caption }: { label: string; value: string; tone?: string; caption?: string }) {
  return (
    <div style={{ flex: '1 1 160px', minWidth: 140 }}>
      <div className="panel-title" style={{ margin: 0 }}>{label}</div>
      <div className="num" style={{ fontSize: 'var(--t-md)', color: tone }}>{value}</div>
      {caption && <div className="caption" style={{ marginTop: 2 }}>{caption}</div>}
    </div>
  )
}

export function BrokerStrip({ broker }: { broker: Broker }) {
  return (
    <section className="panel">
      <h2 className="panel-title">broker · first-loss cover</h2>
      <div className="row-wrap" style={{ gap: 24, alignItems: 'flex-start' }}>
        <Cell label="debtTotal" value={dropsToXrp(broker.debtTotal)} />
        <Cell label="debtMaximum" value={dropsToXrp(broker.debtMaximum)} />
        <Cell label="coverAvailable" value={dropsToXrp(broker.coverAvailable)} />
        <Cell label="coverRequired" value={dropsToXrp(broker.coverRequired)} />
        <Cell
          label="coverShortfall"
          value={dropsToXrp(broker.coverShortfall)}
          tone={broker.coverShortfall > '0' ? 'var(--bad)' : undefined}
        />
        <Cell
          label="maxLiquidatableNow"
          value={dropsToXrp(broker.maxLiquidatableNow)}
          caption="after the CoverRateMinimum × CoverRateLiquidation double product"
        />
        <Cell label="coverRateMinimum" value={rateToPct(broker.coverRateMinimum)} />
        <Cell label="coverRateLiquidation" value={rateToPct(broker.coverRateLiquidation)} />
        <Cell label="managementFeeRate" value={rateToPct(broker.managementFeeRate)} />
        <Cell label="strandedCoverFraction" value={ratioToPct(broker.strandedCoverFraction)} />
      </div>
    </section>
  )
}
