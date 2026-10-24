export type Phase = 'Subscription' | 'Investment' | 'Redemption' | 'Open'
export type Trend = 'improving' | 'stable' | 'deteriorating'
export type Severity = 'info' | 'medium' | 'high' | 'critical'
export type LoanStatus =
  | 'current' | 'due_soon' | 'overdue' | 'impaired' | 'defaultable' | 'defaulted' | 'closed'
export type DimKey = 'LIQUIDITY' | 'COVER' | 'CONCENT' | 'RECOG' | 'DEADLINE' | 'HEADLINE'

/** GET /api/methodology: the table the score applies for capital already destroyed. */
export interface MethodRules {
  methodVersion: string; ladder: string[]
  realisedLoss: { atLeastPct: number; notches: number; floor: string | null }[]
  managerConduct: {
    deductions: { orderingSelfServing: number; orderingMixed: number; perDefaultWithoutImpairment: number; perCoverWithdrawal: number }
    grades: { atLeast: number; grade: string }[]
  }
}

export interface Health {
  ok: boolean; contractVersion: string; source: 'fixtures' | 'devnet'
  network: string; ledgerIndex: number; serverTime: string; buildVersion: string
  degraded?: boolean                // ADDITIVE, contract §0.0 A3 — present only while upstream is degraded
  lastLedgerAgeSeconds?: number     // ADDITIVE, contract §0.0 A3
}

export interface Asset {
  kind: string; currency: string; issuer: string | null; mptIssuanceId: string | null
}

export interface VaultRow {
  vaultId: string; label: string | null; owner: string; pseudoAccount: string; asset: Asset
  vaultKind: 'ClosedEnded' | 'OpenEnded'; phase: Phase
  grade: string; gradeNumeric: number; trend: Trend
  assetsTotal: string; assetsAvailable: string; lossUnrealized: string
  navNaive: string; navCorrect: string; navDivergenceBps: number
  redemptionAt: string | null; secondsToRedemption: number | null
  loanCount: number; distressedLoanCount: number; oraclePublished: boolean
  /** Absent from a server older than this field. */
  freshness?: Freshness
}

/** How old this facility's own reading is: a failed read keeps the last good one. */
export interface Freshness {
  readAt: string; readLedgerIndex: number; ageSeconds: number; stale: boolean
}

export interface VaultDetailFields extends VaultRow {
  shareMptId: string; sharesOutstanding: string; scale: number
  withdrawalPolicy: string; isPrivate: boolean; domainId: string | null
  subscriptionAt: string; leVersion: string; explorerUrl: string
}

export interface Broker {
  loanBrokerId: string; owner: string; pseudoAccount: string
  debtTotal: string; debtMaximum: string; coverAvailable: string
  coverRateMinimum: number; coverRateLiquidation: number; managementFeeRate: number
  coverRequired: string; coverShortfall: string; maxLiquidatableNow: string
  strandedCoverFraction: string
}

export interface Dimension {
  key: DimKey; label: string; value: string; unit: 'ratio' | 'seconds' | 'percent' | 'grade'
  grade: string; notches: number; explain: string; worseIsHigher: boolean
}

export interface NotchStep { from: string; rule: string; delta: number; to: string }

export interface Score {
  grade: string; gradeNumeric: number; computedAt: string | null
  methodVersion: string; dimensions: Dimension[]; notchTrace: NotchStep[]
}

export interface Loan {
  loanId: string; borrower: string; status: LoanStatus
  principalOutstanding: string; totalValueOutstanding: string; managementFeeOutstanding: string
  periodicPayment: string; interestRate: number; lateInterestRate: number
  paymentInterval: number; gracePeriod: number; paymentRemaining: number
  nextPaymentDueAt: string | null            // NULL on defaulted loans
  secondsUntilDue: number                    // NEGATIVE means overdue
  secondsUntilDefaultable: number
  shareOfDebtTotal: string; impairable: boolean; explorerUrl: string
}

