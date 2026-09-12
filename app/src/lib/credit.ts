import type { Dimension, Score, Trend, VaultRow } from './types'

/**
 * The reader is a credit analyst, not an engineer. Everything on screen has to be a word
 * they would meet in a rating note or on a loans blotter.
 *
 * Two of those words are not ours to choose: the backend owns its dimension explanations,
 * its alert titles and its notching rules, and those strings carry ledger vocabulary. We
 * relabel them at render time — same fact, the reader's language — rather than paraphrase
 * them, which would put words in the backend's mouth. Every pair below is a synonym, not
 * a softening.
 */
const TERMS: [RegExp, string][] = [
  [/\bVaults\b/g, 'Facilities'], [/\bvaults\b/g, 'facilities'],
  [/\bVault\b/g, 'Facility'], [/\bvault\b/g, 'facility'],
  [/\bOracle\b/g, 'Calculation agent'], [/\boracle\b/g, 'calculation agent'],
  [/\bAssetsTotal\b/g, 'total assets'],
  [/\bAssetsAvailable\b/g, 'available assets'],
  [/\bLossUnrealized\b/g, 'recognised loss'],
  [/\bCoverRateMinimum\b/g, 'minimum coverage rate'],
  [/\bCoverRateLiquidation\b/g, 'liquidation coverage rate'],
  [/\bRedemptionDate\b/g, 'redemption date'],
  [/\btecINSUFFICIENT_FUNDS\b/g, 'insufficient funds'],
  [/\bdrops\b/g, 'units'],
  // Amounts arrive denominated; the note states the reporting currency once, in the
  // methodology, rather than repeating a ticker against every figure.
  [/\s*\bXRP\b/g, ''],
  [/\bon-chain\b/gi, 'reported'],
  [/\bledger\b/gi, 'register'],
]

/** Apply to every backend-owned string before it reaches the screen. */
export function creditText(s: string): string {
  return TERMS.reduce((acc, [re, to]) => acc.replace(re, to), s)
}

/** Outlook, derived from the trend the backend actually sends. Never decorative. */
export function outlookOf(trend: Trend | undefined): 'Stable' | 'Negative' | 'Positive' | 'n.a.' {
  if (trend === 'deteriorating') return 'Negative'
  if (trend === 'improving') return 'Positive'
  if (trend === 'stable') return 'Stable'
  return 'n.a.'
}

/** The three factors a credit note leads with, mapped onto the measured dimensions. */
export const FACTORS: { name: string; keys: string[]; says: string }[] = [
  { name: 'Capital',           keys: ['COVER'],                says: 'first-loss coverage against recognised losses' },
  { name: 'Asset performance', keys: ['RECOG', 'CONCENT'],     says: 'recognition of non-performing exposure, and concentration' },
  { name: 'Liquidity',         keys: ['LIQUIDITY', 'DEADLINE'], says: 'cash on hand, and claims falling due at redemption' },
]

export function factorRows(score: Score | undefined) {
  const byKey = new Map((score?.dimensions ?? []).map(d => [d.key as string, d]))
  return FACTORS.map(f => ({
    ...f,
    parts: f.keys.map(k => byKey.get(k)).filter(Boolean) as Dimension[],
  }))
}

/**
 * Strengths and challenges are read off the measured factors, never written by hand.
 *
 * A strength has to be strictly better than the facility's own score. Simply taking the
 * three best factors would print "credit strength: scored CCC" on a facility scored D,
 * which is the sort of sentence that gets a note thrown away. Where nothing scores above
 * the facility, the list is empty and the note says so.
 */
export function splitFactors(score: Score | undefined, ladderIndex: (g: string) => number) {
  const dims = (score?.dimensions ?? []).filter(d => d.key !== 'HEADLINE')
  const head = score ? ladderIndex(score.grade) : 99
  const ranked = [...dims].sort((a, b) => ladderIndex(a.grade) - ladderIndex(b.grade))
  const strengths = ranked.filter(d => ladderIndex(d.grade) < head).slice(0, 3)
  // Always the two weakest, whatever the facility scores. A note with one challenge on a
  // facility that has five measured factors is a note that has stopped looking.
  const challenges = [...ranked].reverse().slice(0, 2)
  return { strengths, challenges, atTopOfScale: head === 0 }
}

/** A facility's name for a reader: its label, else a short reference. */
export function facilityName(v: Pick<VaultRow, 'label' | 'vaultId'> | undefined): string {
  if (!v) return '—'
  return v.label ?? `Facility ${v.vaultId.slice(0, 6)}`
}

/** Internal reference, shown once in the profile. Not an address, not a link. */
export function facilityRef(id: string | undefined): string {
  return id ? id.slice(0, 12).toUpperCase() : '—'
}
