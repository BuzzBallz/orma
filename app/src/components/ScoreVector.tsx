import type { Dimension, Score } from '../lib/types'
import { gradeFill, gradeTone } from '../lib/grades'
import { duration, fmtIso, ratioToPct } from '../lib/format'
import { Chip } from './Chip'

/** Spec §S1.3 column 5. `value` carries MIXED UNITS across the six rows — format per unit. */
function formatValue(d: Dimension): string {
  switch (d.unit) {
    case 'ratio': return ratioToPct(d.value)
    case 'percent': return d.value + '%'
    case 'seconds': return duration(Number(d.value))   // Number() on a duration, not a displayed figure
    case 'grade': return d.value
    default: return d.value
  }
}

function DimRow({ d }: { d: Dimension }) {
  const tone = gradeTone(d.grade)
  return (
    <div style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 12 }}>
        <span
          className="mono"
          style={{ fontSize: 'var(--t-xs)', color: 'var(--fg-dim)', letterSpacing: '0.08em', width: 72, flex: '0 0 auto' }}
        >{d.key}</span>

        <span style={{ flex: '0 1 140px', minWidth: 90, fontSize: 'var(--t-base)' }}>{d.label}</span>

        {/* Bar length is driven by the dimension's GRADE, never by `value`: value mixes seconds with ratios. */}
        <span className="bar bar-sm" style={{ flex: '1 1 40px', minWidth: 40, ['--bar-tone' as string]: `var(${tone})` }}>
          <i style={{ width: gradeFill(d.grade) * 100 + '%' }} />
        </span>

        <span style={{ width: 52, flex: '0 0 auto', textAlign: 'right' }}>
          <Chip tone={tone}>{d.grade}</Chip>
        </span>

        <span className="num" style={{ width: 96, flex: '0 0 auto', textAlign: 'right' }}>
          {formatValue(d)}
        </span>

        <span className="num" style={{ width: 28, flex: '0 0 auto', textAlign: 'right' }}>
          {d.notches !== 0 && (
            <span style={{ color: d.notches < 0 ? 'var(--bad)' : 'var(--ok)' }}>
              {d.notches > 0 ? '+' : ''}{d.notches}
            </span>
          )}
        </span>
      </div>
      <div className="caption" style={{ marginTop: 4 }}>{d.explain}</div>
    </div>
  )
}

export function ScoreVector({ score }: { score: Score }) {
  const tone = gradeTone(score.grade)
  return (
    <section className="panel">
      <h2 className="panel-title">grade</h2>

      <div className="row" style={{ gap: 16, alignItems: 'center', marginBottom: 8 }}>
        <span
          className="num"
          style={{
            fontSize: 'var(--t-xl)', color: `var(${tone})`,
            border: `1px solid var(${tone})`, borderRadius: 6,
            background: `color-mix(in srgb, var(${tone}) 12%, transparent)`,
            padding: '0 16px', lineHeight: 1.2,
          }}
        >{score.grade}</span>
        <div>
          <div className="caption">method v{score.methodVersion}</div>
          <div className="caption mono">computed {fmtIso(score.computedAt)}</div>
        </div>
      </div>

      {score.dimensions.map(d => <DimRow key={d.key} d={d} />)}
    </section>
  )
}
