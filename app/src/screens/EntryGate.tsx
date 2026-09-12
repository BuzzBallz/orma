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
          Open to any subscriber. {g.note ? <>{g.note[0].toUpperCase() + g.note.slice(1)}.</> : null}
        </p>
      ) : (
        <>
          <p className="caption meth">
            Restricted. A subscriber must hold one of the credentials below, from the issuer
            named beside it, or the transfer is refused outright.
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
            The facility named these issuers itself. An issuer is not asked, signs nothing,
            and cannot decline being cited — which is what makes the requirement the
            facility's own and not a private arrangement.
          </p>
        </>
      )}
    </section>
  )
}