export interface PhaseInfo {
  phase: Phase; canDeposit: boolean; canWithdraw: boolean
  withdrawBlockedReason: string | null
  nextBoundaryAt: string | null; secondsToNextBoundary: number   // NULL in the last period
  claimsAtRedemption: string; liquidityAtRedemption: string
  projectedShortfall: string; shortfallPct: string
}

export interface OracleAggregate {
  publisherCount: number; median: string; mean: string; stdDev: string
}

export interface Oracle {
  published: boolean; oracleDocumentId: number; publisher: string; objectIndex: string
  baseAssetHex: string
  lastUpdateAt: string | null                 // NULL if this document has never published (§0.0 A4)
  ageSeconds: number; stale: boolean
  /** The OracleSet that last wrote this object. The explorer has no route for a bare index. */
  lastPublishTx: string | null
  explorerUrl: string
  /** raw is null when the object carries the pair without a price. */
  dimensionsOnChain: { key: string; value: string; raw: string | null; scale: number }[]
  aggregate: OracleAggregate | null           // NULL with fewer than two publishers
}

/** The two-publisher capture: what the ledger says when someone disagrees with us. */
export interface OracleContest extends Stamped {
  label: string; vaultId: string; baseAsset: string; quoteAsset: string
  publishers: { role: string; account: string; oracleDocumentId: number; provider: string; nav: string; basis: string; publishHash?: string | null }[]
  aggregate: { median: string | null; mean: string | null; standardDeviation: string | null; size: number | null; ledgerIndex: number | null; computedBy: string } | null
  answer: string
}

export interface Alert {
  code: string                                // open set — unknown codes must render, not crash
  severity: Severity; title: string; detail: string; sinceAt: string | null
}

export interface Stamped { serverTime: string; ledgerIndex: number }
export interface VaultsResponse extends Stamped { vaults: VaultRow[] }
export interface VaultDetail extends Stamped {
  vault: VaultDetailFields; broker: Broker; score: Score
  loans: Loan[]; phaseInfo: PhaseInfo; oracle: Oracle; alerts: Alert[]
}
export interface ApiError { error: { code: string; message: string; retryable: boolean } }

export interface IndexerRace {
  serverTime: string; ledgerIndex: number
  /** Present on a capture taken during the event; absent on the pre-event fixture. */
  capturedAt?: string; capturedDuring?: string; network?: string; buildVersion?: string
  transactionHash?: string; vaultId?: string; loanBrokerId?: string; loanId?: string
  /** Only the pre-event fixture carries this: the probe file it was lifted from. */
  source?: string
  /** The facility this capture was taken from. The route is not facility-scoped; the record is. */
  label?: string
  transactionResult: string; finding: string; why: string; verdict?: string
  vaultNode: {
    ledgerIndex: string
    previousFields: Record<string, unknown>
    finalFields: Record<string, string>
    /** The same three fields read BEFORE the impairment, proving the vault was healthy. */
    healthyBefore?: Record<string, string>
    sharesOutstanding?: string
  }
  loanNode: { ledgerIndex: string; previousFields: Record<string, unknown>; finalFieldsFlags: number | null }
  readings: {
    naive: { formula: string; value: string }
    correct: { formula: string; value: string }
    divergenceBps: number
  }
}

// --- Exhibit 3: what the manager actually did -------------------------------
// Cover consumed on a default is keyed to the manager's TOTAL outstanding book at that
// instant, not to the exposure that defaulted. Each default shrinks the base for the
// next, so the total first-loss capital consumed across a fixed set of defaults depends
// on the ORDER they are declared in — and the party choosing that order is the party
// whose capital is consumed. `fairness` is 0 when they chose the sequence worst for
// investors and 1 when they chose the best.
export type BrokerEventKind =
  | 'default' | 'impair' | 'unimpair' | 'manage' | 'cover_deposit' | 'cover_withdraw'

