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
  source: string; transactionResult: string; finding: string; why: string
  vaultNode: { ledgerIndex: string; previousFields: Record<string, unknown>; finalFields: Record<string, string> }
  loanNode: { ledgerIndex: string; previousFields: Record<string, unknown>; finalFieldsFlags: number }
  readings: {
    naive: { formula: string; value: string }
    correct: { formula: string; value: string }
    divergenceBps: number
  }
}
