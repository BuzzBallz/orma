export type Phase = 'Subscription' | 'Investment' | 'Redemption'
export type Trend = 'improving' | 'stable' | 'deteriorating'
export type Severity = 'info' | 'medium' | 'high' | 'critical'
export type LoanStatus =
  | 'current' | 'due_soon' | 'overdue' | 'impaired' | 'defaultable' | 'defaulted' | 'closed'
export type DimKey = 'LIQUIDITY' | 'COVER' | 'CONCENT' | 'RECOG' | 'DEADLINE' | 'HEADLINE'

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
  redemptionAt: string; secondsToRedemption: number
  loanCount: number; distressedLoanCount: number; oraclePublished: boolean
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
  key: DimKey; label: string; value: string; unit: string
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
  nextBoundaryAt: string; secondsToNextBoundary: number
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
  explorerUrl: string
  dimensionsOnChain: { key: string; value: string; scale: number }[]
  aggregate: OracleAggregate | null           // NULL with fewer than two publishers
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
  grade: string; score: number
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
