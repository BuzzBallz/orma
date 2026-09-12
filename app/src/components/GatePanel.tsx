import type { PhaseInfo, Score, VaultDetailFields } from '../lib/types'
import { Chip } from './Chip'
import { gradeTone } from '../lib/grades'
import { short } from '../lib/format'

/**
 * S3 band 4 (spec §S3). Three states, derived purely from the payload.
 * There is no field saying "THIS account is admitted" — do not fake one.
 */
export function GatePanel({ vault, phaseInfo, score }: {
  vault: VaultDetailFields; phaseInfo: PhaseInfo; score: Score
}) {
  let label: string, tone: string, detail: string
  if (phaseInfo.canDeposit === false) {
    label = 'DEPOSITS CLOSED'; tone = 'var(--warn)'; detail = `phase: ${vault.phase}`
  } else if (vault.domainId !== null) {
    label = 'GATE ARMED'; tone = 'var(--bad)'; detail = `domain ${short(vault.domainId, 12)} · ungraded deposits bounce tecNO_AUTH`
  } else {
    label = 'GATE OPEN'; tone = 'var(--fg-dim)'; detail = 'any account may deposit'
  }

  return (
    <div className="row" style={{ gap: 24 }}>
      <div className="num" style={{ fontSize: 'var(--t-lg)', color: tone, letterSpacing: '0.02em' }}>{label}</div>
      <div className="caption">{detail}</div>
      <span className="spacer" />
      <div className="row" style={{ gap: 10 }}>
        <span className="label">gating on</span>
        <Chip tone={gradeTone(score.grade)} large>{score.grade}</Chip>
        <span className="num mute">{score.gradeNumeric}</span>
      </div>
    </div>
  )
}
