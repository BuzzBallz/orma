import type { VaultDetailFields } from '../lib/types'
import { bpsToPct, dropsToXrp } from '../lib/format'

/** bps magnitude -> token. Spec §S1.2. */
function bpsTone(bps: number): string {
  if (bps === 0) return 'var(--fg-dim)'
  if (bps < 100) return 'var(--warn)'
  return 'var(--bad)'
}

/** The one sanctioned Number(): a pixel width. Contract §0.1. */
function barPct(nav: string, reference: string): number {
  const r = Number(reference)
  if (!Number.isFinite(r) || r === 0) return 0
  const pct = (Number(nav) / r) * 100
  if (!Number.isFinite(pct)) return 0
  return Math.max(0, Math.min(100, pct))
}

function Reading({ title, value, formula, pair, tone, width, animate }: {
  title: string; value: string; formula: string
  pair: 'pair-naive' | 'pair-correct'; tone: string; width: number; animate: boolean
}) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0 }}>
      <div className="label">{title}</div>
      <div className={'num ' + pair} style={{ fontSize: 'var(--t-xl)', paddingBottom: 6, marginBottom: 10, marginTop: 8 }}>
        {value}
      </div>
      <div className="caption mono" style={{ marginBottom: 10 }}>{formula}</div>
      <div className={'bar' + (animate ? ' animate' : '')} style={{ ['--bar-tone' as string]: tone }}>
        <i style={{ width: width + '%' }} />
      </div>
    </div>
  )
}

export function NavSplit({ vault }: { vault: VaultDetailFields }) {
  const tone = bpsTone(vault.navDivergenceBps)
  return (
    <section className="panel">
      <h2 className="panel-title">nav per share — two readings of the same vault</h2>

      <div className="readings">
        <Reading
          title="reported"
          value={vault.navNaive}
          formula="AssetsTotal / shares"
          pair="pair-naive"
          tone="var(--muted)"
          width={100}
          animate={false}
        />
        <Reading
          title="correct"
          value={vault.navCorrect}
          formula="(AssetsTotal - LossUnrealized) / shares"
          pair="pair-correct"
          tone="var(--accent)"
          width={barPct(vault.navCorrect, vault.navNaive)}
          animate
        />
      </div>

      <div style={{ textAlign: 'center', marginTop: 32 }}>
        <div className="label">divergence</div>
        <div className="row" style={{ justifyContent: 'center', alignItems: 'baseline', gap: 16, marginTop: 8 }}>
          <span className="num figure-in" style={{ fontSize: 'var(--t-xxl)', color: tone }}>
            {vault.navDivergenceBps}
          </span>
          <span className="num mute" style={{ fontSize: 'var(--t-lg)' }}>bps</span>
          <span className="num" style={{ fontSize: 'var(--t-lg)', color: tone }}>
            {bpsToPct(vault.navDivergenceBps)}
          </span>
        </div>
        {vault.navDivergenceBps === 0 && (
          <div className="caption" style={{ marginTop: 8 }}>
            the two readings agree — because nothing has been declared
          </div>
        )}
      </div>

      <div className="caption mono" style={{ marginTop: 20, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        AssetsTotal {dropsToXrp(vault.assetsTotal)} · AssetsAvailable {dropsToXrp(vault.assetsAvailable)}
        {' '}· LossUnrealized {dropsToXrp(vault.lossUnrealized)} · shares {vault.sharesOutstanding}
      </div>
    </section>
  )
}
