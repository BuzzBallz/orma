import { GRADE_LADDER, gradeIndex } from '../lib/grades'

/**
 * The internal scale: twenty steps, AAA to D, with this facility's step filled.
 *
 * Wide, every step is named, so a reader who does not carry AAA..D in their head can read
 * the position off the scale itself. Narrow, the names do not fit, so the steps become
 * ticks and the position is named once above them.
 *
 * With no grade on file nothing is filled. A filled step is a claim, and there is nothing
 * here to claim.
 */
export function Scale({ grade, label = true }: { grade?: string | null; label?: boolean }) {
  const N = GRADE_LADDER.length
  const i = grade ? gradeIndex(grade) : -1
  const known = i >= 0
  return (
    <div
      className="scale" role="img"
      aria-label={known
        ? `${grade}: step ${i + 1} of ${N} on the internal scale, AAA strongest, D weakest`
        : 'Internal scale, AAA to D. No grade on file.'}
    >
      <div className="scale-read" aria-hidden="true">
        <span>{GRADE_LADDER[0]}</span>
        {label && <b>{known ? <>{grade} · {i + 1} of {N}</> : '—'}</b>}
        <span>{GRADE_LADDER[N - 1]}</span>
      </div>
      <ol className="scale-steps" aria-hidden="true">
        {GRADE_LADDER.map((g, j) => <li key={g} data-on={j === i || undefined}><span>{g}</span></li>)}
      </ol>
    </div>
  )
}
