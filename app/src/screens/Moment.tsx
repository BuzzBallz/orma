import { useEffect, useState } from 'react'
import type { IndexerRace, VaultDetail as Detail } from '../lib/types'
import { usePoll } from '../lib/usePoll'
import { useSamples } from '../lib/samples'
import { Sparkline } from '../components/Sparkline'
import { OraclePanel } from '../components/OraclePanel'
import { GatePanel } from '../components/GatePanel'
import { Chip } from './../components/Chip'
import { bpsToPct } from '../lib/format'

const HEIGHTS = [240, 210, 180, 110]

function Band({ n, beat, children, footer }: {
  n: number; beat: number; children: React.ReactNode; footer?: React.ReactNode
}) {
  const lit = beat === 0 || beat === n
  return (
    <section
      className="panel moment-band"
      style={{
        height: HEIGHTS[n - 1],
        opacity: lit ? 1 : 0.28,
        transform: beat === n ? 'translateY(-2px)' : 'none',
        outline: beat === n ? '1px solid var(--read-correct)' : undefined,
        outlineOffset: beat === n ? '-1px' : undefined,
        transition: 'opacity 200ms linear',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{children}</div>
      {footer && <div style={{ flex: '0 0 auto' }}>{footer}</div>}
    </section>
  )
}

function Reader({ title, value, formula, pair }: {
  title: string; value: string; formula: string; pair: 'pair-naive' | 'pair-correct'
}) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0 }}>
      <div className="label">{title}</div>
      <div className={'num ' + pair} style={{ fontSize: 'var(--t-xl)', paddingBottom: 6, marginTop: 8 }}>{value}</div>
      <div className="caption mono" style={{ marginTop: 6 }}>{formula}</div>
    </div>
  )
}

/** S3 — spec §S3. One viewport, no scrolling at 1440x900. Four fixed bands. */
export function Moment({ d, receivedAt, tick }: { d: Detail; receivedAt: number; tick: number }) {
  const [beat, setBeat] = useState(0)

  // Optional by contract (§0.0 A1): fetched on mount, retried every 30s, degrades to the detail payload.
  const race = usePoll<IndexerRace>('/api/indexer-race', 30000)
  const r = race.data

  const samples = useSamples(d.vault.vaultId, d.vault.navNaive, d.vault.navCorrect, receivedAt)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === ' ') { e.preventDefault(); setBeat(b => (b >= 4 ? 0 : b + 1)) }
      else if (e.key === 'Backspace') { e.preventDefault(); setBeat(b => (b <= 0 ? 4 : b - 1)) }
      else if (e.key === '0') setBeat(0)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const naiveFormula = r?.readings.naive.formula ?? 'AssetsTotal / shares'
  const correctFormula = r?.readings.correct.formula ?? '(AssetsTotal - LossUnrealized) / shares'
  const prev = r?.vaultNode.previousFields ?? {}
  const final = r?.vaultNode.finalFields ?? {
    AssetsTotal: d.vault.assetsTotal,
    AssetsAvailable: d.vault.assetsAvailable,
    LossUnrealized: d.vault.lossUnrealized,
  }
  const impaired = d.loans.find(l => l.status === 'impaired') ?? d.loans[0]

  return (
    <div className="stack">
      {/* BAND 1 — THE TWO READERS */}
      <Band n={1} beat={beat}>
        <div className="readings">
          <Reader title="indexer a — the obvious reading" value={d.vault.navNaive}
            formula={naiveFormula} pair="pair-naive" />
          <div style={{ flex: '0 0 auto', textAlign: 'center', padding: '0 16px' }}>
            <div className="num figure-in" style={{ fontSize: 'var(--t-hero)', lineHeight: 1, color: d.vault.navDivergenceBps === 0 ? 'var(--fg-mute)' : 'var(--bad)' }}>
              {d.vault.navDivergenceBps}
            </div>
            <div className="caption num">bps · {bpsToPct(d.vault.navDivergenceBps)}</div>
          </div>
          <Reader title="our reader" value={d.vault.navCorrect}
            formula={correctFormula} pair="pair-correct" />
        </div>
        <Sparkline samples={samples} height={92} />
      </Band>

      {/* BAND 2 — THE TRANSACTION THAT CAUSED IT */}
      <Band
        n={2} beat={beat}
        footer={
          <div className="caption">
            {r?.finding ?? 'A declared loss lives in LossUnrealized, which metadata diffing does not surface.'}
          </div>
        }
      >
        <div className="row" style={{ alignItems: 'flex-start', gap: 32 }}>
          <div style={{ flex: '0 0 200px' }}>
            <div className="label">previousFields</div>
            <div className="num" style={{ fontSize: 'var(--t-lg)', color: 'var(--bad)', marginTop: 8 }}>
              {Object.keys(prev).length === 0 ? '{}' : JSON.stringify(prev)}
            </div>
          </div>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div className="label">finalFields</div>
            <pre className="mono" style={{ margin: '8px 0 0', fontSize: 'var(--t-xs)', lineHeight: 1.4, color: 'var(--bad)' }}>
{JSON.stringify(final, null, 1)}
            </pre>
          </div>
          <div style={{ flex: '0 0 260px', textAlign: 'right' }}>
            <Chip tone="--ok">{r?.transactionResult ?? 'tesSUCCESS'}</Chip>
            {impaired && (
              <div style={{ marginTop: 10 }}>
                <a className="mono caption" href={impaired.explorerUrl} target="_blank" rel="noreferrer">
                  open the loan on devnet.xrpl.org
                </a>
              </div>
            )}
          </div>
        </div>
      </Band>

      {/* BAND 3 — WE PUBLISH IT */}
      <Band n={3} beat={beat}>
        <h2 className="panel-title">we publish it — oracle</h2>
        <OraclePanel oracle={d.oracle} receivedAt={receivedAt} tick={tick} />
      </Band>

      {/* BAND 4 — THE GATE */}
      <Band n={4} beat={beat}>
        <GatePanel vault={d.vault} phaseInfo={d.phaseInfo} score={d.score} />
      </Band>

    </div>
  )
}
