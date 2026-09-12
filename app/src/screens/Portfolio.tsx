import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { VaultRow } from '../lib/types'
import { Chip } from '../components/Chip'
import { Countdown } from '../components/Countdown'
import { gradeTone, gradeIndex, GRADE_LADDER } from '../lib/grades'
import { useFlash } from '../lib/useFlash'
import { facilityName, outlookOf } from '../lib/credit'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

type SortKey = 'gradeNumeric' | 'label' | 'phase' | 'navDivergenceBps' | 'secondsToRedemption' | 'trend'
type Sort = { key: SortKey; asc: boolean }

/** Weakest internal score first — the order the credit committee reads in. */
const DEFAULT_SORT: Sort = { key: 'gradeNumeric', asc: true }

const RAIL: Record<string, string | undefined> = {
  '--bad': 'row-bad', '--warn': 'row-warn', '--ok': undefined, '--fg-dim': undefined,
}

function gapTone(bps: number): string | undefined {
  if (bps === 0) return 'var(--fg-dim)'
  if (bps < 100) return 'var(--warn)'
  return 'var(--bad)'
}

const SLOTS = [1, 2, 3, 4, 5]

function Th({ k, label, rt, sort, onSort }: {
  k: SortKey; label: string; rt?: boolean; sort: Sort; onSort: (k: SortKey) => void
}) {
  const on = sort.key === k
  return (
    <TableHead
      className={rt ? 'rt' : undefined}
      style={{ color: on ? 'var(--amber)' : undefined }}
      tabIndex={0}
      aria-sort={on ? (sort.asc ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(k)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(k) } }}
    >{label}{on && <span className="ord">{sort.asc ? '▲' : '▼'}</span>}</TableHead>
  )
}

/** A line held open for a facility we have not been sent figures for. */
function EmptyRow({ n, onOpen }: { n: number; onOpen: () => void }) {
  return (
    <TableRow
      className="ghost" tabIndex={0} style={{ cursor: 'pointer' }}
      aria-label={`facility slot ${n}, figures withheld`}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <TableCell>
        <span className="inst">
          <span className="name mute">Facility {n}</span>
          <span className="id">figures withheld</span>
        </span>
      </TableCell>
      <TableCell className="num mute">—</TableCell>
      <TableCell className="rt num mute">—</TableCell>
      <TableCell className="rt num mute">—</TableCell>
    </TableRow>
  )
}

function Row({ v, i, receivedAt, tick, onOpen }: {
  v: VaultRow; i: number; receivedAt: number; tick: number; onOpen: (id: string) => void
}) {
  const gapMoved = useFlash(v.navDivergenceBps)
  const navMoved = useFlash(v.navCorrect)
  return (
    <TableRow
      className={RAIL[gradeTone(v.grade)]}
      style={{ cursor: 'pointer', ['--i' as string]: i }}
      tabIndex={0}
      aria-label={`open ${facilityName(v)}`}
      onClick={() => onOpen(v.vaultId)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(v.vaultId) } }}
    >
      <TableCell>
        <span className="inst">
          <span className="name">{facilityName(v)}</span>
          <span className="id">
            {v.loanCount} exposure{v.loanCount === 1 ? '' : 's'} · {v.distressedLoanCount} non-performing
          </span>
        </span>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild><span><Chip tone={gradeTone(v.grade)}>{v.grade}</Chip></span></TooltipTrigger>
          <TooltipContent className="tip" side="right">
            <b>{v.grade}</b> — step {gradeIndex(v.grade) + 1} of {GRADE_LADDER.length} on the
            internal scale. AAA is the strongest, D the weakest. The portfolio is ordered
            weakest first.
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="mono" style={{ fontSize: 'var(--t-sm)' }}>{v.phase}</TableCell>
      <TableCell className={'rt' + (navMoved || gapMoved ? ' flash' : '')}>
        <span className="pair-naive bare">{v.navNaive}</span>
        <span className="mute"> vs </span>
        <span className="pair-correct bare">{v.navCorrect}</span>
        <span className="num" style={{ color: gapTone(v.navDivergenceBps), marginLeft: 10 }}>
          {v.navDivergenceBps} bps
        </span>
      </TableCell>
      <TableCell className="rt">
        <Countdown seconds={v.secondsToRedemption} receivedAt={receivedAt} tick={tick} mode="boundary" />
      </TableCell>
      <TableCell className="mono" style={{ fontSize: 'var(--t-sm)' }}>{outlookOf(v.trend)}</TableCell>
    </TableRow>
  )
}

