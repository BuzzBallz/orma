import type { ReactNode } from 'react'
import type { BrokerHistory, Collateral, VaultDetail } from '../lib/types'
import { Chip } from '../components/Chip'
import { gradeIndex, gradeTone } from '../lib/grades'
import { bpsToPct, dropsToXrp, duration, fmtIso, ratioToPct, rateToPct } from '../lib/format'
import { creditText, facilityName, facilityRef, factorRows, outlookOf, splitFactors } from '../lib/credit'
import { ManagerConduct, PledgedCollateral } from './FacilityExhibits'

/** A labelled figure. Anything the payload does not carry prints n.a., never a guess. */
function F({ k, v, note }: { k: string; v: ReactNode; note?: string }) {
  return (
    <div className="kv">
      <dt className="label">{k}</dt>
      <dd className="num">{v ?? 'n.a.'}{note && <span className="kv-note"> {note}</span>}</dd>
    </div>
  )
}

function Section({ title, children, tight }: { title: string; children: ReactNode; tight?: boolean }) {
  return (
    <section className={'op-sec' + (tight ? ' tight' : '')}>
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
export function Facility({ d, history, collateral }: {
  d: VaultDetail
  history?: BrokerHistory | null
  collateral?: Collateral | null
}) {
  const v = d.vault
  const name = facilityName(v)
  const outlook = outlookOf(v.trend)
  const { strengths, challenges, atTopOfScale } = splitFactors(d.score, gradeIndex)
  const factors = factorRows(d.score)

  const gapPct = bpsToPct(v.navDivergenceBps)
  const shortfall = d.broker.coverShortfall
  const hasShortfall = shortfall !== '0' && Number(shortfall) > 0
  const largest = d.loans.length
    ? d.loans.reduce((a, b) => (Number(a.shareOfDebtTotal) > Number(b.shareOfDebtTotal) ? a : b))
    : null
  const overdue = d.loans.filter(l => l.secondsUntilDue < 0).length
  const redemptionShortfall = d.phaseInfo.projectedShortfall

  return (
    <article className="opinion">

      {/* ─────────────────────────── page 1 ─────────────────────────── */}
      <div className="op-page">
        <header className="op-top">
          <div className="op-kind">
            <span className="label">credit opinion</span>
            <span className="op-date">
              {d.serverTime
                ? <>figures received {fmtIso(d.serverTime)}</>
                : <>figures withheld</>}
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
                Drawn debt stands at {dropsToXrp(d.broker.debtTotal)} against a committed
                maximum of {dropsToXrp(d.broker.debtMaximum)}. First-loss coverage available
                is {dropsToXrp(d.broker.coverAvailable)} against {dropsToXrp(d.broker.coverRequired)}{' '}
                required at the {rateToPct(d.broker.coverRateMinimum)} minimum
                rate{hasShortfall ? `, a shortfall of ${dropsToXrp(shortfall)}` : ', with no shortfall'}.
                {largest && <> The largest single exposure is {ratioToPct(largest.shareOfDebtTotal)} of
                  drawn debt; coverage is keyed to total debt rather than to any one exposure,
                  so a single default consumes disproportionately little of it.</>}
              </p>
              <p>
                Available assets are {dropsToXrp(v.assetsAvailable)} of{' '}
                {dropsToXrp(v.assetsTotal)} total. At the redemption date, claims of{' '}
                {dropsToXrp(d.phaseInfo.claimsAtRedemption)} are projected against liquidity of{' '}
                {dropsToXrp(d.phaseInfo.liquidityAtRedemption)}
                {Number(redemptionShortfall) > 0
                  ? <>, a projected shortfall of {dropsToXrp(redemptionShortfall)} ({ratioToPct(d.phaseInfo.shortfallPct)} of claims). Redemption is served in the order requests arrive.</>
                  : <>, with no projected shortfall.</>}
              </p>
              <p>
                The internal score of {v.grade} is reached by ordinal notching from the
                weakest measured factor. No weights are applied. The outlook is {outlook}.
              </p>
            </Section>

            <div className="op-two">
              <Section title="Credit strengths" tight>
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
              <Section title="Credit challenges" tight>
                <ul className="op-list">
                  {challenges.map(s => (
                    <li key={s.key}>
                      <b>{creditText(s.label)}</b> — scored {s.grade}. {creditText(s.explain)}
                    </li>
                  ))}
                </ul>
              </Section>
            </div>

            <Section title="Exhibit 1 · Factor scores">
              <table className="op-tbl">
                <thead>
                  <tr><th>factor</th><th>what it measures</th><th className="rt">score</th></tr>
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
                          {worst ? <Chip tone={gradeTone(worst.grade)}>{worst.grade}</Chip> : 'n.a.'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Section>
          </div>

          <aside className="op-side">
            <div className="op-box">
              <div className="label">Ratings</div>
              <dl className="op-ratings">
                <F k="internal score" v={<Chip tone={gradeTone(v.grade)} large>{v.grade}</Chip>} />
                <F k="outlook" v={outlook} />
                <F k="status" v={v.phase} />
                <F k="scale position" v={`${gradeIndex(v.grade) + 1} of 20`} />
                <F k="scored at" v={d.score.computedAt ? fmtIso(d.score.computedAt) : 'n.a.'} />
              </dl>
            </div>

            <div className="op-box">
              <div className="label">At a glance</div>
              <dl className="op-ratings">
                <F k="reported unit value" v={v.navNaive} />
                <F k="held unit value" v={v.navCorrect} />
                <F k="reported vs held" v={`${v.navDivergenceBps} bps`} note={`(${gapPct})`} />
                <F k="exposures" v={`${v.loanCount}`} note={`· ${v.distressedLoanCount} non-performing`} />
                <F k="remaining term" v={v.secondsToRedemption > 0 ? duration(v.secondsToRedemption) : 'past due'} />
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
          <span className="label">credit opinion · continued</span>
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
                  : <>Withdrawals are closed{d.phaseInfo.withdrawBlockedReason ? <>: {creditText(d.phaseInfo.withdrawBlockedReason)}</> : '.'}</>}
                {' '}The next scheduled boundary is {fmtIso(d.phaseInfo.nextBoundaryAt)},
                in {duration(Math.abs(d.phaseInfo.secondsToNextBoundary))}.
              </p>
              <p>
                Resolution depends on whether performing exposures mature before the
                redemption date and whether the recognised loss is taken through the
                reported figure. Neither is within this note's control to assume.
              </p>
            </Section>

            <Section title="What could lead to a downgrade">
              <ul className="op-list">
                {d.score.notchTrace.slice(-3).map((s, i) => (
                  <li key={i}>{creditText(s.rule)} — {s.delta} notch{Math.abs(s.delta) === 1 ? '' : 'es'}, taking {s.from} to {s.to}.</li>
                ))}
              </ul>
            </Section>

            {/* Exhibit 1 groups the measured factors into the three a committee leads
                with. This is the same five factors, ungrouped, in the order the
                calculation agent sends them, each with the figure it was scored on —
                nothing summarised away. */}
            <Section title="Exhibit 2 · Measured factors">
              <table className="op-tbl factors">
                <thead>
                  <tr><th>factor</th><th className="rt">measured</th><th className="rt">score</th><th>basis</th></tr>
                </thead>
                <tbody>
                  {d.score.dimensions.map(dim => (
                    <tr key={dim.key} data-dim={dim.key}>
                      <td><b>{creditText(dim.label)}</b></td>
                      <td className="rt num">{dim.value}{dim.unit === 'pct' ? '%' : dim.unit && dim.unit !== 'none' ? ` ${dim.unit}` : ''}</td>
                      <td className="rt"><Chip tone={gradeTone(dim.grade)}>{dim.grade}</Chip></td>
                      <td className="op-says">{creditText(dim.explain)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <ManagerConduct h={history ?? null} />
            <PledgedCollateral c={collateral ?? null} />

            <Section title="Key indicators">
              <table className="op-tbl">
                <thead>
                  <tr><th>indicator</th><th className="rt">value</th><th>basis</th></tr>
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
                the facility is {v.isPrivate ? 'private' : 'open to subscription'} and its
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
              <div className="label">Asset performance</div>
              <p className="op-profile">
                {v.distressedLoanCount} of {v.loanCount} exposures non-performing.{' '}
                {overdue > 0
                  ? `${overdue} past due and carried at par until recognised.`
                  : 'None past due.'}{' '}
                The reported figure overstates held value by {gapPct}.
              </p>
            </div>

            <div className="op-box">
              <div className="label">Liquidity and redemptions</div>
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
