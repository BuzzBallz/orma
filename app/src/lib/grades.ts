export const GRADE_LADDER = [
  'AAA','AA+','AA','AA-','A+','A','A-',
  'BBB+','BBB','BBB-','BB+','BB','BB-',
  'B+','B','B-','CCC','CC','C','D',
] as const                                  // 20 entries, index 0..19

export function gradeIndex(g: string): number { return GRADE_LADDER.indexOf(g as never) }

/** Bar fill, 0..1. AAA = 1.0, D = 0.0. Unknown grade = 0. */
export function gradeFill(g: string): number {
  const i = gradeIndex(g)
  return i < 0 ? 0 : 1 - i / (GRADE_LADDER.length - 1)   // denominator is 19
}

/**
 * The tone a grade is SET in, as opposed to the tone a row is railed in.
 *
 * `gradeTone` below paints the risk rail on a blotter row, where three bands are the
 * point. A grade printed as a letter wants the one distinction a credit reader actually
 * makes first: investment grade or not, and whether it has gone distressed. So AAA..BBB-
 * reads in the text colour, BB+..B- as watch, and CCC..D as risk.
 */
export function letterTone(g: string): '--fg' | '--warn' | '--bad' | '--fg-mute' {
  const i = gradeIndex(g)
  if (i < 0) return '--fg-mute'
  if (i <= 9) return '--fg'      // AAA .. BBB-  investment grade
  if (i <= 15) return '--warn'   // BB+  .. B-   speculative
  return '--bad'                 // CCC  .. D    distressed
}

/** CSS custom-property name for a grade. */
export function gradeTone(g: string): '--ok' | '--warn' | '--bad' | '--fg-dim' {
  const i = gradeIndex(g)
  if (i < 0) return '--fg-dim'
  if (i <= 6) return '--ok'      // AAA .. A-
  if (i <= 12) return '--warn'   // BBB+ .. BB-
  return '--bad'                 // B+ .. D
}
