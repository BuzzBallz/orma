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

/** CSS custom-property name for a grade. */
export function gradeTone(g: string): '--ok' | '--warn' | '--bad' | '--fg-dim' {
  const i = gradeIndex(g)
  if (i < 0) return '--fg-dim'
  if (i <= 6) return '--ok'      // AAA .. A-
  if (i <= 12) return '--warn'   // BBB+ .. BB-
  return '--bad'                 // B+ .. D
}
