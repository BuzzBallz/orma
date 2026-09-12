import type { NotchStep } from '../lib/types'
import { gradeTone } from '../lib/grades'
import { Chip } from './Chip'

/**
 * Spec §S1.4. A visible chain of rules, not a table: this is the answer to
 * "how did you choose your weights?" — we do not weight, we notch.
 * Rule strings are backend-owned pitch copy and are rendered verbatim.
 */
export function NotchTrace({ trace }: { trace: NotchStep[] }) {
  return (
    <section className="panel">
      <h2 className="panel-title">notch trace — how the grade was reached</h2>
      {trace.length === 0 ? (
        <div className="empty">no notching applied</div>
      ) : (
        <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 16 }}>
          {trace.map((s, i) => {
            const last = i === trace.length - 1
            return (
              <div
                key={i}
                className="row"
                style={{ gap: 12, padding: '10px 0', borderTop: i ? '1px solid var(--line)' : undefined, alignItems: 'flex-start' }}
              >
                <span style={{ width: 44, flex: '0 0 auto' }}>
                  <Chip tone={gradeTone(s.from)}>{s.from}</Chip>
                </span>
                <span className="mute" style={{ flex: '0 0 auto' }}>——</span>
                <span style={{ flex: '1 1 auto', fontSize: 'var(--t-sm)' }}>{s.rule}</span>
                <span
                  className="num"
                  style={{ width: 32, flex: '0 0 auto', textAlign: 'right', color: s.delta < 0 ? 'var(--bad)' : 'var(--fg-mute)' }}
                >{s.delta}</span>
                <span className="mute" style={{ flex: '0 0 auto' }}>——▶</span>
                <span
                  style={{
                    width: 52, flex: '0 0 auto',
                    outline: last ? '2px solid var(--read-correct)' : undefined,
                    outlineOffset: last ? 2 : undefined, borderRadius: 3,
                  }}
                >
                  <Chip tone={gradeTone(s.to)}>{s.to}</Chip>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
