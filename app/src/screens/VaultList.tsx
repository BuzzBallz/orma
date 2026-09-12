import { useState } from 'react'
import type { VaultRow } from '../lib/types'
import { Chip } from '../components/Chip'
import { Countdown } from '../components/Countdown'
import { gradeTone } from '../lib/grades'
import { fmtIso, short } from '../lib/format'
import { useFlash } from '../lib/useFlash'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

type SortKey = 'gradeNumeric' | 'label' | 'phase' | 'secondsToRedemption' | 'navDivergenceBps' | 'loanCount' | 'trend'

/** The row's rail follows the GRADE, because the grade is what ranks risk (contract §2). */
const RAIL: Record<string, string | undefined> = {
  '--bad': 'row-bad', '--warn': 'row-warn', '--ok': undefined, '--fg-dim': undefined,
}

function bpsTone(bps: number): string | undefined {
  if (bps === 0) return 'var(--fg-dim)'
  if (bps < 100) return 'var(--warn)'
  return 'var(--bad)'
}

const GHOSTS = [1, 2, 3, 4, 5]

/**
 * Structural placeholder while no payload has arrived. It carries the shape of the book and
 * nothing else: every figure is an em-dash. No id, no amount, no countdown is invented —
 * a live backend may serve entirely different instruments.
 */
function GhostRow({ n }: { n: number }) {
  return (
    <TableRow className="ghost" aria-hidden>
      <TableCell><span className="ghost-chip" /></TableCell>
      <TableCell>
        <span className="inst">
          <span className="name mute">Vault {n}</span>
          <span className="id">awaiting feed</span>
        </span>
      </TableCell>
      <TableCell className="mute">—</TableCell>
      <TableCell className="rt mute">—</TableCell>
      <TableCell className="rt mute">—</TableCell>
      <TableCell className="rt mute">—</TableCell>
      <TableCell className="rt mute">—</TableCell>
      <TableCell className="mute">—</TableCell>
      <TableCell><span className="ghost-dot" /></TableCell>
    </TableRow>
  )
}

function Row({ v, i, receivedAt, tick, onOpen }: {
  v: VaultRow; i: number; receivedAt: number; tick: number; onOpen: (id: string) => void
}) {
  // Flashes only when the ledger actually moved these figures. Never on a timer.
  const bpsMoved = useFlash(v.navDivergenceBps)
  const navMoved = useFlash(v.navCorrect)
  return (
    <TableRow
      className={RAIL[gradeTone(v.grade)]}
      style={{ cursor: 'pointer', ['--i' as string]: i }}
      tabIndex={0}
      aria-label={`open ${v.label ?? v.vaultId}`}
      onClick={() => onOpen(v.vaultId)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(v.vaultId) } }}
    >
      <TableCell><Chip tone={gradeTone(v.grade)}>{v.grade}</Chip></TableCell>
      <TableCell>
        <span className="inst">
          <span className="name">{v.label ?? short(v.vaultId, 8)}</span>
          <span className="id">{v.vaultId.slice(0, 12)}</span>
        </span>
      </TableCell>
      <TableCell className="mono" style={{ fontSize: 'var(--t-sm)' }}>{v.phase}</TableCell>
      <TableCell className="rt">
        <Countdown seconds={v.secondsToRedemption} receivedAt={receivedAt} tick={tick} mode="boundary" />
      </TableCell>
      <TableCell className={'rt' + (bpsMoved ? ' flash' : '')} style={{ color: bpsTone(v.navDivergenceBps) }}>
        {v.navDivergenceBps} bps
      </TableCell>
      <TableCell className={'rt' + (navMoved ? ' flash' : '')}>
        <span className="pair-naive bare">{v.navNaive}</span>
        <span className="mute"> → </span>
        <span className="pair-correct bare">{v.navCorrect}</span>
      </TableCell>
      <TableCell className="rt">
        {v.loanCount}
        <span style={{ color: v.distressedLoanCount > 0 ? 'var(--bad)' : 'var(--fg-mute)' }}>
          {' / '}{v.distressedLoanCount}
        </span>
      </TableCell>
      <TableCell className="mono" style={{ fontSize: 'var(--t-sm)' }}>{v.trend}</TableCell>
      <TableCell>
        <span
          title={v.oraclePublished ? 'published' : 'not published'}
          style={{
            display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
            background: v.oraclePublished ? 'var(--ok)' : 'var(--fg-mute)',
          }}
        />
      </TableCell>
    </TableRow>
  )
}

