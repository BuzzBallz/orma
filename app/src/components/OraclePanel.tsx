import type { Oracle } from '../lib/types'
import { Chip } from './Chip'
import { duration, short } from '../lib/format'
import { useAnchored } from './Countdown'

/** S3 band 3 (spec §S3) — also reused whole by S4. `aggregate` is null on 4 of 5 fixtures. */
export function OraclePanel({ oracle, receivedAt, tick }: { oracle: Oracle; receivedAt: number; tick: number }) {
  const age = useAnchored(-oracle.ageSeconds, receivedAt, tick)   // ageSeconds counts UP
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 32 }}>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div className="row-wrap" style={{ gap: 20, marginBottom: 12 }}>
          <span className="caption">publisher <span className="mono mute">{oracle.publisher}</span></span>
          <span className="caption">
            object{' '}
            <a className="mono" href={oracle.explorerUrl} target="_blank" rel="noreferrer">{short(oracle.objectIndex, 12)}</a>
          </span>
          <span className="caption">baseAsset <span className="mono mute">{short(oracle.baseAssetHex, 12)}</span></span>
          <span className="caption">
            age <span className="num" style={{ color: oracle.stale ? 'var(--warn)' : undefined }}>
              {duration(Math.max(0, -age))}
            </span>
          </span>
          {oracle.stale && <Chip tone="--warn">stale</Chip>}
        </div>

        <div className="row-wrap" style={{ gap: 8 }}>
          {oracle.dimensionsOnChain.map(d => (
            <Chip key={d.key} tone="--read-correct" title={`scale ${d.scale}`}>{d.key} {d.value}</Chip>
          ))}
        </div>
      </div>

      <div style={{ flex: '0 0 260px', borderLeft: '1px solid var(--line)', paddingLeft: 20 }}>
        {oracle.aggregate === null ? (
          <div className="caption">single publisher — no ledger aggregate yet</div>
        ) : (
          <>
            <div className="row-wrap" style={{ gap: 16 }}>
              <span className="caption">publishers <span className="num">{oracle.aggregate.publisherCount}</span></span>
              <span className="caption">median <span className="num">{oracle.aggregate.median}</span></span>
              <span className="caption">mean <span className="num">{oracle.aggregate.mean}</span></span>
              <span className="caption">stdDev <span className="num">{oracle.aggregate.stdDev}</span></span>
            </div>
            <div className="caption" style={{ marginTop: 6 }}>computed by the ledger, not by us</div>
          </>
        )}
      </div>
    </div>
  )
}
