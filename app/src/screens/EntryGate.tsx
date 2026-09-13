import type { Gate } from '../lib/types'
import { short } from '../lib/format'

/**
 * EXHIBIT 6 — who may enter.
 *
 * The only exhibit about enforcement rather than measurement. A facility can require
 * that a subscriber hold a credential from an issuer it names, and the ledger refuses
 * everyone else. Nothing here is an opinion: it is the admission rule the facility
 * itself published, read back from the instrument.
 *
 * Worth stating plainly on screen because it is counter-intuitive: the facility names
 * the issuer unilaterally. The issuer is not asked, signs nothing, and cannot decline
 * being cited. That is how a rating is used everywhere else, and it is the reason this
 * cannot be dismissed as a private arrangement between two parties.
 */
export function EntryGate({ g }: { g: Gate | null }) {
  if (!g) return null

  return (
    <section className="op-sec">
      <h3 className="op-h">Exhibit 6 · Who may enter</h3>

      {!g.gated ? (
        <p className="caption meth">
          Open to any subscriber.
          {/* The note earns a sentence only when it says something the line above does
              not: a facility marked restricted that enforces nothing, for instance. */}
          {g.note && !/open to any/i.test(g.note)
            ? <> {g.note[0].toUpperCase() + g.note.slice(1)}.</>
            : null}
        </p>
      ) : (
        <>
          <p className="caption meth">
            Restricted. Without one of these credentials, a subscription is refused outright.
          </p>
          <table className="op-tbl" style={{ marginTop: 12 }}>
            <thead><tr><th>Credential required</th><th>Accepted from</th></tr></thead>
            <tbody>
              {g.acceptedCredentials.map((a, i) => (
                <tr key={i}>
                  <td><b>{a.type ?? short(a.typeHex, 8)}</b></td>
                  <td className="op-says">
                    {short(a.issuer, 10)}
                    {g.issuerNamed && a.issuer === g.raterAddress ? ' — this service' : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="caption meth" style={{ marginTop: 10 }}>
            The facility named these issuers itself. None of them was asked, and none can
            decline being cited.
            {/* Two addresses side by side ARE the argument: the domain belongs to the
                facility, the credential comes from this service. One line, and the
                "private arrangement between two parties" reading is closed off. */}
            {g.domainOwner && g.domainOwner !== g.raterAddress && (
              <> Domain <b>{short(g.domainId, 8)}</b> belongs to <b>{short(g.domainOwner, 10)}</b>,
                which is the facility, not this service.</>
            )}
          </p>

          {/* The refusals are the claim. Without them this exhibit asserts that the ledger
              turns people away and shows nothing that did. */}
          {g.proof && g.proof.steps.length > 0 && (
            <>
              <table className="op-tbl gate-chain" style={{ marginTop: 16 }}>
                <thead><tr><th>What was submitted</th><th>Result</th><th>Recorded under</th></tr></thead>
                <tbody>
                  {g.proof.steps.map((s, i) => (
                    <tr key={i}>
                      <td><b>{s.step}</b></td>
                      <td>
                        <code className={s.ok ? 'res-ok' : 'res-no'}>{s.code}</code>
                        {s.note ? <span className="op-says"> — {s.note}</span> : null}
                      </td>
                      <td className="op-says gate-hash">{s.hash ? short(s.hash, 10) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="caption meth" style={{ marginTop: 10 }}>
                Every row landed on Devnet. The two refusals were returned by the ledger, not
                by this service.
              </p>
            </>
          )}
        </>
      )}
    </section>
  )
}
