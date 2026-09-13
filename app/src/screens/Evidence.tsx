import type { IndexerRace } from '../lib/types'

/**
 * Evidence: the one claim this product rests on, shown rather than argued.
 *
 * A recognised loss lands on the record as a field that was absent before. Absent fields
 * are not in a change set, so a reader that diffs the metadata is handed nothing and
 * reports nothing — while a fifth of the facility's value has gone. Re-reading the object
 * finds it.
 *
 * The page is a credit page, not a laboratory: a thesis, three figures, a table of the
 * fields that moved, and the raw record folded away underneath for anyone who wants to
 * check the transcription. Everything on it comes from the capture; nothing is computed
 * here, and a field the capture does not carry prints an em-dash.
 */

/**
 * The protocol documentation. It sits on this desk and nowhere else: it is written for
 * the same reader this screen is, it leaves the application, and a credit analyst reading
 * a rating note has no use for it in their chrome. Overridable so a preview build can
 * point at a local copy.
 */
const DOCS_URL = import.meta.env.VITE_DOCS_URL
  ?? 'https://ormaprotocol.mintlify.site/'

function DocsLink() {
  return (
    <a className="docs-link" href={DOCS_URL} target="_blank" rel="noreferrer noopener">
      Protocol documentation
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4.5 2.5h5v5M9.5 2.5 4 8M8 9.5H2.5V4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  )
}

/** Only what a value needs to be legible in a column. Never reformats the digits. */
function cell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

/**
 * The same page, with nothing in it.
 *
 * A record that has not arrived used to collapse this desk to one sentence in a panel,
 * which told a reader nothing about what would be there when it did. The claim, the three
 * figures and the table are the page; withheld, they read em-dash. The figures are the
 * only three slots on this desk and they are held open whether or not the capture is in.
 */
function EvidenceSkeleton({ name }: { name?: string }) {
  return (
    <div className="stack">
      <section className="panel ev">
        <header className="ev-head">
          <span className="label">Evidence</span>
          <h2 className="ev-title">{name ?? 'Recognised loss'}</h2>
          <p className="ev-thesis">
            The first recognised loss does not show up on a metadata diff.
          </p>
        </header>

        <div className="ev-band">
          {['Reported', 'Held', 'Gap'].map(k => (
            <div className="ev-fig" key={k}>
              <span className="label">{k}</span>
              <b className="ev-num ev-reported">—</b>
            </div>
          ))}
        </div>
        <p className="ev-under">No record has been received.</p>

        <table className="tbl ev-tbl">
          <thead>
            <tr><th>Field</th><th>Before</th><th>After</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="ev-field">—</td>
              <td className="ev-before">—</td>
              <td className="rt ev-after">—</td>
            </tr>
          </tbody>
        </table>

        <div className="ev-prov">
          <span className="label">Recorded</span>
          <code>—</code>
          <span className="spacer" />
          <DocsLink />
        </div>
      </section>
    </div>
  )
}

export function Evidence({ d, name }: { d: IndexerRace | null; name?: string }) {
  if (!d) return <EvidenceSkeleton name={name} />

  const prev = d.vaultNode.previousFields ?? {}
  const final = d.vaultNode.finalFields ?? {}
  // The union, in the order the record presents it: every field the capture mentions gets
  // a line, whether or not the change set admitted to it.
  const fields = [...new Set([...Object.keys(final), ...Object.keys(prev)])]
  const gap = d.readings.divergenceBps
  const raw = JSON.stringify(prev, null, 2)
  const rawFinal = JSON.stringify(final, null, 2)

  return (
    <div className="stack">
      <section className="panel ev">
        <header className="ev-head">
          <span className="label">Evidence</span>
          <h2 className="ev-title">{name ?? 'Recognised loss'}</h2>
          <p className="ev-thesis">
            The first recognised loss does not show up on a metadata diff.
          </p>
        </header>

        {/* The hero: three figures, set like the blotter sets figures. The gap is the only
            thing on this page allowed a colour, and only when there is a gap to report. */}
        <div className="ev-band">
          <div className="ev-fig">
            <span className="label">Reported</span>
            <b className="ev-num ev-reported">{cell(d.readings.naive.value)}</b>
          </div>
          <div className="ev-fig">
            <span className="label">Held</span>
            <b className="ev-num ev-held">{cell(d.readings.correct.value)}</b>
          </div>
          <div className="ev-fig">
            <span className="label">Gap</span>
            <b className={'ev-num' + (gap > 0 ? ' ev-gap' : '')}>
              {gap.toLocaleString('en-US').replace(/,/g, ' ')} bp
            </b>
          </div>
        </div>
        <p className="ev-under">Same transaction, same record.</p>

        <table className="tbl ev-tbl">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(k => (
              <tr key={k}>
                <td className="ev-field">{k}</td>
                {/* An absent "before" is the finding, so it is stated the way every other
                    absent figure in this product is stated: an em-dash. */}
                <td className="ev-before">{cell(prev[k as keyof typeof prev])}</td>
                <td className="rt ev-after">{cell(final[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="ev-formula">{d.readings.correct.formula}</p>

        <div className="ev-prov">
          <span className="label">Recorded</span>
          <code>{d.transactionResult}</code>
          {d.transactionHash && <code className="ev-hash">{d.transactionHash}</code>}
          {d.capturedAt && <code>{d.capturedAt}</code>}
          <span className="spacer" />
          <DocsLink />
        </div>

        {/* Folded by default. The transcription above is the argument; this is the receipt,
            and a receipt does not need to be open to be a receipt. */}
        <details className="ev-raw">
          <summary>Record</summary>
          <div className="ev-raw-body">
            <div className="ev-raw-col">
              <span className="label">PreviousFields</span>
              <pre>{raw}</pre>
            </div>
            <div className="ev-raw-col">
              <span className="label">FinalFields</span>
              <pre>{rawFinal}</pre>
            </div>
          </div>
        </details>
      </section>
    </div>
  )
}
