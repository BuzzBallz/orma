import { useState } from 'react'
import type { VaultRow } from '../lib/types'
import { Chip } from '../components/Chip'
import { Countdown } from '../components/Countdown'
import { gradeTone } from '../lib/grades'
import { bpsToPct, short } from '../lib/format'

type SortKey = 'gradeNumeric' | 'label' | 'phase' | 'secondsToRedemption' | 'navDivergenceBps' | 'loanCount' | 'trend'

function bpsTone(bps: number): string | undefined {
  if (bps === 0) return 'var(--fg-dim)'
  if (bps < 100) return 'var(--warn)'
  return 'var(--bad)'
}

/**
 * S2 — spec §S2.
 * Default sort is gradeNumeric ASCENDING, worst first (contract §2, and the gate checklist
 * in spec §9). Divergence is a secondary badge, never the sort: an undeclared loss reads
 * 0 bps and a divergence sort buries the most dangerous vault at the bottom.
 */
export function VaultList({ vaults, receivedAt, tick, onOpen }: {
  vaults: VaultRow[]; receivedAt: number; tick: number; onOpen: (vaultId: string) => void
}) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'gradeNumeric', asc: true })

  const rows = [...vaults].sort((a, b) => {
    const k = sort.key
    const va = k === 'label' ? (a.label ?? a.vaultId) : a[k]
    const vb = k === 'label' ? (b.label ?? b.vaultId) : b[k]
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb))
    return sort.asc ? cmp : -cmp
  })

  function toggle(k: SortKey) {
    setSort(s => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: true }))
  }

  function Th({ k, label, rt }: { k: SortKey; label: string; rt?: boolean }) {
    return (
      <th
        className={rt ? 'rt' : undefined}
        style={{ color: sort.key === k ? 'var(--fg)' : undefined }}
        tabIndex={0}
        aria-sort={sort.key === k ? (sort.asc ? 'ascending' : 'descending') : 'none'}
        onClick={() => toggle(k)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(k) } }}
      >{label}{sort.key === k ? (sort.asc ? ' ▲' : ' ▼') : ''}</th>
    )
  }

  return (
    <section className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 className="panel-title" style={{ margin: 0 }}>five vaults · worst grade first</h2>
        <span className="spacer" />
        <span className="caption">
          a vault can read 0 bps and still be the most dangerous book here — nothing has been declared yet
        </span>
      </div>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <Th k="gradeNumeric" label="grade" />
              <Th k="label" label="vault" />
              <Th k="phase" label="phase" />
              <Th k="secondsToRedemption" label="redemption" rt />
              <Th k="navDivergenceBps" label="divergence" rt />
              <th className="rt">nav naive → correct</th>
              <Th k="loanCount" label="loans" rt />
              <Th k="trend" label="trend" />
              <th>oracle</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(v => (
              <tr
                key={v.vaultId}
                style={{ cursor: 'pointer' }}
                tabIndex={0}
                aria-label={`open ${v.label ?? v.vaultId}`}
                onClick={() => onOpen(v.vaultId)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(v.vaultId) } }}
              >
                <td><Chip tone={gradeTone(v.grade)}>{v.grade}</Chip></td>
                <td>{v.label ?? short(v.vaultId, 8)}</td>
                <td className="mono" style={{ fontSize: 'var(--t-sm)' }}>{v.phase}</td>
                <td className="rt">
                  <Countdown seconds={v.secondsToRedemption} receivedAt={receivedAt} tick={tick} mode="boundary" />
                </td>
                <td className="rt" style={{ color: bpsTone(v.navDivergenceBps) }}>
                  {v.navDivergenceBps} bps · {bpsToPct(v.navDivergenceBps)}
                </td>
                <td className="rt">
                  <span className="pair-naive bare">{v.navNaive}</span>
                  <span className="dim"> → </span>
                  <span className="pair-correct bare">{v.navCorrect}</span>
                </td>
                <td className="rt">
                  {v.loanCount}
                  <span style={{ color: v.distressedLoanCount > 0 ? 'var(--bad)' : 'var(--fg-dim)' }}>
                    {' / '}{v.distressedLoanCount}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: 'var(--t-sm)' }}>{v.trend}</td>
                <td>
                  <span
                    title={v.oraclePublished ? 'published' : 'not published'}
                    style={{
                      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                      background: v.oraclePublished ? 'var(--ok)' : 'var(--fg-dim)',
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
