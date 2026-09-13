import { conductTone, letterTone } from '../lib/grades'

/**
 * A grade, set as the letter it is.
 *
 * It used to be a pill: a rounded rectangle, a 1px ring, a tinted fill. Ten of them on
 * one credit opinion, and every one of them a box drawn round a single character. A
 * rating is not a tag — it is the most important word on the page, and a rating agency
 * sets it as type, in the weight and the colour that carry its meaning, with nothing
 * around it.
 *
 * The colour is the one distinction a credit reader actually makes: investment grade
 * reads in the text colour, speculative reads as watch, distressed reads as risk. No new
 * hue, and never a grade this component invented — no grade prints an em-dash.
 */
export function GradeLetter({ grade, size = 'md', scale = 'credit' }: {
  grade?: string | null
  size?: 'sm' | 'md' | 'lg'
  /** Which scale this letter belongs to. Conduct runs A..E and is not the credit ladder. */
  scale?: 'credit' | 'conduct'
}) {
  if (!grade) return <span className="grade grade-na" aria-label="no grade on file">—</span>
  const tone = scale === 'conduct' ? conductTone(grade) : letterTone(grade)
  return (
    <span
      className={'grade grade-' + size}
      style={{ ['--tone' as string]: `var(${tone})` }}
    >{grade}</span>
  )
}