export interface BrokerEvent {
  kind: BrokerEventKind; at: string | null; hash: string | null; loanId: string | null
  /** false when the action left the manager's own object untouched — an impairment. */
  brokerStateKnown: boolean
  // NULL, not "0", when brokerStateKnown is false: the transaction does not report the
  // book at that moment, and a zero would read as an empty book.
  debtBefore: string | null; debtAfter: string | null
  coverBefore: string | null; coverAfter: string | null
  coverConsumed: string; principal: string
  /** The exposure the action was taken against. On an impairment, the only real figure. */
  exposure: string
  /** What a cover deposit or withdrawal moved. Null on every other kind of action. */
  amount: string | null
}

export interface Ordering {
  applicable: boolean
  reason?: string
  defaultCount: number
  actualCoverPaid?: string; bestPossible?: string; worstPossible?: string
  costToDepositors?: string; spread?: string; fairness?: string
  observedOrder?: { loanId: string | null; at: string | null; hash: string | null
    principal: string; debtBefore: string; coverConsumed: string }[]
  fairOrder?: string[]
}

export interface ReputationFinding { code: string; detail: string }

export interface Reputation {
  /** null, with `withheld`, when the record does not reach back to the broker's creation. */
  grade: string | null; score: number | null; withheld?: boolean
  observations: {
    defaults: number; impairments: number; defaultsWithoutPriorImpairment: number
    coverWithdrawals: number; eventsRetained: number
  }
  findings: ReputationFinding[]
  caveat: string
}

export interface Recommendation {
  applicable: boolean
  reason?: string
  candidates?: number
  recommendedOrder?: { loanId: string; principal: string; status: LoanStatus }[]
  coverIfFair?: string; coverIfSelfServing?: string; atStakeForDepositors?: string
}

export interface BrokerHistory extends Stamped {
  loanBrokerId: string; owner: string
  events: BrokerEvent[]
  ordering: Ordering
  reputation: Reputation
  recommendation: Recommendation
}

// --- Exhibit 4: units pledged away as collateral ----------------------------
// A haircut is applied to the HONEST value, never to the reported one: a haircut
// absorbs volatility, it does not absorb a misstatement.
export interface Pledge {
  escrowId: string; pledgor: string; beneficiary: string
  shares: string; valueNaive: string; valueCorrect: string
  overstatement: string; overstatementPct: string
  haircutPct: string; maxLendable: string
  finishAfter: string | null; cancelAfter: string | null
  explorerUrl: string | null
}

export interface Collateral extends Stamped {
  shareMptId: string | null; navNaive: string; navCorrect: string
  pledgeCount: number; totalShares: string
  totalValueNaive: string; totalValueCorrect: string
  totalOverstatement: string; totalOverstatementPct: string
  pledges: Pledge[]
}

// --- Exhibit 5: what a second lender can learn from the token alone ---------
// A holder pledged vault units has an MPT issuance id and nothing else. The token's own
// metadata carries a pointer to an honest valuation, so the loop is: read the issuance,
// decode the metadata, substitute the token's id into the pointer, follow it.
export interface ResolveStep { step: string; ok: boolean; detail: string | null }

export interface Xls89Report {
  conformant: boolean; missing: string[]; assetClassValid: boolean
  assetClass: string | null; taxonomyNote: string | null
}

export interface NavDocument {
  schema: string; asOf: string | null; ledgerIndex: number | null
  instrument: {
    kind: string; vaultId: string; shareMptId: string | null; unitsOutstanding: string
    asset: Asset; vaultKind: string; phase: Phase; redemptionAt: string
  }
  unitValue: { held: string; reported: string; divergenceBps: number; basis: string }
  valuation: { currency: string | null; scale: number; perUnitHeld: string; perUnitReported: string }
  assessment: { grade: string; gradeNumeric: number; methodVersion: string; advisory: boolean } | null
  provenance: {
    network: string; source: string; assetsTotal: string; lossUnrealized: string
    unitsOutstanding: string; recompute: string; buildVersion: string | null
  }
  // Present only when a quantity was asked for. `unpriced` when the document could not
  // be valued — never a zero standing in for an unknown.
  pledge?: {
    units: string
    valueHeld: string | null; valueReported: string | null; overstatement: string | null
    unpriced?: string
  }
}

