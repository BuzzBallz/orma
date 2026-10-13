import type { IndexerRace } from '../lib/types'
import { dropsToXrp } from '../lib/format'
import { Exhibit } from '../components/Exhibit'

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

/** Only what a value needs to be legible in a column. Never reformats the digits. */
function cell(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

function Head({ title }: { title: string }) {
  return (
    <header className="wrap evd-head">
      <span className="t-label-s mute">Evidence</span>
      <h1 className="t-display-l">{title}</h1>
      <p className="t-heading-l dim evd-thesis">The first recognised loss does not show up on a metadata diff.</p>
    </header>
  )
}

/**
 * The same page, with nothing in it. The claim, the three figures and the table are the
 * page; withheld, they read em-dash, so a reader can see what will be there when it comes.
 */
function EvidenceSkeleton({ name }: { name?: string }) {
  return (
    <>
      <Head title={name ?? 'Recognised loss'} />
      <section className="wrap">
        <div className="evd-band grid12">
          <div className="evd-held"><span className="t-label-s mute">Held</span><span className="t-fig-display mute">—</span></div>
          <div className="evd-rep"><span className="t-label-s mute">Reported</span><span className="t-fig-l mute">—</span></div>
          <div className="evd-gap"><span className="t-label-s mute">Gap</span><span className="t-fig-l mute">—</span></div>
        </div>
        <p className="evd-under t-body-s mute">No record has been received.</p>
      </section>
      <section className="wrap grid12 evd-rec">
        <div className="evd-fields">
          <div className="tbl-wrap">
            <table className="op-tbl fit">
              <thead><tr><th>Field</th><th className="rt">Before</th><th className="rt">After</th></tr></thead>
              <tbody><tr><td className="num">—</td><td className="rt num">—</td><td className="rt num">—</td></tr></tbody>
            </table>
          </div>
        </div>
        <div className="evd-prov">
          <span className="t-label-s mute">Recorded</span>
          <code>—</code>
        </div>
      </section>
    </>
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
  const shares = d.vaultNode.sharesOutstanding

  return (
    <>
      {/* The capture names its own facility. Taking the title from the picker instead put
          one facility's name over another facility's figures the moment a judge picked a
          different row, which reads as fabricated data and is the one thing this screen
          cannot afford. */}
      <Head title={d.label ?? name ?? 'Recognised loss'} />

      {/* Three figures, the held one set largest. The gap is the only thing on this page
          allowed a colour, and only when there is a gap to report. */}
      <section className="wrap">
        <div className="evd-band grid12">
          <div className="evd-held">
            <span className="t-label-s mute">Held</span>
            <span className="t-fig-display">{cell(d.readings.correct.value)}</span>
          </div>
          <div className="evd-rep">
            <span className="t-label-s mute">Reported</span>
            <span className="t-fig-l dim">{cell(d.readings.naive.value)}</span>
          </div>
          <div className="evd-gap">
            <span className="t-label-s mute">Gap</span>
            <span className={'t-fig-l' + (gap > 0 ? ' loss' : '')}>{gap.toLocaleString('en-US').replace(/,/g, ' ')} bp</span>
          </div>
        </div>
        <p className="evd-under t-body-s mute">Same transaction, same record.</p>
      </section>

      <section className="wrap grid12 evd-rec">
        <div className="evd-fields">
          <div className="tbl-wrap">
            <table className="op-tbl fit">
              <thead>
                <tr><th>Field</th><th className="rt">Change set</th><th className="rt">After</th></tr>
              </thead>
              <tbody>
                {fields.map(k => (
                  <tr key={k}>
                    <td className="num">{k}</td>
                    {/* An absent "before" is the finding, so it is stated the way every
                        other absent figure in this product is stated: an em-dash. */}
                    <td className="rt num mute">{cell(prev[k as keyof typeof prev])}</td>
                    <td className="rt num">{cell(final[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="evd-formula">
            <code className="dim">{d.readings.correct.formula}</code>
            {shares && final.AssetsTotal && (
              <code>
                ({dropsToXrp(final.AssetsTotal)} &minus; {dropsToXrp(final.LossUnrealized ?? '0')})
                {' / '}{dropsToXrp(shares)} = {d.readings.correct.value}
              </code>
            )}
          </div>
        </div>

        <div className="evd-prov">
          <span className="t-label-s mute">Recorded</span>
          <code className={/^tes/.test(d.transactionResult) ? 'ok' : undefined}>{d.transactionResult}</code>
          {d.transactionHash && <code>{d.transactionHash}</code>}
          {d.capturedAt && <code className="mute">{d.capturedAt}</code>}
        </div>
      </section>

      {/* Folded. The transcription above is the argument; this is the receipt, and a
          receipt does not need to be open to be a receipt. */}
      <section className="wrap evd-raw">
        <div className="op-exhibits-in">
          <Exhibit title="Record" meta="PreviousFields, FinalFields">
            <div className="evd-raw-body">
              <div>
                <span className="t-label-s mute">PreviousFields</span>
                <pre>{JSON.stringify(prev, null, 2)}</pre>
              </div>
              <div>
                <span className="t-label-s mute">FinalFields</span>
                <pre>{JSON.stringify(final, null, 2)}</pre>
              </div>
            </div>
          </Exhibit>
        </div>
      </section>
    </>
  )
}