/**
 * The portfolio blotter. Five facilities, weakest internal score first — a credit
 * committee reads the worst name first, and the gap between reported and held value is
 * the reason this note exists.
 */
export function Portfolio({ vaults, receivedAt, tick, stamp, status, onOpen }: {
  vaults: VaultRow[]; receivedAt: number; tick: number
  stamp?: { ledgerIndex: number; serverTime: string }
  status?: { ageMs: number; fails: number; error: string | null; railOnScreen?: boolean }
  onOpen: (vaultId: string) => void
}) {
  const withheld = vaults.length === 0
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT)
  const sorted = sort.key !== DEFAULT_SORT.key || sort.asc !== DEFAULT_SORT.asc

  const rows = [...vaults].sort((a, b) => {
    const k = sort.key
    const va = k === 'label' ? facilityName(a) : a[k]
    const vb = k === 'label' ? facilityName(b) : b[k]
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb : String(va).localeCompare(String(vb))
    return sort.asc ? cmp : -cmp
  })

  function toggle(k: SortKey) {
    setSort(s => (s.key === k ? { key: k, asc: !s.asc } : { key: k, asc: true }))
  }

  return (
    <section className="panel blotter">
      <div className="row" style={{ marginBottom: 16, alignItems: 'baseline' }}>
        <h2 className="panel-title" style={{ margin: 0 }}>portfolio</h2>
        <span className="num mute" style={{ fontSize: 'var(--t-xs)' }}>
          {withheld ? 'figures withheld · weakest first' : `${vaults.length} facilities · weakest first`}
        </span>
        {sorted && (
          <Button variant="ghost" size="xs" className="btn-term" onClick={() => setSort(DEFAULT_SORT)}>
            <RotateCcw size={11} strokeWidth={2.25} /> weakest first
          </Button>
        )}
        <span className="spacer" />
      </div>

      <div className="tbl-scroll">
        <Table className="tbl">
          <TableHeader>
            {withheld ? (
              <TableRow>
                <TableHead>facility</TableHead>
                <TableHead>internal score</TableHead>
                <TableHead className="rt">reported vs held</TableHead>
                <TableHead className="rt">outlook</TableHead>
              </TableRow>
            ) : (
              <TableRow>
                <Th k="label" label="facility" sort={sort} onSort={toggle} />
                <Th k="gradeNumeric" label="internal score" sort={sort} onSort={toggle} />
                <Th k="phase" label="status" sort={sort} onSort={toggle} />
                <Th k="navDivergenceBps" label="reported vs held" rt sort={sort} onSort={toggle} />
                <Th k="secondsToRedemption" label="next event" rt sort={sort} onSort={toggle} />
                <Th k="trend" label="outlook" sort={sort} onSort={toggle} />
              </TableRow>
            )}
          </TableHeader>
          <TableBody>
            {withheld
              ? SLOTS.map(n => <EmptyRow key={n} n={n} onOpen={() => onOpen('')} />)
              : rows.map((v, i) => (
                <Row key={v.vaultId} v={v} i={i} receivedAt={receivedAt} tick={tick} onOpen={onOpen} />
              ))}
          </TableBody>
        </Table>
      </div>

      <p className="caption blotter-say">
        Reported value is what the facility states; held value is what it owns once a
        recognised loss is taken off.
      </p>

      <div className="tbl-fill" aria-hidden />

      {!stamp && !status?.railOnScreen && (
        <div className="readstamp">
          <span className="label">status</span> <b>figures withheld</b>
        </div>
      )}
    </section>
  )
}