export interface Resolution extends Stamped {
  issuanceId: string; issuer?: string; unitsOutstanding?: string
  resolved: boolean; opaque?: boolean; navUrl?: string
  steps: ResolveStep[]
  metadata: {
    present: boolean; reason?: string | null; raw?: string | null
    meta?: Record<string, unknown>; conformance?: Xls89Report
  } | null
  nav: NavDocument | null
  pledge?: NavDocument['pledge']
}

// --- Exhibit 6: who may enter ----------------------------------------------
// Read off the SHARE ISSUANCE, not the facility record: the domain reference does not
// live on the facility itself, so the obvious lookup reads like "open to everyone".
export interface AcceptedCredential { issuer: string; type: string | null; typeHex: string | null }

// --- the NAV through time ----------------------------------------------------
// One point per transaction that modified the vault, each read from that transaction's own
// metadata. Between two points nothing can change the NAV, so the last one stands until now.
export interface NavPoint {
  at: string | null; hash: string | null
  /** deposit | withdraw | loan | payment | impair | unimpair | default | clawback | ... */
  kind: string
  navNaive: string; navCorrect: string
  assetsTotal: string; lossUnrealized: string; sharesOutstanding: string
}

export interface NavHistory extends Stamped { vaultId: string; points: NavPoint[]; truncated: boolean }

export interface Gate extends Stamped {
  vaultId: string
  gated: boolean; private: boolean
  domainId: string | null; domainOwner: string | null
  acceptedCredentials: AcceptedCredential[]
  note: string | null
  /** Whether this service's own issuer is cited in that domain. Null if unknown. */
  issuerNamed: boolean | null
  raterAddress: string | null
  /**
   * The chain that built this gate, each step with the hash it landed under. Present only
   * on the facility it was baked against: the gate object says a domain exists, only this
   * says what the ledger did when two investors tried to enter it.
   */
  proof: { bakedAt: string | null; steps: GateStep[] } | null
}

export interface GateStep {
  step: string
  code: string
  ok: boolean
  hash: string | null
  note: string | null
}

// --- NYC: the orma.*/1 documents of Orma Desk -------------------------------------------------------
// Exact mirrors of the JSDoc typedefs of src/nyc/contracts.mjs (frozen at step 1, additive only). Every
// amount is a decimal string; no document carries a grade.

export type Provenance = 'REAL' | 'DECLARED' | 'MODELLED' | 'SIMULATED'
export interface FigureInput { name: string; value: string; object: string; field: string; id: string; ledgerIndex: number; ledgerHash: string }
/** The closed set of formulas a Figure may carry: the keys of FORMULAS. */
export type FormulaId =
  | 'heldValue' | 'naiveValue' | 'n1Overpayment' | 'cover' | 'heldPerUnitIfDefault' | 'lossAfterCover' | 'maxLoan'
  | 'maxUnits' | 'requested' | 'ltvHeld' | 'lender1to1' | 'cashAvailable' | 'claim' | 'lockedUntil'

export interface Figure {
  value: string
  unit: 'drops' | 'share-units' | 'ratio' | 'seconds' | 'bps'
  meaning: string
  formula: string
  formulaId: FormulaId
  inputs: FigureInput[]
  provenance: Provenance
}

export interface N2Entry { loanId: string; label: string; scenario: string; lossAfterCover: Figure; cover: Figure; heldPerUnitIfDefault: Figure; alreadyInHeld: boolean }
export interface Verdict { status: 'PASS' | 'BREACHED'; breaches: { limit: string; value: string; threshold: string }[] }

