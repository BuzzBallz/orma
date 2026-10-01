/**
 * A vault's NAV through time, read from the ledger and nowhere else.
 *
 * Every transaction that modifies a Vault returns the Vault's own fields in its metadata,
 * so what the vault held at that moment is stated, not reconstructed: AssetsTotal and
 * LossUnrealized on the Vault node, and the shares on the MPTokenIssuance node when the
 * transaction moved them (there is no SharesTotal on the Vault, see xrpl.mjs). The two
 * NAVs use the formulas of poll.mjs. account_tx on the vault's pseudo-account lists every
 * transaction that touched the Vault node, impairments included, which an account_tx on
 * the broker's owner alone does not.
 */
import { num, rippleToIso } from './num.mjs'
import { FLAG } from './history.mjs'

const KIND = {
  VaultCreate: 'create', VaultDeposit: 'deposit', VaultWithdraw: 'withdraw', VaultClawback: 'clawback',
  VaultSet: 'update', LoanSet: 'loan', LoanPay: 'payment', LoanDelete: 'loan_closed',
}

function kindOf(tx) {
  if (tx.TransactionType !== 'LoanManage') return Object.hasOwn(KIND, tx.TransactionType) ? KIND[tx.TransactionType] : tx.TransactionType
  const flags = Number(tx.Flags ?? 0)
  return flags & FLAG.DEFAULT ? 'default' : flags & FLAG.IMPAIR ? 'impair' : flags & FLAG.UNIMPAIR ? 'unimpair' : 'manage'
}

/**
 * One point per successful transaction that modified the vault while it had shares.
 * `txs` is account_tx output, newest first; the points come back oldest first.
 */
export function navPoints(vault, txs) {
  const vaultId = String(vault.vaultId).toUpperCase()
  const points = []
  let shares = null

  for (const entry of [...txs].reverse()) {
    const tx = entry.tx_json ?? entry.tx ?? {}
    const meta = entry.meta ?? entry.metaData
    if (!meta || meta.TransactionResult !== 'tesSUCCESS') continue

    const nodes = (meta.AffectedNodes ?? []).map((n) => n.ModifiedNode ?? n.CreatedNode ?? n.DeletedNode).filter(Boolean)
    const fields = (n) => n.FinalFields ?? n.NewFields ?? {}

    // Only a deposit, a withdrawal or a clawback touches the issuance; between them the
    // count carries forward.
    const issuance = nodes.find((n) => n.LedgerEntryType === 'MPTokenIssuance' && fields(n).Issuer === vault.pseudoAccount)
    if (issuance) shares = num(fields(issuance).OutstandingAmount)

    const node = nodes.find((n) => n.LedgerEntryType === 'Vault' && String(n.LedgerIndex).toUpperCase() === vaultId)
    if (!node || !shares || shares.isZero()) continue

    const assets = num(fields(node).AssetsTotal)
    const loss = num(fields(node).LossUnrealized)
    points.push({
      at: entry.close_time_iso ?? rippleToIso(tx.date),
      hash: entry.hash ?? tx.hash ?? null,
      kind: kindOf(tx),
      navNaive: assets.div(shares).toFixed(6),
      navCorrect: assets.minus(loss).div(shares).toFixed(6),
      assetsTotal: assets.toFixed(0),
      lossUnrealized: loss.toFixed(0),
      sharesOutstanding: shares.toFixed(0),
    })
  }
  return points
}

// accountTx reads 5 pages of 200; a vault with more transactions than that loses its oldest.
const WINDOW = 1000

export async function fetchNavHistory(xrpl, vault) {
  const txs = await xrpl.accountTx(vault.pseudoAccount)
  return { points: navPoints(vault, txs), truncated: txs.length >= WINDOW }
}
