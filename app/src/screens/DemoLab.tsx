import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Figure, HashLink, Panel, TestNetBanner, Verdict, formatBps, formatXrp, type VerdictStatus } from '../components/Ledger'
import { Amount } from '../components/Amount'
import {
  API_BASE, ApiFailure, BROWSER_SIGNER, confirmAction, cureBody, cureTicketPath, deskPlanPath, deskTicketPaths, errorSentence, getJson, lendingVaultOf,
  postAction, postSignature, readOperatorSession, sessionFromFragment, writeOperatorSession,
  type ActionAnswer, type ActionError, type ActionPreview, type DeskPlan, type DeskPlanVault, type OperatorSession, type Position, type Positions,
} from '../lib/api'
import { usePoll } from '../lib/usePoll'
import {
  KEY_LABEL, KEY_ROLES, KeyError, decodeBlob, forgetKeys, keeping, keyFor, keyRoleOf, keyStore, loadSeeds, parseRolesFile, restoreKept, roleName, setKeep, signRequest,
  type KeyRole, type LoadedKey, type Seeds,
} from '../lib/demoKeys'
import type { ChangeRow, Decision, MarginCall, MarginCallEntry, RoleAction, Ticket, ToSign } from '../lib/types'
import { BORROWER_NAME, LENDER_NAME, secondsText } from './Desk'

/**
 * /demo, the temporary live demo lab. Devnet only, demo only: never how the product is deployed.
 *
 * The server builds every transaction exactly as it does for /desk (the role engine, the desk signer's re-read,
 * recompute and mandate check, the decision log); each action here opts into browser signing with
 * `signer: 'browser'`, and the signature alone happens in this tab, with keys the human loads at runtime
 * (lib/demoKeys.ts). Only the signed blob is posted back. The run and its operator token come from the operator
 * link's fragment, as on /desk, into sessionStorage, and are never shown.
 */

const EXPLORER_TX = 'https://devnet.xrpl.org/transactions/'
const RUN_HEX = /^[0-9a-f]{32}$/
const DEC = /^-?\d+(\.\d+)?$/
const LAB_KEY = 'orma.demo.lab'
const HARBOR_KEY = 'orma.demo.harbor'
/** The demo lends from the desk vault, as the pitch does. */
const LENDING = 'desk' as const
const POLL_ACTION_MS = 1500

export const DEMO_TITLE = 'Live demo: one secured loan, signed by both sides'
export const DEMO_LINE = 'A live demo on the XRPL Devnet with fictional institutions. Orma\'s server builds each transaction; Tidewater Payments, the vault manager and Harbor Credit Desk each sign their own in this browser, and the signed transaction goes to the Devnet. Nothing here moves real money.'
const NEEDS_RUN_HEAD = 'This page needs an operator run: open its operator link'
const NEEDS_RUN = `${NEEDS_RUN_HEAD}, /demo#run=…&token=…. The link is read once into this tab and removed from the address bar.`

// --- small helpers ----------------------------------------------------------------------------------------

function safeGet(k: string): string | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(k)
  } catch {
    return null
  }
}
function safeSet(k: string, v: string | null) {
  try {
    if (typeof sessionStorage === 'undefined') return
    if (v === null) sessionStorage.removeItem(k)
    else sessionStorage.setItem(k, v)
  } catch {
    // a convenience only: the page works without it
  }
}

const text = (v: unknown) => (v === undefined || v === null ? '—' : String(v))
const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toUpperCase() === b.toUpperCase())
const harborName = (label: string) => label.replace(/^harbor-/, 'Harbor-')
const bps = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && DEC.test(v)) ? formatBps(String(v)) : '—')
const shortId = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s)
/** Ripple epoch seconds to an ISO time in UTC. A time, never an amount. */
const rippleTime = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? new Date((n + 946684800) * 1000).toISOString().replace('.000Z', 'Z') : text(n))
const hexText = (hex: unknown) => {
  if (typeof hex !== 'string' || !/^([0-9A-Fa-f]{2})+$/.test(hex)) return text(hex)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16))))
  } catch {
    return hex
  }
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const useKeys = (): LoadedKey[] => useSyncExternalStore(keyStore.subscribe, keyStore.get, keyStore.server)

/** A transaction hash, whole, linked to the Devnet explorer: the reader sees the hash and where it lives. */
export function TxLink({ hash }: { hash: string }) {
  return (
    <a className="lnk t-fig-m" style={{ overflowWrap: 'anywhere' }} href={EXPLORER_TX + hash} target="_blank" rel="noreferrer noopener"
      aria-label={`Transaction ${hash}, opens the Devnet explorer`}>{EXPLORER_TX + hash}</a>
  )
}

/** An error as a sentence, its code beside it: never a blank. */
function ErrorNote({ code, status, message }: { code: string; status?: number; message?: string }) {
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <p className="caption"><b>{status && status >= 400 ? `${status} ${code}` : code}</b></p>
      <p className="caption">{errorSentence(code)}</p>
      {message && <p className="caption">{message}</p>}
    </div>
  )
}

