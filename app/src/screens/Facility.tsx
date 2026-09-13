import type { ReactNode } from 'react'
import type { BrokerHistory, Collateral, Gate, OracleContest, Resolution, VaultDetail } from '../lib/types'
import { GradeLetter } from '../components/GradeLetter'
import { GRADE_LADDER, gradeFill, gradeIndex, letterTone } from '../lib/grades'
import { nextBeat } from '../lib/beats'
import { bpsToPct, dropsToXrp, duration, fmtIso, ratioToPct, rateToPct } from '../lib/format'
import { creditText, facilityName, facilityRef, factorRows, outlookOf, splitFactors } from '../lib/credit'
import { ManagerConduct, PledgedCollateral } from './FacilityExhibits'
import { PledgeResolution } from './PledgeResolution'
import { EntryGate } from './EntryGate'
import { OracleObject } from './OracleObject'

/** A labelled figure. Anything the payload does not carry prints n.a., never a guess. */
function F({ k, v, note }: { k: string; v: ReactNode; note?: string }) {
  return (
    <div className="kv">
      <dt className="label">{k}</dt>
      <dd className="num">{v ?? 'n.a.'}{note && <span className="kv-note"> {note}</span>}</dd>
    </div>
  )
}

/**
 * The internal scale: one track, filled to where this facility sits.
 *
 * It was twenty separate rectangles, which drew the mechanism rather than the reading —
 * a reader had to count boxes to learn anything. A rating is a position on a continuum,
 * so it is now a continuum: the track runs AAA to D and the fill runs from AAA to here.
 * The further right it reaches, the worse the facility is, which is the direction a
 * credit reader already expects a risk bar to move in.
 *
 * The fill comes from `gradeFill`, which is the payload's own position on the scale —
 * 1.0 at AAA and 0.0 at D. The track fills in the opposite direction, so the fraction is
 * its complement expressed in steps: AAA is 1/20, D is 20/20. Nothing is interpolated.
 *
 * With no grade on file the track is empty. Not a faint fill, not a fill at some
 * plausible middle — empty, and the reading is an em-dash. A bar with something in it is
 * a claim, and there is nothing here to claim.
 */
export function Ladder({ grade }: { grade?: string | null }) {
  const N = GRADE_LADDER.length
  const i = grade ? gradeIndex(grade) : -1
  const known = i >= 0
  const fill = known ? 1 - gradeFill(GRADE_LADDER[i]) * ((N - 1) / N) : 0
  const pct = (fill * 100).toFixed(2) + '%'

  return (
    <div className="ladder">
      <div
        className="lad-track"
        role="img"
        aria-label={known
          ? `${grade}: step ${i + 1} of ${N} on the internal scale, AAA strongest, D weakest`
          : 'Internal scale, AAA to D. No grade on file.'}
      >
        {known && (
          <span
            className="lad-fill"
            style={{ width: pct, ['--tone' as string]: `var(${letterTone(grade!)})` }}
          />
        )}
      </div>
      <div className="ladder-ends">
        <span>AAA</span>
        {/* The position, named. The bar says how far along; only this says what that
            step is called, and a reader who does not carry AAA..D in their head needs
            both. Withheld, it is an em-dash and the track above it is empty. */}
        <b className="ladder-read">
          {known ? <>{grade} · {i + 1} of {N}</> : <>—</>}
        </b>
        <span>D</span>
      </div>
    </div>
  )
}

function Section({ title, children, tight }: { title: string; children: ReactNode; tight?: boolean }) {
  // The section names itself so the stylesheet can treat one of them differently without
  // a second class threaded through every call site. Only "summary" is styled off this.
  return (
    <section className={'op-sec' + (tight ? ' tight' : '')} data-sec={title.toLowerCase()}>
      <h3 className="op-h">{title}</h3>
      {children}
    </section>
  )
}

/**
 * Credit opinion, two pages. The structure is the one a credit committee expects — ratings
 * box, summary, strengths and challenges, factor exhibit, then outlook, downgrade triggers,
 * indicators and profile. Every figure in it is a figure the calculation agent sent. Where
 * a figure was not sent, the line reads n.a. and nothing is inferred to fill it.
 */
