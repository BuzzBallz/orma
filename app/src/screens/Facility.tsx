import type { ReactNode } from 'react'
import type { BrokerHistory, Collateral, Dimension, Gate, NavHistory, OracleContest, Resolution, VaultDetail } from '../lib/types'
import { GradeLetter } from '../components/GradeLetter'
import { Scale } from '../components/Scale'
import { NavChart } from '../components/NavChart'
import { Exhibit } from '../components/Exhibit'
import { Mark } from '../components/Lockup'
import { gradeIndex } from '../lib/grades'
import { nextBeat } from '../lib/beats'
import { useFlash } from '../lib/useFlash'
import { bpsToPct, dropsToXrp, duration, fmtIso, ratioToPct, rateToPct } from '../lib/format'
import { creditText, facilityName, facilityRef, factorRows, outlookOf, sentence, splitFactors } from '../lib/credit'
import { ManagerConduct, PledgedCollateral } from './FacilityExhibits'
import { PledgeResolution } from './PledgeResolution'
import { EntryGate } from './EntryGate'
import { OracleObject } from './OracleObject'

/** One figure at a glance. Figures are set in mono; phrases in sans, so they wrap on words. */
function Glance({ k, v, phrase, tone, className, moved }: {
  k: string; v: ReactNode; phrase?: boolean; tone?: string; className?: string; moved?: boolean
}) {
  return (
    <div className={[className, moved && 'flash'].filter(Boolean).join(' ') || undefined}>
      <dt>{k}</dt>
      <dd className={[phrase && 'phrase', tone].filter(Boolean).join(' ') || undefined}>{v ?? 'n.a.'}</dd>
    </div>
  )
}

/** Alert severity, in the three tones this product has. */
const SEVERITY: Record<string, string> = { critical: 'loss', high: 'loss', medium: 'watch' }

/** A measured factor, as a credit note lists it: the name, then the score and the reason. */
function FactorItem({ d }: { d: Dimension }) {
  return (
    <div className="op-item">
      <b>{creditText(d.label)}</b>
      <span>Scored {d.grade}. {sentence(creditText(d.explain))}</span>
    </div>
  )
}

const GLANCE_KEYS = ['Reported', 'Gap', 'Internal Score', 'Outlook', 'Status', 'Scored At', 'Coverage', 'Remaining Term', 'Exposures']

/**
 * The credit opinion with every field held open. A reader arriving at a withheld desk
 * should be looking at the shape figures will arrive into, with one note saying why it is
 * empty, not at a different page.
 */
export function FacilityPlaceholder({ name, picker, children }: {
  name?: string; picker?: ReactNode; children?: ReactNode
}) {
  return (
    <>
      <header className="wrap op-head">
        <div className="op-kind">
          <span className="t-label-s mute">Credit Opinion</span>
          <span className="t-fig-s mute">—</span>
        </div>
        <h1 className={'t-display-l' + (name ? '' : ' mute')}>{name ?? '—'}</h1>
        <p className="t-body-m dim">Lending facility · — · internal score — · outlook —</p>
        {picker && <div className="op-pick">{picker}</div>}
      </header>
      {children && <section className="wrap state-slot">{children}</section>}
      <section className="wrap op-band op-placeholder" aria-label="Key figures">
        <div className="op-band-in grid12">
          <div className="op-held">
            <span className="t-label-s mute">Held</span>
            <span className="t-fig-display">—</span>
          </div>
          <dl className="op-glance">
            {GLANCE_KEYS.map(k => <Glance key={k} k={k} v="n.a." phrase />)}
          </dl>
        </div>
      </section>
      <section className="wrap op-scale"><Scale /></section>
    </>
  )
}

/**
 * Credit opinion. The structure is the one a credit committee expects — the reading, the
 * summary, strengths and challenges, the outlook and why the score sits where it does,
 * then the exhibits. Every figure in it is a figure the calculation agent sent. Where a
 * figure was not sent, the line reads n.a. and nothing is inferred to fill it.
 */
