import type { Dimension, Score } from '../lib/types'
import { GRADE_LADDER, gradeFill, gradeIndex, gradeTone } from '../lib/grades'
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
    <div style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 12 }}>
        <span className="label" style={{ width: 64, flex: '0 0 auto' }}>{d.key}</span>

        <span style={{ flex: '0 0 132px', fontSize: 'var(--t-base)' }}>{d.label}</span>

        {/* Bar length is driven by the dimension's GRADE, never by `value`: value mixes seconds with ratios. */}
        {/* The vector is the intellectual centre of the screen; its bars get the room. */}
        <span className="bar bar-sm" style={{ flex: '1 1 100px', minWidth: 70, ['--bar-tone' as string]: `var(${tone})` }}>
          <i style={{ width: gradeFill(d.grade) * 100 + '%' }} />
        </span>

        <span style={{ width: 52, flex: '0 0 auto', textAlign: 'right' }}>
          <Chip tone={tone}>{d.grade}</Chip>
        </span>

        <span className="num" style={{ width: 82, flex: '0 0 auto', textAlign: 'right' }}>
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
      <div className="caption" style={{ marginTop: 6 }}>{d.explain}</div>
    </div>
  )
}

export function ScoreVector({ score }: { score: Score }) {
  const tone = gradeTone(score.grade)
  return (
    <section className="panel">
      <h2 className="panel-title">grade</h2>

      <div className="row" style={{ gap: 16, alignItems: 'center', marginBottom: 12 }}>
        <span
          className="num"
          style={{
            fontSize: 'var(--t-xl)', color: `var(${tone})`,
            border: `1px solid color-mix(in srgb, var(${tone}) 45%, transparent)`, borderRadius: 4,
            background: `color-mix(in srgb, var(${tone}) 10%, transparent)`,
            padding: '2px 20px', lineHeight: 1.15,
          }}
        >{score.grade}</span>
        <div>
          {/* A letter is not a scale. Say which step it is, out of how many, which way. */}
          <div style={{ fontSize: 'var(--t-sm)', color: 'var(--fg)' }}>
            {gradeIndex(score.grade) < 0
              ? 'off the published scale'
              : <>step <b>{gradeIndex(score.grade) + 1}</b> of {GRADE_LADDER.length} — {GRADE_LADDER[0]} is safest, {GRADE_LADDER[GRADE_LADDER.length - 1]} is worst</>}
          </div>
          <div className="caption mono" style={{ marginTop: 4 }}>
            method v{score.methodVersion} · computed {fmtIso(score.computedAt)}
          </div>
        </div>
      </div>

      {score.dimensions.map(d => <DimRow key={d.key} d={d} />)}
    </section>
  )
}