export function Facility({ d, history, collateral, resolution, gate, contest }: {
  d: VaultDetail
  history?: BrokerHistory | null
  collateral?: Collateral | null
  resolution?: Resolution | null
  gate?: Gate | null
  contest?: OracleContest | null
}) {
  const v = d.vault
  const name = facilityName(v)
  const outlook = outlookOf(v.trend)
  const { strengths, challenges, atTopOfScale } = splitFactors(d.score, gradeIndex)
  const factors = factorRows(d.score)

  const gapPct = bpsToPct(v.navDivergenceBps)
  const shortfall = d.broker.coverShortfall
  const largest = d.loans.length
    ? d.loans.reduce((a, b) => (Number(a.shareOfDebtTotal) > Number(b.shareOfDebtTotal) ? a : b))
    : null
  const overdue = d.loans.filter(l => l.secondsUntilDue < 0).length
  const redemptionShortfall = d.phaseInfo.projectedShortfall
  const next = nextBeat(d)

  return (
    <article className="opinion">

      {/* ─────────────────────────── page 1 ─────────────────────────── */}
      <div className="op-page">
        {/* Letterhead, print only.
            On screen the mark sits in the topbar, and the topbar is the first thing the
            print sheet drops — so a printed opinion left the building with no indication of
            who had issued it. This is the same mark.svg the chrome uses, not a second
            drawing: an <img> rather than a background, because "print backgrounds" is off by
            default in every browser and a letterhead that depends on that setting is not a
            letterhead. Print turns it black; on paper the cream would be nothing at all. */}
        <div className="op-letterhead" aria-hidden>
          <img src="/assets/mark.svg" alt="" width={18} height={18} />
          <span className="op-lh-name">Orma</span>
          <span className="op-lh-rule" />
          {/* The running head names the facility, not the document type: a loose sheet
              picked up off a table should say which facility it is about. With no figures
              on file it says so, rather than heading a blank note with a name. */}
          <span className="op-lh-kind">{d.serverTime ? name : 'Figures withheld'}</span>
        </div>

        <header className="op-top">
          <div className="op-kind">
            <span className="label">Credit Opinion</span>
            <span className="op-date">
              {d.serverTime
                ? <>Figures Received {fmtIso(d.serverTime)}</>
                : <>Figures Withheld</>}
            </span>
          </div>
          <h1 className="op-title">{name}</h1>
          <p className="op-sub">
            {v.vaultKind === 'ClosedEnded' ? 'Closed-ended' : 'Open-ended'} lending facility ·
            {' '}{v.phase} · internal score {v.grade} · outlook {outlook}
          </p>
        </header>

        <div className="op-grid">
          <div className="op-main">
            <Section title="Summary">
              <p>
                {name} is a {v.vaultKind === 'ClosedEnded' ? 'closed-ended' : 'open-ended'}{' '}
                lending facility carrying {v.loanCount} exposure{v.loanCount === 1 ? '' : 's'},
                of which {v.distressedLoanCount} {v.distressedLoanCount === 1 ? 'is' : 'are'}{' '}
                non-performing. It is in its {v.phase.toLowerCase()} period, with redemption
                scheduled for {fmtIso(v.redemptionAt)}.
              </p>
              <p>
                The facility reports a unit value of {v.navNaive} against a held value of{' '}
                {v.navCorrect}. The {v.navDivergenceBps} bps gap ({gapPct}) between the two is
                the recognised loss of {dropsToXrp(v.lossUnrealized)} carried on the book but
                not taken off the reported figure. An investor reading the reported figure
                alone is reading a number the facility cannot currently realise.
              </p>
              <p>
                The internal score of {v.grade} anchors on whether claims can be met at
                redemption and is notched down from there. No weights are applied. The
                outlook is {outlook}.
              </p>
            </Section>

            <div className="op-two">
              <Section title="Credit Strengths" tight>
                {strengths.length ? (
                  <ul className="op-list">
                    {strengths.map(s => (
                      <li key={s.key}>
                        <b>{creditText(s.label)}</b> — scored {s.grade}. {creditText(s.explain)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    {atTopOfScale
                      ? <>The facility is at the top of the internal scale, so no factor can
                          score above it. Every measured factor supports the score; the two
                          weakest are set out beside this.</>
                      : <>No measured factor scores above the facility's own {v.grade}.
                          Nothing here offsets the challenges beside it.</>}
                  </p>
                )}
              </Section>
              <Section title="Credit Challenges" tight>
                <ul className="op-list">
                  {challenges.map(s => (
                    <li key={s.key}>
                      <b>{creditText(s.label)}</b> — scored {s.grade}. {creditText(s.explain)}
                    </li>
                  ))}
                </ul>
              </Section>
            </div>

            <Section title="Exhibit 1 · Factor Scores">
              <table className="op-tbl">
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
                        <td className="rt">
                          <GradeLetter grade={worst?.grade} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Section>
          </div>

          {/* The rail carries the reading; the column beside it carries the argument.
              Everything here used to be spread down the left-hand side as a loose list, or
              was two pages away in a prose box — a reader had to scroll, and then open a
              second tab, to answer "how bad, against what, and when". It is four blocks
              now, and on a tall window it stays put while the note scrolls under it. */}
          <aside className="op-side">
            <div className="op-box">
              <div className="label">Ratings</div>
              <dl className="op-ratings">
                <F k="Internal Score" v={<GradeLetter grade={v.grade} size="lg" />} />
                <F k="Outlook" v={outlook} />
                <F k="Status" v={v.phase} />
                <F k="Scored At" v={d.score.computedAt ? fmtIso(d.score.computedAt) : 'n.a.'} />
              </dl>
            </div>

            {/* The scale, on its own. Its reading names the step — "AAA · 1 of 20" — which
                is the scale position that used to sit above it as a second row saying the
                same thing twice. */}
            <div className="op-box op-scale">
              <Ladder grade={v.grade} />
            </div>

            <div className="op-box">
              <div className="label">At a Glance</div>
              <dl className="op-ratings">
                <F k="Reported" v={v.navNaive} />
                <F k="Held" v={v.navCorrect} />
                <F k="Gap" v={`${v.navDivergenceBps} bps`} note={`(${gapPct})`} />
                {/* Coverage was a paragraph on page two. The figure a reader wants first is
                    what is posted against what is required; the paragraph still says the
                    rest. */}
                <F
                  k="Coverage"
                  v={dropsToXrp(d.broker.coverAvailable)}
                  note={`of ${dropsToXrp(d.broker.coverRequired)} required`}
                />
                <F k="Remaining Term" v={v.secondsToRedemption > 0 ? duration(v.secondsToRedemption) : 'past due'} />
                <F k="Exposures" v={`${v.loanCount}`} note={`· ${v.distressedLoanCount} non-performing`} />
              </dl>
            </div>

            {/* What falls due next, so the calendar tab is a place to go for detail rather
                than a place to go for the headline. Same builder as that desk uses, so the
                two can never disagree. */}
            <div className="op-box">
              <div className="label">Next Event</div>
              <dl className="op-ratings">
                <F k={next ? next.what : 'Nothing on file'} v={next?.when ? fmtIso(next.when) : '—'} />
                <F
                  k="Due"
                  v={next
                    ? next.inSeconds < 0
                      ? `${duration(-next.inSeconds)} ago`
                      : `in ${duration(next.inSeconds)}`
                    : '—'}
                />
              </dl>
            </div>

            {d.alerts.length > 0 && (
              <div className="op-box">
                <div className="label">Alerts</div>
                <ul className="op-watch">
                  {d.alerts.slice(0, 4).map(a => (
                    <li key={a.code} data-sev={a.severity}>{creditText(a.title)}</li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* ─────────────────────────── page 2 ─────────────────────────── */}
      <div className="op-page op-break">
        <header className="op-top slim">
          <span className="label">Credit Opinion · Continued</span>
          <span className="op-date">{name}</span>
        </header>

        <div className="op-grid">
          <div className="op-main">
            <Section title="Outlook">
              <p>
                The outlook is {outlook}, taken from the direction of the measured factors
                rather than from any view of the obligors.
                {v.trend === 'deteriorating' && <> The factors are moving against the facility.</>}
                {v.trend === 'improving' && <> The factors are moving in the facility's favour.</>}
                {v.trend === 'stable' && <> The factors are holding.</>}
              </p>
              <p>
                {d.phaseInfo.canWithdraw
                  ? <>Withdrawals are open.</>
                  : <>Withdrawals are closed{d.phaseInfo.withdrawBlockedReason ? <>: {creditText(d.phaseInfo.withdrawBlockedReason)}</> : null}.</>}
                {/* A boundary that has already gone by is said to have gone by. Taking the
                    absolute value and always writing "in" turned every overrun into time
                    still in hand, which is the one direction a credit note must not err in. */}
                {d.phaseInfo.secondsToNextBoundary < 0
                  ? <> That boundary was {fmtIso(d.phaseInfo.nextBoundaryAt)},
                      {' '}{duration(-d.phaseInfo.secondsToNextBoundary)} ago.</>
                  : <> The next scheduled boundary is {fmtIso(d.phaseInfo.nextBoundaryAt)},
                      {' '}in {duration(d.phaseInfo.secondsToNextBoundary)}.</>}
              </p>
              <p>
                Resolution depends on whether performing exposures mature before the
                redemption date and whether the recognised loss is taken through the
                reported figure. Neither is within this note's control to assume.
              </p>
            </Section>

            {/* Steps ALREADY APPLIED, not prospective triggers. The anchor carries a
                zero delta and is dropped: "taking AAA to AAA" is not a reason. */}
            <Section title="Why the Score Sits Below the Anchor">
              <ul className="op-list">
                {d.score.notchTrace.filter(s => s.delta !== 0).slice(-4).map((s, i) => (
                  <li key={i}>{creditText(s.rule)} — {s.delta} notch{Math.abs(s.delta) === 1 ? '' : 'es'}, taking {s.from} to {s.to}.</li>
                ))}
                {d.score.notchTrace.every(s => s.delta === 0) && (
                  <li>Nothing has been notched. The score stands at the anchor.</li>
                )}
              </ul>
            </Section>

            {/* Exhibit 1 groups the measured factors into the three a committee leads
                with. This is the same five factors, ungrouped, in the order the
                calculation agent sends them, each with the figure it was scored on —
                nothing summarised away. */}
            <Section title="Exhibit 2 · Measured Factors">
              <table className="op-tbl factors">
                <thead>
                  <tr><th>Factor</th><th className="rt">Measured</th><th className="rt">Score</th><th>Basis</th></tr>
                </thead>
                <tbody>
                  {d.score.dimensions.map(dim => (
                    <tr key={dim.key} data-dim={dim.key}>
                      <td><b>{creditText(dim.label)}</b></td>
                      <td className="rt num">{dim.value}{dim.unit === 'pct' ? '%' : dim.unit && dim.unit !== 'none' ? ` ${dim.unit}` : ''}</td>
                      <td className="rt"><GradeLetter grade={dim.grade} /></td>
                      <td className="op-says">{creditText(dim.explain)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <ManagerConduct h={history ?? null} />
            <PledgedCollateral c={collateral ?? null} />
            <PledgeResolution r={resolution ?? null} />
            <EntryGate g={gate ?? null} />
            <OracleObject o={d.oracle} contest={contest ?? null} />

            <Section title="Key Indicators">
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
                  <tr><td>Coverage shortfall</td><td className="rt num">{dropsToXrp(shortfall)}</td><td className="op-says">at the {rateToPct(d.broker.coverRateMinimum)} minimum rate</td></tr>
                  <tr><td>Largest exposure</td><td className="rt num">{largest ? ratioToPct(largest.shareOfDebtTotal) : 'n.a.'}</td><td className="op-says">share of drawn debt</td></tr>
                  <tr><td>Exposures</td><td className="rt num">{v.loanCount}</td><td className="op-says">{v.distressedLoanCount} non-performing, {overdue} past due</td></tr>
                  <tr><td>Claims at redemption</td><td className="rt num">{dropsToXrp(d.phaseInfo.claimsAtRedemption)}</td><td className="op-says">against {dropsToXrp(d.phaseInfo.liquidityAtRedemption)} liquidity</td></tr>
                  <tr><td>Projected shortfall</td><td className="rt num">{dropsToXrp(redemptionShortfall)}</td><td className="op-says">{ratioToPct(d.phaseInfo.shortfallPct)} of claims</td></tr>
                </tbody>
              </table>
            </Section>
          </div>

          <aside className="op-side">
            <div className="op-box">
              <div className="label">Profile</div>
              <p className="op-profile">
                {name} lends to a single broker against posted first-loss coverage. Drawn
                debt is {dropsToXrp(d.broker.debtTotal)} of {dropsToXrp(d.broker.debtMaximum)}{' '}
                committed. Investors subscribe units and redeem them at the scheduled date;
                the facility is {v.isPrivate ? 'restricted to admitted subscribers' : 'open to any subscriber'} and its
                withdrawal policy is {creditText(v.withdrawalPolicy)}. Internal reference{' '}
                {facilityRef(v.vaultId)}.
              </p>
            </div>

            <div className="op-box">
              <div className="label">Coverage</div>
              <p className="op-profile">
                {dropsToXrp(d.broker.coverAvailable)} posted against{' '}
                {dropsToXrp(d.broker.coverRequired)} required. Of that,{' '}
                {dropsToXrp(d.broker.maxLiquidatableNow)} can be liquidated today;{' '}
                {ratioToPct(d.broker.strandedCoverFraction)} is stranded.
              </p>
            </div>

            <div className="op-box">
              <div className="label">Asset Performance</div>
              <p className="op-profile">
                {v.distressedLoanCount} of {v.loanCount} exposures non-performing.{' '}
                {overdue > 0
                  ? `${overdue} past due and carried at par until recognised.`
                  : 'None past due.'}{' '}
                The reported figure overstates held value by {gapPct}.
              </p>
            </div>

            <div className="op-box">
              <div className="label">Liquidity and Redemptions</div>
              <p className="op-profile">
                {dropsToXrp(v.assetsAvailable)} available of {dropsToXrp(v.assetsTotal)}.
                Redemption {fmtIso(v.redemptionAt)}
                {v.secondsToRedemption > 0 ? `, in ${duration(v.secondsToRedemption)}` : ''}.
                {Number(redemptionShortfall) > 0
                  ? ` Claims exceed projected liquidity by ${dropsToXrp(redemptionShortfall)}.`
                  : ' Claims are covered by projected liquidity.'}
              </p>
            </div>
          </aside>
        </div>

        <footer className="op-foot">
          This note does not announce a rating action.
        </footer>
      </div>
    </article>
  )
}
