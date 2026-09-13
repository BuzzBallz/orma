import type { IndexerRace } from '../lib/types'

/**
 * The one screen that is not written for the credit analyst.
 *
 * Every other screen in this app deliberately avoids vocabulary a rating analyst would
 * not meet in a credit note. This one is addressed to the protocol engineers reviewing
 * the work, so it uses the protocol's own words — field names, result codes, a
 * transaction hash — because paraphrasing them here would destroy the evidence.
 *
 * WHAT IT SHOWS. Two readers consume the identical transaction. One diffs the metadata,
 * which is what an indexer does. The other re-reads the object, which is what this
 * product does. The metadata diff is empty, so the first reader reports nothing while a
 * fifth of the fund's value has gone.
 *
 * It is the reason the rest of the app exists, so it is one tab away from the rest of
 * the app rather than in a separate demo harness.
 */
export function Evidence({ d }: { d: IndexerRace | null }) {
  if (!d) {
    return (
      <div className="stack">
        <section className="panel">
          <h2 className="panel-title">Verification</h2>
          <p className="caption meth">No capture has been received.</p>
        </section>
      </div>
    )
  }

  const prevKeys = Object.keys(d.vaultNode.previousFields ?? {})
  const empty = prevKeys.length === 0
  const before = d.vaultNode.healthyBefore
  const live = Boolean(d.capturedAt)

  return (
    <div className="stack">
      {/* Who this is for, said out loud.
          Every other desk is written for a credit analyst and keeps protocol vocabulary off
          the screen. This one deliberately does not — the raw record is the evidence, and
          paraphrasing a field name would break the reference a reader is being asked to
          check. Naming the audience is what reconciles the two: an analyst learns in one
          line that this page is not addressed to them, and the engineer it *is* addressed
          to still gets the record verbatim. Nothing below is softened. */}
      <p className="ev-addressed">
        This section is addressed to the engineers reviewing the protocol work. It quotes the
        record verbatim — field names and result codes included — because paraphrasing it
        would destroy the evidence. Every other section is written for the credit reader.
      </p>

      <section className="panel">
        <h2 className="panel-title">What the two readers see</h2>
        <p className="caption meth">{d.finding}</p>

        <div className="race">
          <div className="race-pane race-naive">
            <div className="race-hd">Reader A — diffs the metadata</div>
            <div className="race-val">{d.readings.naive.value}</div>
            <div className="race-formula">{d.readings.naive.formula}</div>
            <div className="race-note">Reports no change</div>
          </div>
          <div className="race-pane race-correct">
            <div className="race-hd">Reader B — re-reads the object</div>
            <div className="race-val">{d.readings.correct.value}</div>
            <div className="race-formula">{d.readings.correct.formula}</div>
            <div className="race-note">Reports the loss</div>
          </div>
        </div>

        <div className="race-gap">
          <b>{d.readings.divergenceBps.toLocaleString()} bp</b> apart, on the same transaction,
          from the same ledger.
        </div>
      </section>

      {/* The only text on this screen that must be legible from the back of a room. */}
      <section className="panel">
        <h2 className="panel-title">The metadata, unedited</h2>
        <p className="caption meth">{d.why}</p>
        <div className="ev-diff">
          <div className="ev-lbl">PreviousFields</div>
          <pre className={'ev-code' + (empty ? ' ev-empty' : '')}>
            {JSON.stringify(d.vaultNode.previousFields ?? {}, null, 2)}
          </pre>
          <div className="ev-lbl">FinalFields</div>
          <pre className="ev-code">{JSON.stringify(d.vaultNode.finalFields, null, 2)}</pre>
        </div>
        {empty && (
          <p className="caption meth ev-verdict">
            The change set is empty. Everything a metadata-diffing reader is given about this
            vault, for this transaction, is on the left.
          </p>
        )}
      </section>

      {before && (
        <section className="panel">
          <h2 className="panel-title">And it was healthy a moment earlier</h2>
          <p className="caption meth">
            Read directly from the object before the transaction. Without this, an empty change
            set is ambiguous — it could mean nothing moved. It did not mean that.
          </p>
          <table className="op-tbl" style={{ marginTop: 12 }}>
            <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
            <tbody>
              {Object.keys(d.vaultNode.finalFields).map(k => (
                <tr key={k}>
                  <td><b>{k}</b></td>
                  <td className="op-says">{before[k] ?? '—'}</td>
                  <td className="op-says">{d.vaultNode.finalFields[k]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">Provenance</h2>
        <table className="op-tbl">
          <tbody>
            <tr><td><b>Result</b></td><td className="op-says">{d.transactionResult}</td></tr>
            {d.transactionHash && (
              <tr><td><b>Transaction</b></td><td className="op-says ev-hash">{d.transactionHash}</td></tr>
            )}
            {d.vaultId && <tr><td><b>Vault</b></td><td className="op-says ev-hash">{d.vaultId}</td></tr>}
            {d.buildVersion && <tr><td><b>rippled</b></td><td className="op-says">{d.buildVersion}</td></tr>}
            {d.capturedAt && <tr><td><b>Captured</b></td><td className="op-says">{d.capturedAt}</td></tr>}
            {d.capturedDuring && <tr><td><b>During</b></td><td className="op-says">{d.capturedDuring}</td></tr>}
          </tbody>
        </table>
        {!live && (
          <p className="caption meth ev-verdict">
            This is the archived capture. Re-run the capture to replace it with one taken on
            the current build.
          </p>
        )}
      </section>
    </div>
  )
}