export function Facility({ d, history, collateral, resolution, gate, contest, navHistory, picker }: {
  d: VaultDetail
  history?: BrokerHistory | null
  collateral?: Collateral | null
  resolution?: Resolution | null
  gate?: Gate | null
  contest?: OracleContest | null
  navHistory?: NavHistory | null
  picker?: ReactNode
}) {
  const v = d.vault
  const name = facilityName(v)
  const outlook = outlookOf(v.trend)
  const { strengths, challenges, atTopOfScale } = splitFactors(d.score, gradeIndex)
  const factors = factorRows(d.score)
  const headline = d.score.dimensions.find(x => x.key === 'HEADLINE')
  // A ledger figure that changed under the reader says so once, as a portfolio row does.
  // Not the term or the scoring time: they move on every poll and would never rest.
  const heldMoved = useFlash(v.navCorrect)
  const reportedMoved = useFlash(v.navNaive)
  const gapMoved = useFlash(v.navDivergenceBps)
  const gradeMoved = useFlash(v.grade)
  const coverMoved = useFlash(d.broker.coverAvailable)
  const exposuresMoved = useFlash(`${v.loanCount}/${v.distressedLoanCount}`)

  const gapPct = bpsToPct(v.navDivergenceBps)
  // With no gap the two figures agree: there is no recognised loss to describe.
  const hasGap = v.navDivergenceBps > 0
  const largest = d.loans.length
    ? d.loans.reduce((a, b) => (Number(a.shareOfDebtTotal) > Number(b.shareOfDebtTotal) ? a : b))
    : null
  const overdue = d.loans.filter(l => l.secondsUntilDue < 0).length
  const redemptionShortfall = d.phaseInfo.projectedShortfall
  const next = nextBeat(d)
  // The first alert sits under the held figure, where it is read with it; the rest keep
  // their own block beside the note.
  const [lead, ...rest] = d.alerts.slice(0, 4)
  // Steps ALREADY APPLIED, not prospective triggers. The anchor carries a zero delta and
  // is dropped: "taking AAA to AAA" is not a reason.
  const moves = d.score.notchTrace.filter(s => s.delta !== 0).slice(-4)
  const kind = v.vaultKind === 'ClosedEnded' ? 'closed-ended' : 'open-ended'

  return (
    <>
      {/* Letterhead, print only: the masthead is the first thing the print sheet drops. */}
      <div className="wrap op-letterhead" aria-hidden>
        <Mark size={18} />
        <span>Orma</span>
        <span className="op-lh-rule" />
        <span>{d.serverTime ? name : 'Figures withheld'}</span>
      </div>

      <header className="wrap op-head">
        <div className="op-kind">
          <span className="t-label-s mute">Credit Opinion</span>
          <span className="t-fig-s mute">
            {d.serverTime ? <>Figures Received {fmtIso(d.serverTime)}</> : <>Figures Withheld</>}
          </span>
        </div>
        <h1 className="t-display-l">{name}</h1>
        <p className="t-body-m dim">
          {kind[0].toUpperCase() + kind.slice(1)} lending facility · {v.phase} · internal score {v.grade} · outlook {outlook}
        </p>
        {picker && <div className="op-pick">{picker}</div>}
      </header>

      <section className="wrap op-band" aria-label="Key figures">
        <div className="op-band-in grid12">
          <div className={'op-held' + (heldMoved ? ' flash' : '')}>
            <span className="t-label-s mute">Held</span>
            <span className="t-fig-display">{v.navCorrect}</span>
            {lead && <p className={'t-body-s ' + (SEVERITY[lead.severity] ?? 'dim')}>{creditText(lead.title)}</p>}
          </div>
          <dl className="op-glance">
            <Glance k="Reported" v={v.navNaive} moved={reportedMoved} />
            <Glance k="Gap" v={`${v.navDivergenceBps} bps (${gapPct})`} tone={v.navDivergenceBps > 0 ? 'loss' : undefined} moved={gapMoved} />
            <Glance k="Internal Score" v={<GradeLetter grade={v.grade} size="sm" />} moved={gradeMoved} />
            <Glance k="Outlook" v={outlook} phrase />
            <Glance k="Status" v={v.phase} phrase className="g-status" />
            <Glance k="Scored At" v={d.score.computedAt ? fmtIso(d.score.computedAt) : 'n.a.'} className="g-scored" />
            <Glance
              k="Coverage" phrase moved={coverMoved}
              v={`${dropsToXrp(d.broker.coverAvailable)} of ${dropsToXrp(d.broker.coverRequired)} required`}
            />
            <Glance
              k="Remaining Term" phrase={v.secondsToRedemption <= 0}
              v={v.secondsToRedemption > 0 ? duration(v.secondsToRedemption) : 'past due'}
            />
            <Glance k="Exposures" v={`${v.loanCount} · ${v.distressedLoanCount} non-performing`} phrase moved={exposuresMoved} />
          </dl>
        </div>
      </section>

      <section className="wrap op-scale"><Scale grade={v.grade} /></section>

      {navHistory && navHistory.points.length > 1 && (
        <section className="wrap op-nav" aria-label="NAV history">
          <h2 className="t-heading-m">NAV History</h2>
          <p className="t-body-s dim">
            Reported and held value per unit at every transaction that modified the facility.
            {navHistory.truncated && ' The oldest transactions are not shown.'}
          </p>
          <NavChart points={navHistory.points} />
        </section>
      )}

      <section className="wrap grid12 op-body">
        <div className="op-main">
          <section className="op-sec op-summary">
            <h2 className="t-heading-m">Summary</h2>
            <p>
              {name} is a {kind} lending facility carrying {v.loanCount} exposure{v.loanCount === 1 ? '' : 's'},
              of which {v.distressedLoanCount} {v.distressedLoanCount === 1 ? 'is' : 'are'}{' '}
              non-performing. It is in its {v.phase.toLowerCase()} period, with redemption
              scheduled for {fmtIso(v.redemptionAt)}.
            </p>
            {hasGap ? (
              <p>
                The facility reports a unit value of {v.navNaive} against a held value of{' '}
                {v.navCorrect}. The {v.navDivergenceBps} bps gap ({gapPct}) between the two is
                the recognised loss of {dropsToXrp(v.lossUnrealized)} carried on the book but
                not taken off the reported figure. An investor reading the reported figure
                alone is reading a number the facility cannot currently realise.
              </p>
            ) : (
              <p>
                The facility reports a unit value of {v.navNaive} and holds the same value,{' '}
                {v.navCorrect}. The two figures agree, which is not the same as safety: a loss
                nobody has recognised is absent from both.
              </p>
            )}
            <p>
              The internal score of {v.grade} anchors on whether claims can be met at
              redemption and is notched down from there. No weights are applied. The
              outlook is {outlook}.
            </p>
          </section>

          <div className="op-two">
            <section className="op-sec">
              <h3 className="t-heading-s">Credit Strengths</h3>
              {strengths.length
                ? <div>{strengths.map(s => <FactorItem key={s.key} d={s} />)}</div>
                : (
                  <p className="t-body-s dim">
                    {atTopOfScale
                      ? <>The facility is at the top of the internal scale, so no factor can
                          score above it. Every measured factor supports the score; the two
                          weakest are set out beside this.</>
                      : <>No measured factor scores above the facility's own {v.grade}.
                          Nothing here offsets the challenges beside it.</>}
                  </p>
                )}
            </section>
            <section className="op-sec">
              <h3 className="t-heading-s">Credit Challenges</h3>
              <div>{challenges.map(s => <FactorItem key={s.key} d={s} />)}</div>
            </section>
          </div>

          <section className="op-sec op-outlook">
            <h2 className="t-heading-m">Outlook</h2>
            <p className="dim">
              The outlook is {outlook}, taken from the direction of the measured factors
              rather than from any view of the obligors.
              {v.trend === 'deteriorating' && <> The factors are moving against the facility.</>}
              {v.trend === 'improving' && <> The factors are moving in the facility's favour.</>}
              {v.trend === 'stable' && <> The factors are holding.</>}
            </p>
            <p className="dim">
              {d.phaseInfo.canWithdraw
                ? <>Withdrawals are open.</>
                : <>Withdrawals are closed{d.phaseInfo.withdrawBlockedReason ? <>: {creditText(d.phaseInfo.withdrawBlockedReason)}</> : null}.</>}
              {/* A boundary that has already gone by is said to have gone by. Taking the
                  absolute value and always writing "in" turned every overrun into time
                  still in hand, which is the one direction a credit note must not err in. */}
              {!d.phaseInfo.nextBoundaryAt
                ? <> No further boundary is scheduled.</>
                : d.phaseInfo.secondsToNextBoundary < 0
                  ? <> That boundary was {fmtIso(d.phaseInfo.nextBoundaryAt)},
                      {' '}{duration(-d.phaseInfo.secondsToNextBoundary)} ago.</>
                  : <> The next scheduled boundary is {fmtIso(d.phaseInfo.nextBoundaryAt)},
                      {' '}in {duration(d.phaseInfo.secondsToNextBoundary)}.</>}
            </p>
            <p className="dim">
              Resolution depends on whether performing exposures mature before the
              redemption date and whether the recognised loss is taken through the
              reported figure. Neither is within this note's control to assume.
            </p>
          </section>

          <section className="op-sec op-why">
            <h3 className="t-heading-s">Why the Score Sits {moves.length > 0 ? 'Below' : 'at'} the Anchor</h3>
            {moves.length > 0
              ? (
                <div>
                  {moves.map((s, i) => (
                    <div className="op-notch" key={i}>
                      <span>{creditText(s.rule)}</span>
                      <span>
                        {String(s.delta).replace('-', '−')} notch{Math.abs(s.delta) === 1 ? '' : 'es'}, taking {s.from} to {s.to}.
                      </span>
                    </div>
                  ))}
                </div>
              )
              : <p className="t-body-s dim">Nothing has been notched. The score stands at the anchor.</p>}
          </section>
        </div>

        <aside className="op-side" aria-label="Next event and profile">
          {/* What falls due next, so the calendar desk is a place to go for detail rather
              than for the headline. Same builder as that desk uses, so the two can never
              disagree. */}
          <div className="op-box lead op-next">
            <h3 className="t-label-s mute">Next Event</h3>
            <span className="t-heading-s">{next ? next.what : 'Nothing on file'}</span>
            {next?.when && <span className="t-fig-s mute">{fmtIso(next.when)}</span>}
            <div className="op-due">
              <span className="t-label-s mute">Due</span>
              <span className={'t-fig-m' + (next && next.inSeconds < 0 ? ' loss' : '')}>
                {next
                  ? next.inSeconds < 0 ? `${duration(-next.inSeconds)} ago` : `in ${duration(next.inSeconds)}`
                  : '—'}
              </span>
            </div>
          </div>

          {rest.length > 0 && (
            <div className="op-box rule op-alerts-box">
              <h3 className="t-label-s mute">Alerts</h3>
              <ul className="op-alerts">
                {rest.map(a => <li key={a.code} data-sev={a.severity}>{creditText(a.title)}</li>)}
              </ul>
            </div>
          )}

          <div className="op-box">
            <h3 className="t-label-m">Profile</h3>
            <p>
              {name} lends to a single broker against posted first-loss coverage. Drawn
              debt is {dropsToXrp(d.broker.debtTotal)} of {dropsToXrp(d.broker.debtMaximum)}{' '}
              committed. Investors subscribe units and redeem them at the scheduled date;
              the facility is {v.isPrivate ? 'restricted to admitted subscribers' : 'open to any subscriber'} and its
              withdrawal policy is {creditText(v.withdrawalPolicy)}. Internal reference{' '}
              {facilityRef(v.vaultId)}.
            </p>
          </div>
          <div className="op-box">
            <h3 className="t-label-m">Coverage</h3>
            <p>
              {dropsToXrp(d.broker.coverAvailable)} posted against{' '}
              {dropsToXrp(d.broker.coverRequired)} required. Of that,{' '}
              {dropsToXrp(d.broker.maxLiquidatableNow)} can be liquidated today;{' '}
              {ratioToPct(d.broker.strandedCoverFraction)} is stranded.
            </p>
          </div>
          <div className="op-box">
            <h3 className="t-label-m">Asset Performance</h3>
            <p>
              {v.distressedLoanCount} of {v.loanCount} exposures non-performing.{' '}
              {overdue > 0
                ? `${overdue} past due and carried at par until recognised.`
                : 'None past due.'}{' '}
              {hasGap ? `The reported figure overstates held value by ${gapPct}.` : 'Reported and held values agree.'}
            </p>
          </div>
          <div className="op-box">
            <h3 className="t-label-m">Liquidity and Redemptions</h3>
            <p>
              {dropsToXrp(v.assetsAvailable)} available of {dropsToXrp(v.assetsTotal)}.
              Redemption {fmtIso(v.redemptionAt)}
              {v.secondsToRedemption > 0 ? `, in ${duration(v.secondsToRedemption)}` : ''}.
              {Number(redemptionShortfall) > 0
                ? ` Claims exceed projected liquidity by ${dropsToXrp(redemptionShortfall)}.`
                : ' Claims are covered by projected liquidity.'}
            </p>
          </div>
        </aside>
      </section>

      <section className="wrap op-exhibits" aria-label="Exhibits">
        <div className="op-exhibits-in">
          <Exhibit title="Exhibit 1 · Factor Scores" open>
            <div className="tbl-wrap">
              <table className="op-tbl fac-tbl">
                <thead>
                  <tr><th>Factor</th><th>What it measures</th><th className="rt">Score</th></tr>
                </thead>
                <tbody>
                  {factors.map(f => {
                    const worst = f.parts.length
                      ? f.parts.reduce((a, b) => (gradeIndex(a.grade) > gradeIndex(b.grade) ? a : b))
                      : null
                    return (
                      <tr key={f.name}>
                        <td><b>{f.name}</b></td>
                        <td className="op-says">{f.says}</td>
                        <td className="rt"><GradeLetter grade={worst?.grade} size="sm" /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Exhibit>

          {/* Exhibit 1 groups the measured factors into the three a committee leads with.
              This is the same five factors, ungrouped, in the order the calculation agent
              sends them, each with the figure it was scored on — nothing summarised away. */}
          <Exhibit
            title="Exhibit 2 · Measured Factors"
            meta={headline ? <>{creditText(headline.label)} <GradeLetter grade={headline.grade} size="sm" /></> : undefined}
          >
            <div className="tbl-wrap">
              <table className="op-tbl">
                <thead>
                  <tr><th>Factor</th><th className="rt">Measured</th><th className="rt">Score</th><th>Basis</th></tr>
                </thead>
                <tbody>
                  {d.score.dimensions.map(dim => (
                    <tr key={dim.key}>
                      <td><b>{creditText(dim.label)}</b></td>
                      <td className="rt num">{dim.value}{dim.unit === 'pct' ? '%' : dim.unit && dim.unit !== 'none' ? ` ${dim.unit}` : ''}</td>
                      <td className="rt"><GradeLetter grade={dim.grade} size="sm" /></td>
                      <td className="op-says">{sentence(creditText(dim.explain))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Exhibit>

          <ManagerConduct h={history ?? null} />
          <PledgedCollateral c={collateral ?? null} />
          <PledgeResolution r={resolution ?? null} />
          <EntryGate g={gate ?? null} />
          <OracleObject o={d.oracle} contest={contest ?? null} />

          <Exhibit title="Key Indicators">
            <div className="tbl-wrap">
              <table className="op-tbl">
                <thead>
                  <tr><th>Indicator</th><th className="rt">Value</th><th>Basis</th></tr>
                </thead>
                <tbody>
                  <tr><td>Reported unit value</td><td className="rt num">{v.navNaive}</td><td className="op-says">as stated by the facility</td></tr>
                  <tr><td>Held unit value</td><td className="rt num">{v.navCorrect}</td><td className="op-says">after recognised loss</td></tr>
                  <tr><td>Reported vs held</td><td className="rt num">{v.navDivergenceBps} bps</td><td className="op-says">{gapPct} of reported</td></tr>
                  <tr><td>Total assets</td><td className="rt num">{dropsToXrp(v.assetsTotal)}</td><td className="op-says">gross</td></tr>
                  <tr><td>Available assets</td><td className="rt num">{dropsToXrp(v.assetsAvailable)}</td><td className="op-says">unencumbered</td></tr>
                  <tr><td>Recognised loss</td><td className="rt num">{dropsToXrp(v.lossUnrealized)}</td><td className="op-says">written down, not yet reported</td></tr>
                  <tr><td>Drawn debt</td><td className="rt num">{dropsToXrp(d.broker.debtTotal)}</td><td className="op-says">of {dropsToXrp(d.broker.debtMaximum)} committed</td></tr>
                  <tr><td>Coverage available</td><td className="rt num">{dropsToXrp(d.broker.coverAvailable)}</td><td className="op-says">of {dropsToXrp(d.broker.coverRequired)} required</td></tr>
                  <tr><td>Coverage shortfall</td><td className="rt num">{dropsToXrp(d.broker.coverShortfall)}</td><td className="op-says">at the {rateToPct(d.broker.coverRateMinimum)} minimum rate</td></tr>
                  <tr><td>Largest exposure</td><td className="rt num">{largest ? ratioToPct(largest.shareOfDebtTotal) : 'n.a.'}</td><td className="op-says">share of drawn debt</td></tr>
                  <tr><td>Exposures</td><td className="rt num">{v.loanCount}</td><td className="op-says">{v.distressedLoanCount} non-performing, {overdue} past due</td></tr>
                  <tr><td>Claims at redemption</td><td className="rt num">{dropsToXrp(d.phaseInfo.claimsAtRedemption)}</td><td className="op-says">against {dropsToXrp(d.phaseInfo.liquidityAtRedemption)} liquidity</td></tr>
                  <tr><td>Projected shortfall</td><td className="rt num">{dropsToXrp(redemptionShortfall)}</td><td className="op-says">{ratioToPct(d.phaseInfo.shortfallPct)} of claims</td></tr>
                </tbody>
              </table>
            </div>
          </Exhibit>
        </div>
        <p className="op-foot">This note does not announce a rating action.</p>
      </section>
    </>
  )
}