type Sort = { key: SortKey; asc: boolean }

/** A sortable header. `aria-sort` is what the audit reads, and what a screen reader announces. */
function Th({ k, label, rt, sort, onSort }: {
  k: SortKey; label: string; rt?: boolean; sort: Sort; onSort: (k: SortKey) => void
}) {
  const on = sort.key === k
  return (
    <TableHead
      className={rt ? 'rt' : undefined}
      style={{ color: on ? 'var(--amber)' : 'var(--amber-dim)' }}
      tabIndex={0}
      aria-sort={on ? (sort.asc ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(k)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(k) } }}
    >{label}{on && <span className="ord">{sort.asc ? '▲' : '▼'}</span>}</TableHead>
  )
}

/**
 * S2 — spec §S2, on shadcn's Table.
 * Default sort is gradeNumeric ASCENDING, worst first (contract §2, and the gate checklist
 * in spec §9). Divergence is a secondary badge, never the sort: an undeclared loss reads
 * 0 bps and a divergence sort buries the most dangerous vault at the bottom.
 */
export function VaultList({ vaults, receivedAt, tick, stamp, onOpen }: {
  vaults: VaultRow[]; receivedAt: number; tick: number
  stamp?: { ledgerIndex: number; serverTime: string }
  onOpen: (vaultId: string) => void
}) {
  const [sort, setSort] = useState<Sort>({ key: 'gradeNumeric', asc: true })

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

  return (
    <section className="panel">
      <div className="row" style={{ marginBottom: 16, alignItems: 'baseline' }}>
        <h2 className="panel-title" style={{ margin: 0 }}>the book</h2>
        <span className="num mute" style={{ fontSize: 'var(--t-xs)' }}>
          {vaults.length > 0 ? `${vaults.length} instruments · worst grade first` : 'awaiting feed · worst grade first'}
        </span>
        <span className="spacer" />
        <span className="caption">
          Sorted worst first. Divergence is the gap between what a vault reports and what it
          holds — and zero is not safety: a loss nobody has declared reads fine on both sides.
        </span>
      </div>
      <div className="tbl-scroll">
        <Table className="tbl">
          <TableHeader>
            <TableRow>
              <Th k="gradeNumeric" label="grade" sort={sort} onSort={toggle} />
              <Th k="label" label="instrument" sort={sort} onSort={toggle} />
              <Th k="phase" label="phase" sort={sort} onSort={toggle} />
              <Th k="secondsToRedemption" label="redemption" rt sort={sort} onSort={toggle} />
              <Th k="navDivergenceBps" label="divergence" rt sort={sort} onSort={toggle} />
              <TableHead className="rt">reported → correct</TableHead>
              <Th k="loanCount" label="loans" rt sort={sort} onSort={toggle} />
              <Th k="trend" label="trend" sort={sort} onSort={toggle} />
              <TableHead>oracle</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0
              ? GHOSTS.map(n => <GhostRow key={n} n={n} />)
              : rows.map((v, i) => (
                <Row key={v.vaultId} v={v} i={i} receivedAt={receivedAt} tick={tick} onOpen={onOpen} />
              ))}
          </TableBody>
        </Table>
      </div>
      {stamp && (
        <div className="readstamp">
          read at ledger <b>{stamp.ledgerIndex}</b> · {fmtIso(stamp.serverTime)} · every figure
          above came from that one response
        </div>
      )}
    </section>
  )
}
