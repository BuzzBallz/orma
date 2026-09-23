import { ArrowRight } from 'lucide-react'
import type { VaultRow } from '../lib/types'
import { GradeLetter } from '../components/GradeLetter'
import { FacilityPicker } from '../components/VaultPicker'
import { Scale } from '../components/Scale'
import { GRADE_LADDER, gradeIndex } from '../lib/grades'
import { useFlash } from '../lib/useFlash'
import { facilityName, outlookOf } from '../lib/credit'
import { fmtIso } from '../lib/format'
import { follow, hrefFor, type RoutePath } from '../lib/useRoute'

/** No gap, a small one, a material one. Only a gap is ever coloured. */
function gapTone(bps: number): string {
  if (bps === 0) return 'mute'
  if (bps < 100) return 'watch'
  return 'loss'
}

/**
 * The key figures, for the facility whose reported and held values sit furthest apart:
 * the gap is the reason this service exists, so the widest one is the first thing shown.
 * With nothing on file, the same block reads em-dash throughout.
 */
function KeyFigures({ v, asOf, onOpen }: {
  v: VaultRow | null; asOf: string | null; onOpen: (vaultId: string) => void
}) {
  const i = v ? gradeIndex(v.grade) : -1
  return (
    <section className="kf" aria-label={v ? `Key figures, ${facilityName(v)}` : 'Key figures'}>
      {v ? (
        <a className="kf-head" href={hrefFor('/facility', v.vaultId)} onClick={e => follow(e, () => onOpen(v.vaultId))}>
          <span className="kf-name">{facilityName(v)}</span>
          <GradeLetter grade={v.grade} size="sm" />
        </a>
      ) : (
        <div className="kf-head"><span className="kf-name mute">—</span></div>
      )}
      <span className="kf-k t-label-s mute">Held unit value</span>
      {/* Keyed on the figure, so a new value fades in once instead of changing in place. */}
      <span className="kf-fig t-fig-display" key={v?.navCorrect}>{v?.navCorrect ?? '—'}</span>
      <dl className="kf-rows">
        <div><dt>Reported unit value</dt><dd className="dim">{v?.navNaive ?? '—'}</dd></div>
        <div>
          <dt>Reported vs held</dt>
          <dd className={v ? gapTone(v.navDivergenceBps) : 'mute'}>{v ? `${v.navDivergenceBps} bps` : '—'}</dd>
        </div>
        <div>
          <dt>Internal Score</dt>
          <dd>{v && i >= 0 ? <><GradeLetter grade={v.grade} size="sm" /> · {i + 1} of {GRADE_LADDER.length}</> : '—'}</dd>
        </div>
      </dl>
      <span className="kf-stamp t-fig-s mute">As of {asOf ? fmtIso(asOf) : '—'}</span>
    </section>
  )
}

/** One facility: a table row on a wide screen, a card on a phone. Same link either way. */
function Row({ v, onOpen }: { v: VaultRow; onOpen: (vaultId: string) => void }) {
  const gapMoved = useFlash(v.navDivergenceBps, 1200)
  const navMoved = useFlash(v.navCorrect, 1200)
  const n = v.loanCount
  return (
    <li>
      <a
        className={'frow' + (gapMoved || navMoved ? ' flash' : '')}
        href={hrefFor('/facility', v.vaultId)}
        onClick={e => follow(e, () => onOpen(v.vaultId))}
      >
        <span className="frow-grade"><GradeLetter grade={v.grade} size="xl" /></span>
        <span className="frow-id">
          <span className="frow-name">{facilityName(v)}</span>
          <span className="frow-meta">{n} exposure{n === 1 ? '' : 's'} · {v.distressedLoanCount} non-performing</span>
        </span>
        <span className="frow-rh">
          <span className="rep">{v.navNaive}</span><span className="vs">vs</span><span className="held">{v.navCorrect}</span>
        </span>
        <span className="frow-held"><span className="k">Held</span><span className="v">{v.navCorrect}</span></span>
        <span className={'frow-gap ' + gapTone(v.navDivergenceBps)}><span className="k">Gap</span>{v.navDivergenceBps} bps</span>
        <span className="frow-status">
          <span className="frow-rep">Reported <span className="v">{v.navNaive}</span></span>
          <span className="ph-o"><span>{v.phase}</span><span className="o">Outlook {outlookOf(v.trend)}</span></span>
        </span>
      </a>
    </li>
  )
}

/**
 * The portfolio. What the service is, in one line; the widest gap on file; then every
 * facility, weakest internal score first — a credit committee reads the worst name first.
 */
export function Portfolio({ vaults, asOf, onOpen, onNavigate }: {
  vaults: VaultRow[]; asOf: string | null
  onOpen: (vaultId: string) => void
  onNavigate: (path: RoutePath) => void
}) {
  const featured = vaults.length
    ? vaults.reduce((a, b) => (b.navDivergenceBps > a.navDivergenceBps ? b : a))
    : null
  const n = vaults.length

  return (
    <>
      <section className="wrap hero">
        <div className="grid12 hero-grid">
          <div className="hero-copy">
            <h1 className="t-display-xl">Credit opinions<br /> on lending facilities.</h1>
            <p className="t-body-l hero-lede">
              Reported value is what the facility states; held value is what it owns once a
              recognised loss is taken off.
            </p>
            <div className="hero-ctas">
              <FacilityPicker vaults={vaults} activeVaultId={null} onSelect={onOpen} variant="cta" />
              <a className="lnk" href="/methodology" onClick={e => follow(e, () => onNavigate('/methodology'))}>
                Methodology <ArrowRight size={16} strokeWidth={1.75} aria-hidden />
              </a>
            </div>
          </div>
          <div className="hero-kf">
            <KeyFigures v={featured} asOf={asOf} onOpen={onOpen} />
          </div>
        </div>
      </section>

      <section className="wrap">
        <Scale grade={featured?.grade} label={false} />
      </section>

      <section className="wrap book" aria-labelledby="book-title">
        <div className="book-head">
          <h2 className="t-display-l" id="book-title">Portfolio</h2>
          {n > 0 && <span className="t-body-s mute">{n} Facilit{n === 1 ? 'y' : 'ies'} · Weakest First</span>}
        </div>
        <div className="book-cols" aria-hidden>
          <span>Internal Score</span><span>Facility</span>
          <span className="rt">Reported vs Held</span><span className="rt">Gap</span><span>Status</span>
        </div>
        {n > 0
          ? <ul className="book-list">{vaults.map(v => <Row key={v.vaultId} v={v} onOpen={onOpen} />)}</ul>
          : <p className="book-empty">No facility is on file yet.</p>}
        <p className="quote t-quote">A zero gap is not safety. It means the two figures agree.</p>
      </section>
    </>
  )
}
