import type { Alert, Severity } from '../lib/types'
import { fmtIso } from '../lib/format'

const TONE: Record<Severity, string> = {
  critical: '--bad', high: '--bad', medium: '--warn', info: '--fg-dim',
}

/** Unknown severities and unknown codes must render, never crash (contract §3.3). */
function toneOf(severity: string): string {
  return TONE[severity as Severity] ?? '--fg-dim'
}

export function AlertList({ alerts }: { alerts: Alert[] }) {
  return (
    <section className="panel">
      <h2 className="panel-title">alerts</h2>
      {alerts.length === 0 ? (
        <div className="empty">no active alerts</div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {alerts.map((a, i) => {
            const tone = toneOf(a.severity)
            return (
              <div
                key={a.code + i}
                className="row"
                style={{
                  alignItems: 'flex-start', gap: 12,
                  borderLeft: `2px solid var(${tone})`,
                  background: a.severity === 'critical' ? 'color-mix(in srgb, var(--bad) 8%, transparent)' : undefined,
                  padding: '10px 14px',
                }}
              >
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--t-base)' }}>{a.title}</div>
                  <div className="caption">
                    {a.detail}{a.sinceAt ? ` · since ${fmtIso(a.sinceAt)}` : ''}
                  </div>
                </div>
                <span className="mono" style={{ fontSize: 'var(--t-xs)', color: `var(${tone})`, flex: '0 0 auto', letterSpacing: '0.06em' }}>
                  {a.code}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