export interface Ticket {
  schema: 'orma.ticket/1'; ticketId: string; inputsDigest: string; asOf: string; ledgerIndex: number; ledgerHash: string
  op: 'pledge' | 'buy'
  share: { mptId: string; vaultId: string; units: string; shareScale: number }
  mandate: { id: string; hash: string; anchorTx: string }
  figures: {
    heldValue: Figure; naiveValue: Figure; n1Overpayment: Figure; n2: N2Entry[]
    n3: { lockedUntil: Figure; redemptionAt: string; cashAvailable: Figure; claim: Figure }
    maxLoan?: Figure; maxUnits?: Figure; requested?: Figure; ltvHeld?: Figure; lender1to1?: Figure
  }
  conduct: { recognitionLagSeconds: string[]; defaultsWithoutImpairment: number; coverOrderCostDrops: string }
  escrowPolicy: { finishAfter: string; cancelAfter: string; text: string }
  statement: Statement | null
  verdict: Verdict
  verdict1to1?: Verdict
}

export interface ChangeRow {
  object: { type: string; index: string }; field: string; before: unknown; after: unknown
  admitted: 'YES' | 'HIDDEN'; rule: { source: 'rippled 3.4.1'; file: string; line: number }
  moneyEffect: { value: string; unit: string } | null; verdict?: 'MATCH' | 'MISMATCH'
}

export interface Change {
  schema: 'orma.change/1'; txType: string; txJson: object
  simulatedAt: { ledgerIndex: number; ledgerHash: string }; engineResult: string
  rows: ChangeRow[]; hiddenCount: number; provenance: 'SIMULATED'
  realised?: { txHash: string; ledgerIndex: number; ledgerHash: string; rows: ChangeRow[] }
}

export interface Mandate {
  schema: 'orma.mandate/1'; id: string; desk: string; riskOfficer: string
  limits: { maxLtvBps: number; maxSingleLoanDrops: string; maxN2LossDrops: string; maxLockupDays: number }
  policy: { escrowFinish: 'only-after-default'; finishAfterMarginSeconds: number; approvalSlackSeconds: number; cancelAfterOffsetSeconds: number }
  issuedAt: string; hash: string; anchorTx: string
}

export interface Mark {
  schema: 'orma.mark/1'; shareMptId: string; verdict: 'agree' | 'disagree'
  reason?: 'SPOOFED' | 'RECOMPUTE_MISMATCH' | 'ORACLE_MISMATCH' | 'UNREACHABLE'
  tolerance: string; steps: { step: string; ok: boolean; detail: string }[]
  ledgerIndex: number; ledgerHash: string; node: string
}

export interface StatementDoc { s: 'orma.stmt/1'; loan?: string; kind: 'impaired' | 'defaulted' | 'repaid' | 'note'; text: string; at: number }
export interface StatementCheck { status: 'CONSISTENT' | 'INCONSISTENT' | 'NOT_CHECKABLE' | 'UNPARSEABLE'; detail: string; provenance: 'REAL'; ledgerIndex: number; ledgerHash: string }
export interface Statement { provenance: 'DECLARED'; raw: string; owner: string; doc: StatementDoc | null; consistency: StatementCheck }

export interface CollateralAccount {
  address: string; signers: { borrower: string; desk: string; agent: string }; quorum: number
  masterDisabled: boolean; regularKey: string | null; depositAuth: boolean; mptAuthorized: boolean; sharesHeld: string; escrowCount: number; ownerCount: number
  pledges?: { account: string; sequence: number; index: string; txHash: string; ledgerIndex: number }[]
  conforming: boolean; reasons: string[]; provenance: 'REAL'; ledgerIndex: number; ledgerHash: string
}