const card = { border: '1px solid var(--color-line)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-raised)', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column' as const, gap: 'var(--space-3)', minWidth: 0 }
const stack = { display: 'flex', flexDirection: 'column' as const, gap: 'var(--space-3)', minWidth: 0 }
const row = { display: 'flex', flexWrap: 'wrap' as const, gap: 'var(--space-3)', alignItems: 'center' }

// --- the operator run --------------------------------------------------------------------------------------

const NO_SESSION: OperatorSession = { runId: null, token: null, pledgeActionId: null, requestActionId: null }

/** The run of the operator link: adopted from the fragment (validated, then wiped from the address bar), else sessionStorage. */
function useOperator(): OperatorSession {
  const [s, setS] = useState<OperatorSession>(() => {
    try {
      return readOperatorSession()
    } catch {
      return NO_SESSION
    }
  })
  useEffect(() => {
    const f = sessionFromFragment(location.hash)
    if (!f?.runId || !f.token || !RUN_HEX.test(f.runId) || !RUN_HEX.test(f.token)) return
    try {
      writeOperatorSession(f)
    } catch {
      // blocked storage: the run lives in this page's memory only
    }
    history.replaceState(null, '', location.pathname + location.search)
    setS(f)
  }, [])
  return s
}

// --- the lab's memory: which action each step played, per Harbor, for this run ------------------------------

export type StepKey = 'pledge1' | 'request1' | 'approve1' | 'rerequest1' | 'default' | 'pledge2' | 'request2' | 'approve2' | 'cure'
export interface SignedRecord { step: StepKey; requestId: string; role: string; purpose: string; hash: string; txType: string; at: string }
interface HarborLab { ids: Partial<Record<StepKey, string>>; signed: SignedRecord[] }
interface LabMemory { runId: string | null; harbors: Record<string, HarborLab> }
const EMPTY_HARBOR: HarborLab = { ids: {}, signed: [] }

function readMemory(runId: string | null): LabMemory {
  const raw = safeGet(LAB_KEY)
  try {
    const m = raw ? (JSON.parse(raw) as LabMemory) : null
    if (m && m.runId === runId && m.harbors && typeof m.harbors === 'object') return m
  } catch {
    // unreadable memory starts empty
  }
  return { runId, harbors: {} }
}

function useLabMemory(runId: string | null): [LabMemory, (harbor: string, f: (h: HarborLab) => HarborLab) => void] {
  const [mem, setMem] = useState<LabMemory>(() => readMemory(runId))
  const current = mem.runId === runId ? mem : readMemory(runId)
  const update = useCallback((harbor: string, f: (h: HarborLab) => HarborLab) => {
    setMem((m) => {
      const base = m.runId === runId ? m : readMemory(runId)
      const next: LabMemory = { runId, harbors: { ...base.harbors, [harbor]: f(base.harbors[harbor] ?? EMPTY_HARBOR) } }
      safeSet(LAB_KEY, JSON.stringify(next))
      return next
    })
  }, [runId])
  return [current, update]
}

// --- one role action, browser-signed ---------------------------------------------------------------------

type LabAction = Omit<RoleAction, 'state'> & {
  state: string
  preview?: ActionPreview | null
  change?: { realised?: { txHash?: string; rows?: ChangeRow[] } } | null
}
/** States the page stops reading at: the action waits for the operator, or it is over. */
const STOP = new Set(['previewed', 'validated', 'failed', 'refused', 'pending-approval'])
type Busy = 'posting' | 'confirming' | 'signing' | null
type ShownError = ActionError & { status?: number }

const money = (p?: ActionPreview | null) => (p?.money ?? {}) as Record<string, unknown>

/** The re-read verdict of a validated action: the vault's value read again (defaultL2), or the change's objects read again. */
export function rereadVerdict(act: Pick<LabAction, 'preview' | 'change'>): VerdictStatus | null {
  const realised = money(act.preview).realised as { verdict?: unknown } | undefined
  if (realised && (realised.verdict === 'MATCH' || realised.verdict === 'MISMATCH')) return realised.verdict
  const verdicts = (act.change?.realised?.rows ?? []).map((r) => r.verdict).filter((v): v is 'MATCH' | 'MISMATCH' => v === 'MATCH' || v === 'MISMATCH')
  if (verdicts.length === 0) return null
  return verdicts.includes('MISMATCH') ? 'MISMATCH' : 'MATCH'
}

interface FlowOpts {
  session: OperatorSession; role: string; action: string; id: string | null
  setId: (id: string | null) => void
  onSigned: (r: Omit<SignedRecord, 'step' | 'at'>) => void
  initial?: { act?: LabAction | null; error?: ShownError | null }
}

function useLabAction({ session, role, action, id, setId, onSigned, initial }: FlowOpts) {
  const [local, setLocal] = useState<{ act: LabAction; at: number } | null>(initial?.act ? { act: initial.act, at: 0 } : null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<ShownError | null>(initial?.error ?? null)
  const [sent, setSent] = useState<string[]>([])
  const [signError, setSignError] = useState<(ShownError & { requestId: string }) | null>(null)
  const [polled, setPolled] = useState<{ act: LabAction; at: number } | null>(null)
  const [lostId, setLostId] = useState<string | null>(null)
  /** Bumped after a confirm or a signature: the read of the action starts again from where it stopped. */
  const [kick, setKick] = useState(0)
  const realising = (a: LabAction | null | undefined) => Boolean(a && a.state === 'validated' && action === 'defaultL2' && !money(a.preview).realised)
  // GET …/actions/{id}, every 1.5 s, until the action waits for the operator or is over: the loop stops itself on
  // what it read, so an action read back after a reload is not polled forever. A network failure backs off to 10 s.
  useEffect(() => {
    const runId = session.runId
    if (!id || !runId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let fails = 0
    const path = `/api/roles/${runId}/actions/${id}`
    const cycle = async () => {
      try {
        const a = await getJson<LabAction>(path)
        if (cancelled) return
        fails = 0
        setPolled({ act: a, at: performance.now() })
        if (STOP.has(a.state) && !(a.state === 'validated' && action === 'defaultL2' && !money(a.preview).realised)) return
      } catch (e: unknown) {
        if (cancelled) return
        // the server holds no such action (it restarted, or the run changed): nothing left to read
        if (e instanceof ApiFailure && e.code === 'NOT_FOUND') return setLostId(id)
        fails += 1
      }
      if (!cancelled) timer = setTimeout(() => { void cycle() }, Math.min(POLL_ACTION_MS * 2 ** fails, 10_000))
    }
    void cycle()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [id, session.runId, kick, action])
  const mine = local && local.act.actionId === id ? local : null
  const read = polled && polled.act.actionId === id ? polled : null
  // The newer of the last answer this page received (POST, confirm, signature) and the last read of the action.
  const act: LabAction | null = read && (!mine || read.at > mine.at) ? read.act : mine?.act ?? (id ? initial?.act ?? null : null)
  const lost = Boolean(id && lostId === id)

  const keep = (a: ActionAnswer, fallbackState: string) => {
    const b = a.body
    if (!b.actionId) return false
    setId(b.actionId)
    setLocal({ act: { ...(b as unknown as LabAction), actionId: b.actionId, state: typeof b.state === 'string' ? b.state : fallbackState, preview: b.preview ?? null }, at: performance.now() })
    return true
  }

  async function start(makeBody: () => Promise<object | null>) {
    const { runId, token } = session
    if (!runId || !token) return setError({ code: 'UNAUTHORIZED' })
    setError(null)
    setSignError(null)
    setBusy('posting')
    try {
      let body: object | null
      try {
        body = await makeBody()
      } catch (e: unknown) {
        // only a ticket read precedes a POST: it failed, and nothing was sent
        return setError({ code: e instanceof ApiFailure && e.code ? e.code : 'UNREACHABLE', message: e instanceof Error ? e.message : undefined })
      }
      if (!body) return setError({ code: 'WARMING_UP' })
      const a = await postAction(action, role, runId, token, { ...body, ...BROWSER_SIGNER })
      // a preview answers { actionId, preview }: its state is read back from the action, never assumed
      if (a.status >= 200 && a.status < 300 && keep(a, 'previewing')) return
      setError({ ...(a.body.error ?? { code: 'UNREACHABLE' }), status: a.status })
    } finally {
      setBusy(null)
    }
  }

  async function confirm() {
    const { runId, token } = session
    if (!runId || !token || !id || !act) return
    setError(null)
    setBusy('confirming')
    try {
      const a = await confirmAction(runId, token, id)
      if (a.status >= 200 && a.status < 300) {
        // the 202 carries the action; without one, the action is read again
        if (!keep(a, 'queued')) setLocal({ act: { ...act, state: 'queued' }, at: performance.now() })
        setKick((k) => k + 1)
        return
      }
      setError({ ...(a.body.error ?? { code: 'UNREACHABLE' }), status: a.status })
      // a refusal at confirm is the action's state too (a 409 BREACHED: refused); read it again
      if (a.status === 409) setLocal({ act: { ...act, state: 'refused', engineResult: a.body.error?.code ?? act.engineResult }, at: performance.now() })
      setKick((k) => k + 1)
    } finally {
      setBusy(null)
    }
  }

  async function sign(t: ToSign) {
    const { runId, token } = session
    if (!runId || !token || !id) return
    setSignError(null)
    setBusy('signing')
    try {
      const { txBlob, hash } = await signRequest(t)
      const a = await postSignature(runId, token, id, { requestId: t.requestId, txBlob })
      if (a.status >= 200 && a.status < 300) {
        setSent((s) => [...s, t.requestId])
        const txType = t.kind === 'countersign' ? 'LoanSet' : text(t.txJson?.TransactionType)
        onSigned({ requestId: t.requestId, role: t.role, purpose: t.purpose, hash, txType })
        keep(a, act?.state ?? 'submitted')
        setKick((k) => k + 1)
        return
      }
      setSignError({ ...(a.body.error ?? { code: 'UNREACHABLE' }), status: a.status, requestId: t.requestId })
      // a timeout may have been received: the action is read again before anything is signed twice
      if (a.status === 0) setKick((k) => k + 1)
    } catch (e: unknown) {
      setSignError({ code: e instanceof KeyError ? e.code : 'SIGNING_FAILED', message: e instanceof Error ? e.message : undefined, requestId: t.requestId })
    } finally {
      setBusy(null)
    }
  }

  const open = act && act.state === 'awaiting-signature' && act.toSign && !sent.includes(act.toSign.requestId) ? act.toSign : null
  const waitingOnSent = Boolean(act && act.state === 'awaiting-signature' && act.toSign && sent.includes(act.toSign.requestId))
  return { act, busy, error, signError, open, waitingOnSent, lost, realising: realising(act), start, confirm, sign }
}

type Flow = ReturnType<typeof useLabAction>

// --- a signature request -----------------------------------------------------------------------------------

const FIELD_ORDER = ['TransactionType', 'Account', 'Destination', 'Amount', 'Counterparty', 'LoanBrokerID', 'PrincipalRequested', 'PaymentInterval', 'GracePeriod', 'LoanID', 'Flags', 'FinishAfter', 'CancelAfter', 'Sequence', 'Fee', 'LastLedgerSequence', 'Memos'] as const
const LOAN_MANAGE: Record<string, string> = { '65536': 'tfLoanDefault (default the loan)', '131072': 'tfLoanImpair (impair the loan)', '262144': 'tfLoanUnimpair' }

function fieldValue(name: string, v: unknown, tx: Record<string, unknown>): ReactNode {
  if (v === undefined || v === null) return null
  switch (name) {
    case 'Account': case 'Destination': case 'Counterparty':
      return typeof v === 'string' ? <HashLink hash={v} kind="accounts" /> : text(v)
    case 'Amount':
      if (typeof v === 'string') return <Amount drops={v} />
      if (typeof v === 'object' && v && 'mpt_issuance_id' in v) {
        const m = v as { mpt_issuance_id: string; value: string }
        return `${text(m.value)} vault shares (share ${shortId(m.mpt_issuance_id)})`
      }
      if (typeof v === 'object' && v && 'currency' in v) {
        const c = v as { currency: string; value: string }
        return `${text(c.value)} ${text(c.currency)}`
      }
      return text(v)
    case 'PrincipalRequested':
      return typeof v === 'string' && /^\d+$/.test(v) ? <Amount drops={v} /> : text(v)
    case 'Fee':
      return typeof v === 'string' && /^\d+$/.test(v) ? <Amount drops={v} /> : text(v)
    case 'PaymentInterval': case 'GracePeriod':
      return typeof v === 'number' ? secondsText(String(v)) : text(v)
    case 'FinishAfter': case 'CancelAfter':
      return rippleTime(v)
    case 'Flags':
      return tx.TransactionType === 'LoanManage' && LOAN_MANAGE[String(v)] ? `${text(v)} · ${LOAN_MANAGE[String(v)]}` : text(v)
    case 'Memos':
      return Array.isArray(v)
        ? v.map((m: { Memo?: { MemoType?: unknown; MemoData?: unknown } }, i) => <span key={i} className="block t-body-s">{`${hexText(m.Memo?.MemoType)}: ${shortId(text(m.Memo?.MemoData))}`}</span>)
        : text(v)
    case 'LoanBrokerID': case 'LoanID':
      return <span className="t-fig-s" title={text(v)}>{shortId(text(v))}</span>
    default:
      return text(v)
  }
}

/** The key fields of the transaction a request asks to sign, in plain rows. */
export function TxFields({ tx }: { tx: Record<string, unknown> }) {
  const rows = FIELD_ORDER.filter((k) => tx[k] !== undefined && tx[k] !== null)
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)', gap: 'var(--space-2) var(--space-4)', margin: 0 }}>
      {rows.map((k) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt className="t-label-m dim">{k}</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }} className="t-body-m">{fieldValue(k, tx[k], tx)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Who signs (role badge, address), what for, the transaction's key fields, and the Sign button. */
export function SignCard({ t, busy, error, onSign, keys }: {
  t: ToSign; busy: boolean; error: (ShownError & { requestId: string }) | null; onSign: () => void; keys: LoadedKey[]
}) {
  const now = useNow()
  const [decoded, setDecoded] = useState<{ blob: string; tx: Record<string, unknown> | null } | null>(null)
  useEffect(() => {
    if (t.kind !== 'countersign' || typeof t.txBlob !== 'string') return
    let live = true
    const blob = t.txBlob
    decodeBlob(blob).then((tx) => { if (live) setDecoded({ blob, tx }) }).catch(() => { if (live) setDecoded({ blob, tx: null }) })
    return () => { live = false }
  }, [t.kind, t.txBlob])
  const tx = t.kind === 'sign' ? t.txJson ?? null : decoded && decoded.blob === t.txBlob ? decoded.tx : null
  const k = keyFor(t, keys)
  const role = keyRoleOf(t.role)
  const who = role ? KEY_LABEL[role] : { name: t.role, role: t.role }
  const end = Date.parse(t.expiresAt)
  const left = Number.isNaN(end) ? null : end - now
  const expired = left !== null && left <= 0
  return (
    <section aria-label={`Signature requested from ${who.name}`} style={{ ...card, borderColor: 'var(--color-rule)' }}>
      <p className="t-label-m">{t.kind === 'countersign' ? 'Countersignature requested' : 'Signature requested'}</p>
      <p className="t-body-m" style={row}>
        <span className="prov">{who.role}</span>
        <strong>{who.name}</strong>
        <HashLink hash={t.account} kind="accounts" />
      </p>
      <p className="t-body-m"><strong>{t.purpose}</strong></p>
      {tx ? <TxFields tx={tx} /> : <p className="caption">{t.kind === 'countersign' ? 'Reading the borrower-signed LoanSet in this browser…' : 'The request carries no transaction to show.'}</p>}
      {t.kind === 'countersign' && <p className="caption">The borrower has already signed this LoanSet. Countersigning adds the lender&apos;s signature; the loan exists once the ledger validates it.</p>}
      <p className="caption">{left === null ? `Expires at ${t.expiresAt}` : expired ? 'This request has expired: the server fails the step with SIGNATURE_TIMEOUT and the step can be played again.' : `Expires in ${mmss(left)}`}</p>
      {!k.ok && <p role="alert" className="t-body-m">{k.message}</p>}
      <div><button type="button" className="btn btn-primary" disabled={!k.ok || busy || expired} onClick={onSign}>{busy ? 'Signing…' : `Sign as ${who.name}`}</button></div>
      <p className="caption">The key signs in this browser. Only the signed transaction is sent to the server, which checks it is the transaction it built, signed by {t.account}, before submitting it.</p>
      {error && error.requestId === t.requestId && <ErrorNote code={error.code} status={error.status} message={error.message} />}
    </section>
  )
}

// --- what an action previews and what it did ---------------------------------------------------------------

const LIMIT_LABEL: Record<string, string> = {
  maxLtvBps: 'Maximum loan-to-value at withdrawal value', maxSingleLoanDrops: 'Largest single loan', maxN2LossDrops: 'Largest loss if one loan defaults', maxLockupDays: 'Longest lock-up',
}
const limitValue = (limit: string, x: unknown) => {
  const s = text(x)
  if (!DEC.test(s)) return s
  if (limit.endsWith('Bps')) return formatBps(s)
  if (limit.endsWith('Drops')) return `${formatXrp(s)} XRP`
  if (limit.endsWith('Days')) return secondsText(s)
  return s
}
export const breachLine = (b: { limit: string; value: unknown; threshold: unknown }) =>
  `${LIMIT_LABEL[b.limit] ?? b.limit}: ${limitValue(b.limit, b.value)} against a limit of ${limitValue(b.limit, b.threshold)}.`
const statusOf = (v: unknown): VerdictStatus => (typeof v === 'string' ? v : (v as { status?: string } | null)?.status ?? 'STALE') as VerdictStatus

function PreviewMoney({ action, preview }: { action: string; preview: ActionPreview }) {
  const m = money(preview)
  const tx = (preview as { txJson?: Record<string, unknown> }).txJson
  const lines: ReactNode[] = []
  if (typeof m.error === 'string') lines.push(`The money of this action could not be computed: ${m.error}`)
  else if (action === 'pledgeEscrow') {
    if (m.reserveDrops !== undefined) {
      lines.push(<>No free collateral account is left: {LENDER_NAME} creates one and pays its <Amount drops={text(m.reserveDrops)} /> reserve. That payment is signed first, by the desk owner&apos;s key; then Tidewater signs the escrow.</>)
    } else {
      lines.push(`Simulated on the ledger: ${text(preview.engineResult)}`)
      const amount = tx?.Amount as { value?: string } | undefined
      if (amount?.value) lines.push(`${amount.value} vault shares into escrow`)
      if (typeof tx?.Destination === 'string') lines.push(<>Toward the collateral account <HashLink hash={tx.Destination} kind="accounts" />, two of three signers: Tidewater, Harbor Credit Desk and the Orma agent; its master key is disabled.</>)
    }
  } else if (action === 'requestLoan' || action === 'rerequest') {
    if (m.principalDrops !== undefined) lines.push(<>Principal: <Amount drops={text(m.principalDrops)} /></>)
    if (m.escrowIndex !== undefined) lines.push(`Collateral escrow: ${shortId(text(m.escrowIndex))}`)
    if (m.lastLedgerSequence !== undefined) lines.push(`The signed request is valid until ledger ${text(m.lastLedgerSequence)}`)
    if (lines.length === 0) lines.push(text(preview.engineResult))
  } else if (action === 'approve') {
    const col = m.collateral as { conforming?: boolean; reasons?: string[] } | undefined
    lines.push(
      <>Principal: <Amount drops={text(m.principalDrops)} /></>,
      <>Collateral at withdrawal value: <Amount drops={text(m.collateralHeldDrops)} /></>,
      `Loan-to-value at withdrawal value: ${bps(m.ltvHeldBps)} against a limit of ${bps(m.maxLtvBps)}`,
      <>Verdict at the withdrawal value: <Verdict status={statusOf(m.verdict)} /></>,
      ...((Array.isArray(m.breaches) ? m.breaches : []) as { limit: string; value: string; threshold: string }[]).map(breachLine),
      <>{`A lender pricing the shares at one XRP each: loan-to-value ${bps(m.ltv1to1Bps)}`} <Verdict status={statusOf(m.verdict1to1)} /></>,
    )
    if (col && col.conforming === false) lines.push(`Collateral refused: ${(col.reasons ?? []).join('; ')}`)
  } else if (action === 'defaultL2' && m.heldPerUnitNow !== undefined) {
    lines.push(
      `Withdrawal value per share now: ${text(m.heldPerUnitNow)} drops`,
      `Withdrawal value per share once L2 defaults: ${text(m.heldPerUnitIfDefault)} drops`,
      `${text(m.lossAfterCover)} drops: loss on the pledged shares, after the vault's cover`,
      `${text(m.cover)} drops: vault cover drawn`,
    )
  } else {
    lines.push(`Simulated on the ledger: ${text(preview.engineResult)}`)
  }
  return (
    <div style={stack}>
      <p className="caption">{`Preview · ${text(preview.provenance)} · nothing is signed or sent yet`}</p>
      {lines.map((l, i) => <p key={i} className="t-body-m">{l}</p>)}
    </div>
  )
}

const WORKING: Record<string, string> = {
  previewing: 'Reading the action back from the server…',
  queued: 'Queued on the signing account\'s serial queue…',
  approving: 'Orma re-reads the ledger, recomputes the ticket and checks the mandate at a logged ledger…',
  submitted: 'Submitted to the Devnet, waiting for validation…',
  'awaiting-signature': 'Waiting for a signature…',
}

/** The state of an action after its preview: working, a signature to give, or what the ledger did. */
function Outcome({ flow, action, verb, keys }: { flow: Flow; action: string; verb: string; keys: LoadedKey[] }) {
  const { act } = flow
  if (!act) return null
  const verdict = rereadVerdict(act)
  const realised = money(act.preview).realised as { predicted?: string; realised?: string; error?: string } | undefined
  return (
    <div role="status" style={stack}>
      {flow.open && <SignCard t={flow.open} keys={keys} busy={flow.busy === 'signing'} error={flow.signError} onSign={() => { if (flow.open) void flow.sign(flow.open) }} />}
      {flow.waitingOnSent && <p className="caption">Signed in this browser and sent. The server is checking the signature before it submits.</p>}
      {!STOP.has(act.state) && act.state !== 'awaiting-signature' && <p className="caption">{WORKING[act.state] ?? `The action is ${act.state}…`}</p>}
      {flow.realising && <p className="caption">Validated. Reading the vault again at the validation ledger…</p>}
      {act.state === 'validated' && !flow.realising && (
        <div style={stack}>
          <p className="t-body-m"><strong>{`${verb}: validated on the Devnet${act.ledgerIndex ? ` at ledger ${act.ledgerIndex}` : ''}.`}</strong></p>
          {act.txHash && <p className="t-body-m">Transaction <TxLink hash={act.txHash} /></p>}
          {action === 'defaultL2' && realised && (realised.error
            ? <p className="caption">{`The withdrawal value could not be read again: ${realised.error}`}</p>
            : <p className="t-body-m">{`Withdrawal value per share predicted ${text(realised.predicted)} drops, read again at validation ${text(realised.realised)} drops `}</p>)}
          {verdict && <p className="t-body-m">Ledger read again after validation, against the preview: <Verdict status={verdict} /></p>}
        </div>
      )}
      {act.state === 'pending-approval' && (
        <p className="t-body-m"><strong>{`Signed by ${BORROWER_NAME}; waiting for ${LENDER_NAME}'s review and countersignature.`}</strong></p>
      )}
      {act.state === 'failed' && (act.engineResult === 'SIGNATURE_TIMEOUT'
        ? <ErrorNote code="SIGNATURE_TIMEOUT" />
        : <p role="alert" className="t-body-m">{`The ledger did not apply it: ${text(act.engineResult)}. Nothing else was submitted after it.`}{act.txHash && <> <TxLink hash={act.txHash} /></>}</p>)}
      {act.state === 'refused' && !flow.error && <ErrorNote code={text(act.engineResult)} />}
    </div>
  )
}

export interface ActionSpec {
  step: StepKey
  role: 'borrower' | 'riskOfficer' | 'broker'
  action: 'pledgeEscrow' | 'requestLoan' | 'approve' | 'rerequest' | 'defaultL2'
  /** The first button: a preview, or (requestLoan) the signature itself. */
  startVerb: string
  /** The confirm after the preview; absent when the POST itself asks the signature. */
  confirmVerb?: string
  /** defaultL2: an in-page confirmation before the confirm, never a browser dialog. */
  irreversible?: string
  makeBody: () => Promise<object | null>
  /** Why it cannot start yet; null when it can. */
  blocked: string | null
  /** Played already, and not to be played again (an irreversible default). */
  done?: string | null
  primary?: boolean
  /** A step that may be played again once over (a cure for a call still open). */
  again?: boolean
}

/** One action of the timeline: its button, its preview and confirm, its signatures, what the ledger did. */
/** What a step tells the page about its action: the gates of the next steps and the parties' columns read it. */
export interface StepReport { state: string | null; txHash: string | null; open: ToSign | null }

export function ActionBlock({ spec, session, id, setId, onSigned, onReport, keys, initial }: {
  spec: ActionSpec; session: OperatorSession; id: string | null; setId: (id: string | null) => void
  onSigned: (r: Omit<SignedRecord, 'step' | 'at'>) => void; onReport?: (step: StepKey, r: StepReport) => void; keys: LoadedKey[]
  initial?: { act?: LabAction | null; error?: ShownError | null; arming?: boolean }
}) {
  const flow = useLabAction({ session, role: spec.role, action: spec.action, id, setId, onSigned, initial })
  const [arming, setArming] = useState(initial?.arming ?? false)
  const { act } = flow
  const state = act?.state ?? null
  const txHash = act?.txHash ?? null
  const open = flow.open
  // Reported on every change; the page keeps its record when nothing it reads (state, hash, request id) moved.
  useEffect(() => { onReport?.(spec.step, { state, txHash, open }) }, [state, txHash, open, onReport, spec.step])
  const noRun = !session.runId || !session.token
  const over = act && ['failed', 'refused'].includes(act.state)
  const canStart = !act || flow.lost || over || (spec.again && act.state === 'validated')
  const cls = spec.primary ? 'btn btn-primary' : 'btn btn-secondary'
  return (
    <div style={stack}>
      {flow.lost && <p className="caption">The server no longer holds this step&apos;s earlier action (it restarted, or the run changed). Play the step again.</p>}
      {spec.done && !act && <p className="t-body-m">{spec.done}</p>}
      {canStart && !spec.done && (
        <div style={stack}>
          {(spec.blocked ?? (noRun ? NEEDS_RUN : null)) && <p className="caption">{spec.blocked ?? NEEDS_RUN}</p>}
          <div>
            <button type="button" className={cls} disabled={Boolean(spec.blocked) || noRun || flow.busy !== null} onClick={() => { setArming(false); void flow.start(spec.makeBody) }}>
              {flow.busy === 'posting' ? 'Asking the server…' : over || (spec.again && act?.state === 'validated') ? `${spec.startVerb} again` : spec.startVerb}
            </button>
          </div>
        </div>
      )}
      {act?.preview && <PreviewMoney action={spec.action} preview={act.preview} />}
      {act?.state === 'previewed' && spec.confirmVerb && (
        spec.irreversible && !arming
          ? <div><button type="button" className={cls} disabled={flow.busy !== null} onClick={() => setArming(true)}>{spec.confirmVerb}</button></div>
          : (
            <div style={spec.irreversible ? { ...card, borderColor: 'var(--color-rule)' } : stack}>
              {spec.irreversible && <p className="t-body-m" role="alert"><strong>{spec.irreversible}</strong></p>}
              <div style={row}>
                <button type="button" className="btn btn-primary" disabled={flow.busy !== null} onClick={() => { void flow.confirm() }}>
                  {flow.busy === 'confirming' ? 'Sending…' : spec.irreversible ? `Confirm: ${spec.confirmVerb}` : spec.confirmVerb}
                </button>
                {spec.irreversible && <button type="button" className="btn btn-secondary" disabled={flow.busy !== null} onClick={() => setArming(false)}>Cancel</button>}
              </div>
            </div>
          )
      )}
      <Outcome flow={flow} action={spec.action} verb={spec.confirmVerb ?? spec.startVerb} keys={keys} />
      {flow.error && <ErrorNote code={flow.error.code} status={flow.error.status} message={flow.error.message} />}
      {flow.error && Array.isArray(flow.error.breaches) && (flow.error.breaches as { limit: string; value: string; threshold: string }[]).map((b, i) => <p key={i} className="t-body-m">{breachLine(b)}</p>)}
      {spec.action === 'approve' && (act?.state === 'refused' || flow.error?.code === 'BREACHED') && (
        <p className="t-body-m"><strong>{`${LENDER_NAME} signed nothing: the desk refused after its re-read, before any countersignature was asked. The refusal is in the decision log (step 7).`}</strong></p>
      )}
    </div>
  )
}

// --- the keys --------------------------------------------------------------------------------------------

export function KeysPanel({ keys }: { keys: LoadedKey[] }) {
  const [note, setNote] = useState<{ alert: boolean; text: string } | null>(null)
  const [keep, setKeepBox] = useState(keeping())
  const borrowerField = useRef<HTMLInputElement>(null)
  const brokerField = useRef<HTMLInputElement>(null)
  const deskField = useRef<HTMLInputElement>(null)
  const fieldOf = (role: KeyRole) => (role === 'borrower' ? borrowerField : role === 'broker' ? brokerField : deskField)
  const loaded = (roles: KeyRole[]) => setNote({ alert: false, text: roles.length ? `Loaded in this browser: ${roles.map((r) => KEY_LABEL[r].role.toLowerCase()).join(', ')}.` : 'No seed was given.' })
  const fail = (e: unknown) => setNote({ alert: true, text: e instanceof KeyError ? e.message : 'The keys could not be loaded. Nothing was loaded.' })

  async function fromFile(input: HTMLInputElement) {
    const file = input.files?.[0]
    input.value = '' // the same file can be loaded again, and the input holds nothing
    if (!file) return
    try {
      loaded(await loadSeeds(parseRolesFile(await file.text())))
    } catch (e: unknown) {
      fail(e)
    }
  }
  async function fromPaste() {
    const seeds: Seeds = {}
    for (const role of KEY_ROLES) {
      const el = fieldOf(role).current
      if (el && el.value.trim()) seeds[role] = el.value.trim()
    }
    try {
      loaded(await loadSeeds(seeds))
      // the fields hold no seed once it is loaded
      for (const role of KEY_ROLES) {
        const el = fieldOf(role).current
        if (el) el.value = ''
      }
    } catch (e: unknown) {
      fail(e)
    }
  }
  return (
    <Panel provenance="DECLARED" title="Signing keys, in this browser only" source="the operator, at runtime">
      <p className="t-body-m">Devnet test keys of the three parties: Tidewater (the borrower), the vault manager (role broker, who defaults L2) and the desk owner (Harbor Credit Desk&apos;s countersigning key). They stay in this tab&apos;s memory and are never sent anywhere; only signed transactions leave the browser.</p>
      <div style={row}>
        <label className="t-label-m" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          Load the roles file (JSON: accounts.borrower.seed, accounts.broker.seed)
          <input type="file" accept="application/json,.json" onChange={(e) => { void fromFile(e.currentTarget) }} style={{ minHeight: 'var(--size-control)' }} />
        </label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 'var(--space-3)' }}>
        {KEY_ROLES.map((role) => (
          <label key={role} className="t-label-m" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 0 }}>
            {`${KEY_LABEL[role].role} seed${role === 'deskOwner' ? ' (its own field: never read from the roles file)' : ''}`}
            <input ref={fieldOf(role)} type="password" autoComplete="off" spellCheck={false} placeholder="s…" style={{ minHeight: 'var(--size-control)', padding: '0 var(--space-3)', border: '1px solid var(--color-line)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)', color: 'var(--color-text)', font: 'inherit', minWidth: 0 }} />
          </label>
        ))}
      </div>
      <div style={row}>
        <button type="button" className="btn btn-secondary" onClick={() => { void fromPaste() }}>Load pasted seeds</button>
        <label className="t-body-m" style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 'var(--size-control)' }}>
          <input type="checkbox" checked={keep} onChange={(e) => { setKeep(e.currentTarget.checked); setKeepBox(e.currentTarget.checked) }} style={{ width: 20, height: 20 }} />
          Keep for this tab (cleared when the tab closes)
        </label>
        <button type="button" className="btn btn-secondary" disabled={keys.length === 0} onClick={() => { forgetKeys(); setKeepBox(false); setNote({ alert: false, text: 'Every key was forgotten by this browser.' }) }}>Forget keys</button>
      </div>
      {note && <p className="t-body-m" role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
      <div className="table-scroll">
        <table className="op-tbl">
          <thead><tr>{['Key', 'Held by', 'Address, derived in this browser'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>
            {KEY_ROLES.map((role) => {
              const k = keys.find((x) => x.role === role)
              return (
                <tr key={role}>
                  <td>{KEY_LABEL[role].role}</td>
                  <td>{KEY_LABEL[role].name}</td>
                  <td>{k ? <HashLink hash={k.address} kind="accounts" /> : <span className="dim">not loaded</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// --- the parties -----------------------------------------------------------------------------------------

const PARTIES: { role: KeyRole; title: string; side: string; signs: string[] }[] = [
  { role: 'borrower', title: BORROWER_NAME, side: 'Borrower', signs: ['the pledge of its vault shares into escrow', 'the loan request (LoanSet, first signature)', 'the cure of a margin call'] },
  { role: 'broker', title: 'Harbor vault manager', side: 'Third party: the Harbor vault\'s broker', signs: ['the default of loan L2 of its vault (LoanManage), irreversible'] },
  { role: 'deskOwner', title: LENDER_NAME, side: 'Lender', signs: ['the countersignature of the loan, after Orma re-reads the ledger', 'a new collateral account\'s reserve, when none is free'] },
]

function PartyCard({ p, keys, open, signed }: { p: typeof PARTIES[number]; keys: LoadedKey[]; open: { step: StepKey; t: ToSign }[]; signed: SignedRecord[] }) {
  const k = keys.find((x) => x.role === p.role)
  const mine = (role: string) => keyRoleOf(role) === p.role
  const waiting = open.filter((o) => mine(o.t.role))
  const done = signed.filter((s) => mine(s.role))
  return (
    <section aria-label={p.title} style={card}>
      <p className="t-label-m dim">{p.side}</p>
      <h2 className="t-heading-s">{p.title}</h2>
      <p className="t-body-s">{k ? <HashLink hash={k.address} kind="accounts" /> : <span className="dim">Key not loaded in this browser</span>}</p>
      <div>
        <p className="t-label-m">Signs in this demo</p>
        <ul className="t-body-s" style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>{p.signs.map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
      {waiting.map((o) => <p key={o.t.requestId} className="t-body-m"><strong>Signature requested: </strong>{o.t.purpose} <a className="lnk" href={`#demo-${o.step}`}>Go to the request</a></p>)}
      {done.length > 0 && (
        <div>
          <p className="t-label-m">Signed in this browser</p>
          <ul className="t-body-s" style={{ margin: 0, paddingLeft: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1, 4px)' }}>
            {done.map((s) => <li key={s.requestId} style={{ overflowWrap: 'anywhere' }}>{`${s.txType}: `}<HashLink hash={s.hash} /></li>)}
          </ul>
        </div>
      )}
    </section>
  )
}

// --- the Harbor and its tickets ---------------------------------------------------------------------------

type L2State = 'defaultable' | 'defaulted' | 'not-yet' | 'unknown'
function l2Of(t: Ticket | null): L2State {
  const p = t?.figures.payments?.find((x) => x.label === 'L2')
  if (!p) return 'unknown'
  if (p.status === 'defaulted') return 'defaulted'
  if (p.status === 'defaultable') return 'defaultable'
  return 'not-yet'
}
const L2_WORDS: Record<L2State, string> = { defaultable: 'L2 can be defaulted', defaulted: 'L2 already defaulted: already played', 'not-yet': 'L2 not past its grace period yet', unknown: 'L2 not read yet' }

/** Step 3 and 5: what Harbor's risk officer reads on the ticket, every figure the server's, with its ledger inputs. */
function TicketReview({ t, oneToOne }: { t: Ticket; oneToOne?: boolean }) {
  const f = t.figures
  return (
    <div style={stack}>
      <p className="caption">{`Ticket read at ledger ${t.ledgerIndex} · ${t.share.units} shares pledged · mandate ${t.mandate.id}`}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 'var(--space-4)' }}>
        <Figure label="Value read by all" meaning="The vault's assets over its shares, as every indexer reads it: what a lender pricing at the reported figure would lend against." figure={f.naiveValue} />
        <Figure label="Orma's withdrawal value" meaning="What the pledged shares pay out if withdrawn at this ledger, the unrealised loss taken out: the only value the desk lends against." figure={f.heldValue} />
        {f.maxLoan && <Figure label="Largest loan the mandate allows" meaning="The risk officer's maximum loan-to-value applied to the withdrawal value." figure={f.maxLoan} />}
        {f.requested && <Figure label="Loan requested" meaning="The principal Tidewater asks for." figure={f.requested} />}
        {f.ltvHeld && <Figure label="Loan-to-value at withdrawal value" meaning="The loan over the collateral at its withdrawal value." figure={f.ltvHeld} />}
        {oneToOne && f.lender1to1 && <Figure label="Loan-to-value for a lender at one-to-one" meaning="The loan over the shares valued at one XRP each, as a lender pricing shares at par would." figure={f.lender1to1} />}
      </div>
      <p className="t-body-m">Verdict at the withdrawal value: <Verdict status={statusOf(t.verdict)} /></p>
      {t.verdict.breaches.map((b) => <p key={b.limit} className="t-body-m">{breachLine(b)}</p>)}
      {oneToOne && t.verdict1to1 && <p className="t-body-m">A lender pricing the shares at one-to-one would say: <Verdict status={statusOf(t.verdict1to1)} /></p>}
    </div>
  )
}

function Step({ n, step, title, who, children }: { n: number; step: string; title: string; who: string; children: ReactNode }) {
  return (
    <li id={`demo-${step}`} style={{ ...card, listStyle: 'none', scrollMarginTop: 'var(--space-16)' }}>
      <h3 className="t-heading-s">{`${n}. ${title}`}</h3>
      <p className="t-label-m dim">{who}</p>
      {children}
    </li>
  )
}

// --- step 6: the margin call ------------------------------------------------------------------------------

function MarginLine({ call, now }: { call: MarginCall; now: number }) {
  const held = call.ltvHeldBps === null ? '—' : formatBps(String(call.ltvHeldBps))
  if (call.status === 'NONE') return <p className="t-body-m">{`No margin call on this loan at ledger ${call.ledgerIndex}: loan-to-value at withdrawal value ${held}, within the mandate's ${formatBps(String(call.maxLtvBps))}.`}</p>
  if (call.status === 'CURED') return <p className="t-body-m"><strong>{`Margin call cured at ledger ${call.ledgerIndex}: loan-to-value at withdrawal value ${held}, back within the mandate's ${formatBps(String(call.maxLtvBps))}.`}</strong></p>
  const end = call.cureBy ? Date.parse(call.cureBy) : NaN
  return (
    <div style={stack}>
      <p className="t-body-m"><strong>{`Margin call issued by ${LENDER_NAME} at ledger ${call.issuedLedger ?? '—'}: loan-to-value at withdrawal value ${held} against the mandate's ${formatBps(String(call.maxLtvBps))}.`}</strong></p>
      {call.shortfall && <p className="t-body-m">{`Cure: pledge ${call.shortfall.sharesToAdd} more shares (${formatXrp(call.shortfall.collateralValueDrops)} XRP of withdrawal value at ${call.shortfall.withdrawalValuePerShare} drops per share).`}</p>}
      {call.status === 'ISSUED' && !Number.isNaN(end) && <p className="t-body-m"><span className="t-label-m">Cure window </span><span className="t-fig-m" role="timer" aria-live="off">{end > now ? `${mmss(end - now)} left, until ${call.cureBy}` : `ended at ${call.cureBy}; the desk records the expiry at the next ledger`}</span></p>}
      {call.status === 'EXPIRED' && <p className="t-body-m">The cure window has passed. The desk may act under its escrow policy, which finishes an escrow only after a default.</p>}
      {call.reasons.length > 0 && <ul className="t-body-s" style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>{call.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {call.entryHash && <p className="t-body-s">Decision-log entry <HashLink hash={call.entryHash} noLink /></p>}
    </div>
  )
}

// --- step 7: the decision log -----------------------------------------------------------------------------

type LogEntry = (Decision & { kind?: undefined }) | (MarginCallEntry & { decision?: undefined })
interface DecisionsDoc { entries: LogEntry[]; chain: { ok: boolean; firstBadSeq?: number } }

function DecisionLog({ doc }: { doc: DecisionsDoc | null }) {
  if (!doc) return <p className="caption">Reading the desk&apos;s decision log…</p>
  const last = [...doc.entries].reverse().slice(0, 8)
  return (
    <div style={stack}>
      <p className="t-body-m">{`${doc.entries.length} entries. Hash chain recomputed by the server, each entry covering the one before it: `}<Verdict status={doc.chain.ok ? 'MATCH' : 'MISMATCH'} />{!doc.chain.ok && ` first bad entry ${text(doc.chain.firstBadSeq)}`}</p>
      <div className="table-scroll">
        <table className="op-tbl">
          <thead><tr>{['Entry', 'Decision', 'At ledger', 'Transaction', 'Entry hash'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>
            {last.map((e) => (
              <tr key={e.seq}>
                <td>{e.seq}</td>
                <td>{e.kind === 'margin-call' ? `margin call ${e.status.toLowerCase()}, loan ${shortId(e.loanId)}` : `${e.decision}${e.code ? ` (${e.code})` : ''}, ticket ${shortId(e.ticketId)}`}</td>
                <td className="t-fig-s">{e.ledgerIndex}</td>
                <td>{'txHash' in e && e.txHash ? <HashLink hash={e.txHash} /> : <span className="dim">none</span>}</td>
                <td><HashLink hash={e.hash} noLink /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="t-body-s"><a className="lnk" href={`${API_BASE}/api/desk/decisions`} target="_blank" rel="noreferrer noopener">The whole decision log, as the server serves it</a></p>
    </div>
  )
}

// --- the page ---------------------------------------------------------------------------------------------

const ticketOf = (deskPlan: DeskPlan | undefined, h: DeskPlanVault | null) => (deskPlan && h ? deskTicketPaths(deskPlan, h.vaultId).pledge : null)
async function freshTicket(path: string | null): Promise<Ticket | null> {
  return path ? getJson<Ticket>(path) : null
}
const pledgeBodyOf = (t: Ticket) => ({ vault: LENDING, share: t.share.mptId, ticketId: t.ticketId, inputsDigest: t.inputsDigest, units: t.share.units })

export function DemoLab() {
  const session = useOperator()
  const keys = useKeys()
  const [mem, update] = useLabMemory(session.runId)
  useEffect(() => { void restoreKept() }, [])
  const plan = usePoll<{ deskPlan: DeskPlan }>(deskPlanPath, 60000)
  const deskPlan = plan.data?.deskPlan
  const harbors = deskPlan?.vaults.filter((v) => v.label.startsWith('harbor-')) ?? []
  // Three Harbors at most, one poll each: the selector reads each L2's state, the steps read the chosen one.
  const t1 = usePoll<Ticket>(ticketOf(deskPlan, harbors[0] ?? null), 8000)
  const t2 = usePoll<Ticket>(ticketOf(deskPlan, harbors[1] ?? null), 8000)
  const t3 = usePoll<Ticket>(ticketOf(deskPlan, harbors[2] ?? null), 8000)
  const reads = [t1, t2, t3]
  const ticketFor = (i: number) => {
    const d = reads[i]?.data
    return d && harbors[i] && same(d.share.mptId, harbors[i].shareMptId) ? d : null
  }
  const positions = usePoll<Positions>('/api/desk/positions', 5000)
  const decisions = usePoll<DecisionsDoc>('/api/desk/decisions', 5000)
  const now = useNow()

  const [picked, setPicked] = useState<string | null>(() => safeGet(HARBOR_KEY))
  // Chosen once: the first Harbor whose L2 can still be defaulted, so a default played on stage never moves the page.
  // Decided once every Harbor's ticket has answered, a figure or an error: one failing read never holds the page.
  const auto = (() => {
    if (harbors.length === 0) return null
    if (!harbors.every((_, i) => i > 2 || reads[i]?.data || reads[i]?.code)) return null
    const states = harbors.map((_, i) => l2Of(ticketFor(i)))
    const i = states.indexOf('defaultable')
    return harbors[i >= 0 ? i : Math.max(0, states.findIndex((s) => s !== 'defaulted'))].label
  })()
  const label = picked && harbors.some((h) => h.label === picked) ? picked : auto
  const choose = (l: string) => { setPicked(l); safeSet(HARBOR_KEY, l) }
  // The automatic choice is kept as if picked: L2 played on it must not move the page to the next Harbor.
  useEffect(() => { if (!picked && auto) choose(auto) }, [picked, auto])
  const hi = harbors.findIndex((h) => h.label === label)
  const harbor = hi >= 0 ? harbors[hi] : null
  const ticket = hi >= 0 ? ticketFor(hi) : null
  const l2 = l2Of(ticket)
  const lab = (label && mem.harbors[label]) || EMPTY_HARBOR
  const ids = lab.ids

  const setId = (step: StepKey) => (id: string | null) => { if (label) update(label, (h) => ({ ...h, ids: { ...h.ids, [step]: id ?? undefined } })) }
  const onSigned = (step: StepKey) => (r: Omit<SignedRecord, 'step' | 'at'>) => { if (label) update(label, (h) => ({ ...h, signed: [...h.signed, { ...r, step, at: new Date().toISOString() }] })) }
  // What each step last read of its own action (ActionBlock reports it): the gates of the next steps, and the
  // requests the parties' columns name. Keyed by Harbor, so another Harbor's steps never open this one's.
  const [reports, setReports] = useState<Record<string, Partial<Record<StepKey, StepReport>>>>({})
  const onReport = useCallback((step: StepKey, r: StepReport) => {
    if (!label) return
    setReports((all) => {
      const was = all[label]?.[step]
      if (was && was.state === r.state && was.txHash === r.txHash && was.open?.requestId === r.open?.requestId) return all
      return { ...all, [label]: { ...all[label], [step]: r } }
    })
  }, [label])
  const rep = reports[label ?? ''] ?? {}
  const p1 = rep.pledge1, r1 = rep.request1, a1 = rep.approve1, p2 = rep.pledge2, r2 = rep.request2
  const openList = (Object.entries(rep) as [StepKey, StepReport | undefined][]).flatMap(([step, r]) => (r?.open ? [{ step, t: r.open }] : []))

  const pledgePath = ticketOf(deskPlan, harbor)
  const loan: Position | null = (() => {
    const all = positions.data?.positions ?? []
    const byHash = a1?.txHash ? all.find((p) => same(p.loanSetTxHash, a1.txHash)) : undefined
    if (byHash) return byHash
    // no loan from step 3 in this tab: the desk's loan against this Harbor's shares that carries a margin call
    return harbor ? all.find((p) => p.marginCall && p.marginCall.status !== 'NONE' && p.collateral.some((c) => same(c.shareMptId, harbor.shareMptId))) ?? null : null
  })()
  const call = loan?.marginCall ?? null
  const cureShare = loan?.collateral[0]?.shareMptId ?? null
  const cureUnits = call?.status === 'ISSUED' ? call.shortfall?.sharesToAdd ?? null : null
  const cureLending = deskPlan && loan ? lendingVaultOf(deskPlan, loan.vaultId) : null

  const common = (step: StepKey) => ({ session, id: ids[step] ?? null, setId: setId(step), onSigned: onSigned(step), onReport, keys })
  const hname = harbor ? harborName(harbor.label) : 'the Harbor'
  const signed = lab.signed

  const STEPS: { step: StepKey; spec: ActionSpec }[] = [
    {
      step: 'pledge1', spec: {
        step: 'pledge1', role: 'borrower', action: 'pledgeEscrow', startVerb: 'Preview the pledge', confirmVerb: 'Pledge shares into escrow',
        blocked: !pledgePath ? 'The desk plan and this Harbor\'s ticket are being read.' : null,
        makeBody: async () => { const t = await freshTicket(pledgePath); return t && pledgeBodyOf(t) },
      },
    },
    {
      step: 'request1', spec: {
        step: 'request1', role: 'borrower', action: 'requestLoan', startVerb: 'Sign and request loan',
        blocked: p1?.state === 'validated' ? null : 'Step 1 first: the pledge must be validated on the ledger.',
        makeBody: async () => { const t = await freshTicket(pledgePath); return t && ids.pledge1 ? { ...pledgeBodyOf(t), pledgeActionId: ids.pledge1 } : null },
      },
    },
    {
      step: 'approve1', spec: {
        step: 'approve1', role: 'riskOfficer', action: 'approve', startVerb: 'Review the request', confirmVerb: 'Approve and countersign loan',
        blocked: r1?.state === 'pending-approval' || r1?.state === 'approving' ? null : r1?.state === 'validated' ? 'This request is already approved.' : 'Step 2 first: the loan request must be signed by Tidewater.',
        makeBody: async () => (ids.request1 ? { vault: LENDING, requestActionId: ids.request1 } : null),
      },
    },
  ]
  const spec = (s: StepKey) => STEPS.find((x) => x.step === s)!.spec
  const firstOpen = (['pledge1', 'request1', 'approve1'] as StepKey[]).find((s) => {
    const a = s === 'pledge1' ? p1 : s === 'request1' ? r1 : a1
    return !a?.state || !['validated', 'pending-approval'].includes(a.state)
  })
  const prim = (s: StepKey) => ({ ...spec(s), primary: firstOpen === s })

  const defaultSpec: ActionSpec = {
    step: 'default', role: 'broker', action: 'defaultL2', startVerb: `Preview the default of L2 of ${hname}`, confirmVerb: 'Default loan L2 — irreversible',
    irreversible: `This defaults loan L2 of ${hname} on the Devnet. It cannot be undone: the vault's cover is drawn and the withdrawal value of every share falls at once.`,
    blocked: !harbor ? 'Choose a Harbor first.' : l2 === 'not-yet' ? `L2 of ${hname} is not past its grace period yet: the ledger refuses a default before then.` : null,
    done: l2 === 'defaulted' ? `L2 of ${hname} is already in default: already played. Choose another Harbor to play it again.` : null,
    makeBody: async () => (harbor ? { vault: harbor.label } : null),
    primary: firstOpen === undefined,
  }
  const pledge2Spec: ActionSpec = {
    step: 'pledge2', role: 'borrower', action: 'pledgeEscrow', startVerb: 'Preview the new pledge', confirmVerb: 'Pledge shares into escrow',
    blocked: !pledgePath ? 'The desk plan and this Harbor\'s ticket are being read.' : null,
    makeBody: async () => { const t = await freshTicket(pledgePath); return t && pledgeBodyOf(t) },
  }
  const request2Spec: ActionSpec = {
    step: 'request2', role: 'borrower', action: 'requestLoan', startVerb: 'Sign and request the new loan',
    blocked: p2?.state === 'validated' ? null : 'The new pledge must be validated first.',
    makeBody: async () => { const t = await freshTicket(pledgePath); return t && ids.pledge2 ? { ...pledgeBodyOf(t), pledgeActionId: ids.pledge2 } : null },
  }
  const approve2Spec: ActionSpec = {
    step: 'approve2', role: 'riskOfficer', action: 'approve', startVerb: 'Review the new request', confirmVerb: 'Approve and countersign loan',
    blocked: r2?.state === 'pending-approval' || r2?.state === 'approving' ? null : 'The new loan request must be signed by Tidewater first.',
    makeBody: async () => (ids.request2 ? { vault: LENDING, requestActionId: ids.request2 } : null),
  }
  const rerequestSpec: ActionSpec = {
    step: 'rerequest1', role: 'riskOfficer', action: 'rerequest', startVerb: 'Preview a re-request with a fresh ticket', confirmVerb: 'Re-request with a fresh ticket',
    blocked: r1?.state === 'pending-approval' ? null : 'Only a request still waiting for approval can be signed again.',
    makeBody: async () => (ids.request1 ? { vault: LENDING, requestActionId: ids.request1 } : null),
  }
  const cureSpec: ActionSpec = {
    step: 'cure', role: 'borrower', action: 'pledgeEscrow', startVerb: 'Preview the cure', confirmVerb: cureUnits ? `Pledge ${cureUnits} more shares` : 'Pledge more shares', again: true,
    blocked: !loan ? 'No desk loan against this Harbor\'s shares yet: play steps 1 to 3 first.' : call?.status !== 'ISSUED' ? 'No margin call is open on this loan: the cure is offered once the desk issues one.' : !cureLending ? 'This loan is not lent from the desk or spare vault, so no cure can be played from this page.' : null,
    makeBody: async () => {
      if (!cureShare || !cureUnits || !cureLending || !loan) return null
      const t = await getJson<Ticket>(cureTicketPath(cureShare, cureUnits))
      return cureBody({ lending: cureLending, share: cureShare, ticketId: t.ticketId, inputsDigest: t.inputsDigest, units: cureUnits, loanId: loan.loanId })
    },
  }

  const approveFailed = Boolean(a1?.state && ['failed', 'refused'].includes(a1.state))
  return (
    <div className="desk-stage">
      <TestNetBanner />
      <header className="desk-head">
        <div>
          <h1 className="t-heading-l">{DEMO_TITLE}</h1>
          <p className="t-body-m desk-line">{DEMO_LINE}</p>
          <p className="t-body-m dim">{session.runId && session.token ? 'Operator run: open in this tab.' : NEEDS_RUN}</p>
        </div>
      </header>

      <KeysPanel keys={keys} />

      <section aria-label="Harbor" style={stack}>
        <p className="t-label-m">The vault whose shares Tidewater pledges</p>
        {harbors.length === 0 ? <p className="caption">{plan.code ? errorSentence(plan.code) : 'Reading the desk plan…'}</p> : (
          <nav className="subtabs" aria-label="Harbor">
            {harbors.map((h, i) => (
              <button key={h.label} type="button" className="btn btn-secondary" aria-pressed={h.label === label} onClick={() => choose(h.label)}>
                {`${harborName(h.label)} · ${L2_WORDS[l2Of(ticketFor(i))]}`}
              </button>
            ))}
          </nav>
        )}
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 'var(--space-4)' }}>
        {PARTIES.map((p) => <PartyCard key={p.role} p={p} keys={keys} open={openList} signed={signed} />)}
      </div>

      <section aria-label="The flow, step by step" style={stack}>
        <h2 className="t-heading-s">{`The flow on ${hname}, step by step`}</h2>
        <ol style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <Step n={1} step="pledge1" title="Tidewater pledges its vault shares into escrow" who={`${BORROWER_NAME} signs · toward a two-of-three collateral account`}>
            <ActionBlock spec={prim('pledge1')} {...common('pledge1')} />
          </Step>
          <Step n={2} step="request1" title="Tidewater signs and requests the loan" who={`${BORROWER_NAME} signs the LoanSet first`}>
            <ActionBlock spec={prim('request1')} {...common('request1')} />
          </Step>
          <Step n={3} step="approve1" title="Harbor's risk officer reviews, Orma re-reads, Harbor countersigns" who={`${LENDER_NAME} countersigns, only after Orma re-reads the ledger and checks the mandate`}>
            {ticket ? <TicketReview t={ticket} /> : <p className="caption">Reading this Harbor&apos;s ticket at a validated ledger…</p>}
            <ActionBlock spec={prim('approve1')} {...common('approve1')} />
            {approveFailed && r1?.state === 'pending-approval' && (
              <div style={stack}>
                <p className="caption">If the signed request has expired or the borrower has sent another transaction since, Tidewater signs it again with a fresh ticket, then Harbor reviews it again.</p>
                <ActionBlock spec={rerequestSpec} {...common('rerequest1')} />
              </div>
            )}
          </Step>
          <Step n={4} step="default" title={`The vault manager defaults loan L2 of ${hname}`} who="The Harbor vault's broker signs · irreversible">
            {firstOpen !== undefined && l2 !== 'defaulted' && <p className="caption">Play steps 1 to 3 first, so a loan is out when L2 defaults: step 6 follows from it.</p>}
            <ActionBlock spec={defaultSpec} {...common('default')} />
          </Step>
          <Step n={5} step="pledge2" title="Tidewater asks for another loan; Harbor refuses, with its reason" who={`${BORROWER_NAME} signs the pledge and the request · ${LENDER_NAME} signs nothing: a refusal asks for no signature`}>
            <ActionBlock spec={pledge2Spec} {...common('pledge2')} />
            <ActionBlock spec={request2Spec} {...common('request2')} />
            {ticket && <TicketReview t={ticket} oneToOne />}
            <ActionBlock spec={approve2Spec} {...common('approve2')} />
          </Step>
          <Step n={6} step="cure" title="The margin call on the loan already out, and Tidewater's cure" who={`${LENDER_NAME} issues the call · ${BORROWER_NAME} signs the cure, a pledge that names the loan`}>
            {loan && call ? <MarginLine call={call} now={now} /> : <p className="caption">{positions.code ? errorSentence(positions.code) : 'No desk loan against this Harbor\'s shares is read yet.'}</p>}
            {loan?.loanSetTxHash && <p className="t-body-s">Loan <TxLink hash={loan.loanSetTxHash} /></p>}
            <ActionBlock spec={cureSpec} {...common('cure')} />
          </Step>
          <Step n={7} step="log" title="The decision log and the explorer links" who="Every decision of the desk, chained; every transaction signed in this browser, on the Devnet explorer">
            <DecisionLog doc={decisions.data} />
            {decisions.code && !decisions.data && <ErrorNote code={decisions.code} />}
            <div style={stack}>
              <p className="t-label-m">{`Signed in this browser for ${hname}`}</p>
              {signed.length === 0 ? <p className="caption">Nothing signed yet.</p> : (
                <ul className="t-body-s" style={{ margin: 0, paddingLeft: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                  {signed.map((s) => <li key={s.requestId} style={{ overflowWrap: 'anywhere' }}>{`${s.txType}, signed by ${roleName(s.role)}: ${s.purpose} `}<TxLink hash={s.hash} /></li>)}
                </ul>
              )}
            </div>
            <div>
              <button type="button" className="btn btn-secondary" disabled={!label || Object.keys(ids).length === 0} onClick={() => { if (label) update(label, () => EMPTY_HARBOR) }}>
                {`Forget this page's progress on ${hname} (the ledger keeps what was done)`}
              </button>
            </div>
          </Step>
        </ol>
      </section>
    </div>
  )
}

// --- smoke cases ------------------------------------------------------------------------------------------

const FIX_ADDR = 'rTidewaterFixtureAddressxxxxxxxxx'
const FIX_DESK = 'rHarborDeskFixtureAddressxxxxxxxx'
const FIX_HASH = 'AB'.repeat(32)
const FIX_REQ = 'c0'.repeat(16)
const FIX_ID = 'a1'.repeat(16)
const FIX_SESSION: OperatorSession = { runId: 'b2'.repeat(16), token: 'c3'.repeat(16), pledgeActionId: null, requestActionId: null }
const FIX_SIGN: ToSign = {
  requestId: FIX_REQ, kind: 'sign', role: 'borrower', account: FIX_ADDR, expiresAt: '2099-01-01T00:00:00Z',
  purpose: 'Tidewater pledges 5000000 Harbor-2 shares into escrow toward collateral account rCollateralFixture',
  txJson: { TransactionType: 'EscrowCreate', Account: FIX_ADDR, Destination: 'rCollateralFixture', Amount: { mpt_issuance_id: '11'.repeat(24), value: '5000000' }, FinishAfter: 846245400, Fee: '12', Sequence: 7, LastLedgerSequence: 6390020 },
}
const FIX_COUNTER: ToSign = { requestId: 'd4'.repeat(16), kind: 'countersign', role: 'deskOwner', account: FIX_DESK, expiresAt: '2099-01-01T00:00:00Z', purpose: 'Harbor Credit Desk countersigns the loan to Tidewater after the re-read at ledger 6390000', txBlob: 'ABCD' }
const KEY_OK: LoadedKey[] = [{ role: 'borrower', address: FIX_ADDR }]
const KEY_WRONG: LoadedKey[] = [{ role: 'borrower', address: 'rSomeOtherAddressxxxxxxxxxxxxxxx' }]
const noop = () => {}
const block = (spec: Partial<ActionSpec>, initial: { act?: LabAction | null; error?: ShownError | null; arming?: boolean }, id: string | null = FIX_ID, session = FIX_SESSION) => (
  <ActionBlock spec={{ step: 'pledge1', role: 'borrower', action: 'pledgeEscrow', startVerb: 'Preview the pledge', confirmVerb: 'Pledge shares into escrow', blocked: null, makeBody: async () => null, ...spec }}
    session={session} id={id} setId={noop} onSigned={noop} keys={KEY_OK} initial={initial} />
)
const act = (fields: Partial<LabAction>): LabAction => ({ actionId: FIX_ID, runId: FIX_SESSION.runId as string, role: 'borrower', action: 'pledgeEscrow', state: 'previewed', ...fields })
const FIX_ROLES_FILE = JSON.stringify({ accounts: { borrower: { seed: 'sBorrowerFixture' }, broker: { seed: 'sBrokerFixture' }, deskOwner: { seed: 'sNeverReadFixture' } } })

export interface SmokeCase { name: string; element: ReactNode; mustContain?: string[]; before?: string[]; enabledButton?: string; mustNotContain?: string[] }

export const SMOKE_CASES: SmokeCase[] = [
  {
    name: 'the lab without a run: header, keys panel, the seven steps in order, the run sentence',
    element: <DemoLab />,
    mustContain: [DEMO_TITLE, DEMO_LINE, 'Test network', 'Signing keys, in this browser only', 'Load the roles file', 'Keep for this tab', 'Forget keys', BORROWER_NAME, LENDER_NAME, 'Harbor vault manager', NEEDS_RUN_HEAD, 'type="password"'],
    before: ['Signing keys', BORROWER_NAME, 'Harbor vault manager', LENDER_NAME, '1. Tidewater pledges', '2. Tidewater signs and requests', '3. Harbor', '4. The vault manager defaults', '5. Tidewater asks for another loan', '6. The margin call', '7. The decision log'],
    mustNotContain: ['undefined', 'NaN', 'sBorrower', 'wallet', 'Wallet', 'Connect'],
  },
  {
    name: 'a signature request with the right key: purpose, fields, the enabled Sign button',
    element: <SignCard t={FIX_SIGN} keys={KEY_OK} busy={false} error={null} onSign={noop} />,
    before: ['Signature requested', FIX_SIGN.purpose, 'EscrowCreate', '5000000 vault shares', 'Expires in', `Sign as ${BORROWER_NAME}`],
    mustContain: ['<span class="prov">Borrower</span><strong>Tidewater Payments (fictional)</strong>', FIX_ADDR],
    enabledButton: `Sign as ${BORROWER_NAME}`, mustNotContain: ['Wrong key', 'No key loaded'],
  },
  {
    name: 'a signature request with the wrong key: the sentence, the Sign button disabled',
    element: <SignCard t={FIX_SIGN} keys={KEY_WRONG} busy={false} error={null} onSign={noop} />,
    mustContain: [`Wrong key loaded for ${roleName('borrower')}`, `disabled="">Sign as ${BORROWER_NAME}</button>`, 'Nothing was signed.'],
  },
  {
    name: 'a signature request without a key: no key loaded, disabled',
    element: <SignCard t={FIX_SIGN} keys={[]} busy={false} error={null} onSign={noop} />,
    mustContain: [`No key loaded for ${roleName('borrower')}`, `disabled="">Sign as ${BORROWER_NAME}</button>`],
  },
  {
    name: 'an expired request: the timeout sentence, disabled',
    element: <SignCard t={{ ...FIX_SIGN, expiresAt: '2000-01-01T00:00:00Z' }} keys={KEY_OK} busy={false} error={null} onSign={noop} />,
    mustContain: ['SIGNATURE_TIMEOUT', `disabled="">Sign as ${BORROWER_NAME}</button>`],
  },
  {
    name: 'a countersignature request names the lender',
    element: <SignCard t={FIX_COUNTER} keys={[]} busy={false} error={null} onSign={noop} />,
    mustContain: ['Countersignature requested', LENDER_NAME, 'Lender, desk owner key', FIX_COUNTER.purpose, 'The borrower has already signed this LoanSet'],
  },
  {
    name: 'a signature refused SIGNATURE_MISMATCH: the sentence, the request still open',
    element: <SignCard t={FIX_SIGN} keys={KEY_OK} busy={false} error={{ code: 'SIGNATURE_MISMATCH', status: 400, requestId: FIX_REQ }} onSign={noop} />,
    mustContain: ['400 SIGNATURE_MISMATCH', errorSentence('SIGNATURE_MISMATCH'), 'role="alert"'], enabledButton: `Sign as ${BORROWER_NAME}`,
  },
  {
    name: 'an action awaiting a signature shows its card',
    element: block({}, { act: act({ state: 'awaiting-signature', toSign: FIX_SIGN }) }),
    before: ['Signature requested', FIX_SIGN.purpose, `Sign as ${BORROWER_NAME}`],
  },
  {
    name: 'a validated pledge: the hash with its Devnet explorer link, the re-read MATCH',
    element: block({}, { act: act({ state: 'validated', txHash: FIX_HASH, ledgerIndex: 6390010, change: { realised: { txHash: FIX_HASH, rows: [{ object: { type: 'Escrow', index: 'E' }, field: 'Amount', before: null, after: '5', admitted: 'YES', rule: { source: 'rippled 3.4.1', file: 'x', line: 1 }, moneyEffect: null, verdict: 'MATCH' }] } } }) }),
    before: ['validated on the Devnet at ledger 6390010', `${EXPLORER_TX}${FIX_HASH}`, 'MATCH'], mustNotContain: ['MISMATCH'],
  },
  {
    name: 'a failed action on SIGNATURE_TIMEOUT: the sentence, play again',
    element: block({}, { act: act({ state: 'failed', engineResult: 'SIGNATURE_TIMEOUT' }) }),
    mustContain: [errorSentence('SIGNATURE_TIMEOUT'), 'Preview the pledge again'],
  },
  {
    name: 'the default previewed: its money, then the verb; armed: the in-page confirmation',
    element: block({ step: 'default', role: 'broker', action: 'defaultL2', startVerb: 'Preview the default', confirmVerb: 'Default loan L2 — irreversible', irreversible: 'This defaults loan L2 of Harbor-2 on the Devnet. It cannot be undone.' },
      { act: act({ action: 'defaultL2', role: 'broker', state: 'previewed', preview: { engineResult: 'tesSUCCESS', provenance: 'SIMULATED', money: { heldPerUnitNow: '0.800000', heldPerUnitIfDefault: '0.703000', lossAfterCover: '485000', cover: '150000' } } }), arming: true }),
    before: ['Withdrawal value per share now: 0.800000 drops', 'once L2 defaults: 0.703000 drops', 'It cannot be undone.', 'Confirm: Default loan L2 — irreversible', 'Cancel'],
  },
  {
    name: 'the default already played: disabled for good',
    element: block({ step: 'default', role: 'broker', action: 'defaultL2', startVerb: 'Preview the default', done: 'L2 of Harbor-2 is already in default: already played.' }, {}, null),
    mustContain: ['already played'], mustNotContain: ['>Preview the default</button>'],
  },
  {
    name: 'an approve refused 409 BREACHED: the reason, the breach, a lender at one-to-one PASS',
    element: block({ step: 'approve2', role: 'riskOfficer', action: 'approve', startVerb: 'Review the new request', confirmVerb: 'Approve and countersign loan' }, {
      act: act({ action: 'approve', role: 'riskOfficer', state: 'refused', engineResult: 'BREACHED', preview: { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED', money: { principalDrops: '2600000', collateralHeldDrops: '3600000', ltvHeldBps: 7222, maxLtvBps: 5344, verdict: { status: 'BREACHED' }, breaches: [], ltv1to1Bps: 5200, verdict1to1: { status: 'PASS' } } } }),
      error: { code: 'BREACHED', status: 409, breaches: [{ limit: 'maxLtvBps', value: '7222', threshold: '5344' }] },
    }),
    before: ['Verdict at the withdrawal value', 'BREACHED', 'one XRP each: loan-to-value 52.00%', 'PASS', '409 BREACHED', errorSentence('BREACHED'), 'Maximum loan-to-value at withdrawal value: 72.22% against a limit of 53.44%.', `${LENDER_NAME} signed nothing`],
    mustNotContain: ['Countersignature requested'],
  },
  {
    name: 'a pending request: signed by the borrower, waiting for the lender',
    element: block({ step: 'request1', action: 'requestLoan', startVerb: 'Sign and request loan', confirmVerb: undefined }, { act: act({ action: 'requestLoan', state: 'pending-approval', preview: { engineResult: 'not-simulated (awaiting countersignature)', provenance: 'DECLARED', money: { principalDrops: '2000000', escrowIndex: 'E5'.repeat(32), lastLedgerSequence: 6390600 } } }) }),
    mustContain: [`Signed by ${BORROWER_NAME}; waiting for ${LENDER_NAME}`, 'valid until ledger 6390600'],
  },
  {
    name: 'without a run every step says why, its button disabled',
    element: block({}, {}, null, NO_SESSION),
    mustContain: [NEEDS_RUN_HEAD, 'disabled="">Preview the pledge</button>'],
  },
  {
    name: 'the key check: the right address passes, another one is the wrong key, none is no key',
    element: <p>{[keyFor(FIX_SIGN, KEY_OK).ok ? 'ok' : 'no', keyFor(FIX_SIGN, KEY_WRONG).ok ? 'ok' : 'wrong', keyFor({ role: 'deskOwner', account: FIX_DESK }, KEY_OK).ok ? 'ok' : 'none'].join(' | ')}</p>,
    mustContain: ['ok | wrong | none'],
  },
  {
    name: 'the roles file: borrower and broker read, the desk owner never; bad JSON never echoed',
    element: <p>{(() => {
      const s = parseRolesFile(FIX_ROLES_FILE)
      let bad = ''
      try { parseRolesFile('{"accounts": sLeakFixture') } catch (e: unknown) { bad = e instanceof Error ? e.message : '' }
      return `${Object.keys(s).sort().join(',')} | ${bad.includes('sLeakFixture') ? 'echoed' : 'not echoed'}`
    })()}</p>,
    mustContain: ['borrower,broker | not echoed'], mustNotContain: ['deskOwner |'],
  },
]
