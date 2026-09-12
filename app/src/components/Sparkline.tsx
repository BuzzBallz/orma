import type { Sample } from '../lib/samples'

/**
 * Hand-rolled, no chart library (spec §7.2/§7.3). Two polylines: naive dashed --muted,
 * correct solid --accent. The box is kept even with fewer than two samples so the layout
 * does not jump when the second poll lands.
 */
export function Sparkline({ samples, height = 120 }: { samples: Sample[]; height?: number }) {
  const box = (
    child: React.ReactNode,
  ) => (
    <svg viewBox="0 0 600 120" preserveAspectRatio="none" style={{ width: '100%', height }}>
      {child}
    </svg>
  )

  // The box is kept so the layout does not jump when the second poll lands. No spinner (§6.5).
  if (samples.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', borderTop: '1px solid var(--line)' }}>
        <span className="caption">
          one sample per poll · the two readings start drawing on the next three-second tick
        </span>
      </div>
    )
  }

  const t0 = samples[0].t
  const t1 = samples[samples.length - 1].t
  const span = t1 - t0 || 1

  const lo = Math.min(...samples.map(s => s.correct)) * 0.98
  const hi = Math.max(...samples.map(s => s.naive)) * 1.02
  const range = hi - lo

  // Both series flat and equal (AAAA0002): centre the single line, never divide by zero.
  const y = (v: number) => (range === 0 ? 60 : 120 - ((v - lo) / range) * 120)
  const x = (t: number) => ((t - t0) / span) * 600

  const line = (pick: (s: Sample) => number) => samples.map(s => `${x(s.t).toFixed(1)},${y(pick(s)).toFixed(1)}`).join(' ')

  return box(
    <>
      <polyline
        fill="none" vectorEffect="non-scaling-stroke" strokeWidth="2"
        stroke="var(--muted)" strokeDasharray="4 3" points={line(s => s.naive)}
      />
      <polyline
        fill="none" vectorEffect="non-scaling-stroke" strokeWidth="2"
        stroke="var(--accent)" points={line(s => s.correct)}
      />
    </>,
  )
}