export interface FeedEvent {
  id: string
  type: 'LOAN_LATE' | 'IMPAIRMENT' | 'DEFAULT' | 'COVER_DRAWN' | 'SHARES_PLEDGED' | 'LOAN_ORIGINATED' | 'STATEMENT'
    | 'MARGIN_CALL_ISSUED' | 'MARGIN_CALL_CURED' | 'MARGIN_CALL_EXPIRED' // step 20, DECLARED
  provenance: 'REAL' | 'DECLARED'
  vaultId: string; loanId?: string; ledgerIndex: number; ledgerHash: string; txHash?: string
  why: string; moneyEffect: { value: string; unit: string } | null
  receipts: { object: string; field: string; before: unknown; after: unknown }[]
  statement?: Statement
  /** On a MARGIN_CALL_* event: the decision-log entry that records it. */
  entryHash?: string
}

// --- step 20, margin call (addendum A11): mirrors of src/nyc/contracts.mjs --------------------------------

export interface MarginPolicy {
  schema: 'orma.marginpolicy/1'; id: string; mandateHash: string; trigger: 'maxLtvBps'; cureSeconds: number
  realWorldNote: string; cureAction: 'pledgeEscrow'; afterExpiry: string; issuedAt: string; hash: string; anchorTx: string
}
export type MarginStatus = 'NONE' | 'ISSUED' | 'CURED' | 'EXPIRED'
export interface MarginCall {
  status: MarginStatus; loanId: string
  issuedLedger: number | null; issuedAt: string | null; cureBy: string | null
  ltvHeldBps: number | null; maxLtvBps: number
  shortfall: { collateralValueDrops: string; sharesToAdd: string; withdrawalValuePerShare: string } | null
  reasons: string[]; provenance: 'DECLARED'; ledgerIndex: number; ledgerHash: string
  entryHash?: string; triggerTx?: string
}
export interface MarginCallEntry {
  seq: number; prevHash: string; kind: 'margin-call'; status: 'ISSUED' | 'CURED' | 'EXPIRED'; loanId: string
  mandateHash: string; policyHash: string; issuedLedger: number; issuedAt: string; cureBy: string; ltvHeldBps: number | null; maxLtvBps: number
  ledgerIndex: number; ledgerHash: string; hash: string
}
/** GET /api/desk/margin-calls */
export interface MarginCalls { ledgerIndex: number; ledgerHash: string; policy: MarginPolicy; marginCalls: MarginCall[] }

export interface UniverseVault {
  vaultId: string
  asset: { currency: 'XRP' } | { currency: string; issuer: string } | { mpt_issuance_id: string }
  brokers: string[]; priced: boolean; perUnitHeld?: string; perUnitNaive?: string; reason?: string; seen: 'known' | 'live'
}

export interface Universe {
  schema: 'orma.universe/1'; ledgerIndex: number; ledgerHash: string; count: number
  vaults: UniverseVault[]
  coverage: { known: number; live: number; liveSinceLedger: number | null }
  banner: 'not live on mainnet'
}

export interface Decision {
  seq: number; prevHash: string; ticketId: string; mandateHash: string
  decision: 'approved' | 'refused' | 'declined'; code?: string; txHash?: string; ledgerIndex: number; ledgerHash: string; hash: string
}

/** A role action's state; `previewing` is internal and never served, `approving` is a request while its approve confirms. */
export type ActionState = 'previewed' | 'pending-approval' | 'approving' | 'queued' | 'submitted' | 'validated' | 'failed' | 'refused'
export interface RoleAction { actionId: string; runId: string; role: string; action: string; vault?: string; state: ActionState; txHash?: string; engineResult?: string; ledgerIndex?: number }

// Fails tsc -b if any of the twelve is missing: an export that is absent or unused compiles otherwise.
const _typeProbe: [Ticket, Change, Mandate, Mark, FeedEvent, Universe, Decision, Figure, Provenance, FormulaId, Statement, CollateralAccount] | null = null
void _typeProbe
// The four of step 20, the same way.
const _marginProbe: [MarginPolicy, MarginCall, MarginCallEntry, MarginCalls] | null = null
void _marginProbe
