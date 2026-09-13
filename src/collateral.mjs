/**
 * Escrowed vault shares as collateral.
 *
 * A Ripple product lead described the institutional flow as necessarily off-ledger:
 * an LP puts vault shares in a multisig and pledges them to a second broker, who
 * lends against them. We found that XLS-85 TokenEscrow accepts MPT amounts, and vault
 * shares ARE MPTs, so the pledge can be made ON-LEDGER and therefore verifiable.
 * Confirmed on Devnet: EscrowCreate with Amount {mpt_issuance_id, value} -> tesSUCCESS.
 *
 * That matters because it turns the valuation question from private to public. Once
 * the collateral is an object anyone can read, the only remaining question is what it
 * is WORTH, and that is exactly where the naive reading fails:
 *
 *   naive   = shares x (AssetsTotal / SharesOutstanding)
 *   correct = shares x ((AssetsTotal - LossUnrealized) / SharesOutstanding)
 *
 * A lender marking the first number is over-collateralised on paper and short in
 * reality, and the impairment that caused it emitted PreviousFields:{} so a
 * metadata-diffing indexer never saw it.
 */
import { num, str, Decimal } from './num.mjs'
import { logger } from './log.mjs'

const log = logger('collateral')
const EXPLORER = 'https://devnet.xrpl.org'

/**
 * Find escrows holding a given vault's share MPT.
 *
 * An Escrow appears in the owner directory of BOTH the pledgor and the beneficiary,
 * with the same object index. Verified on Devnet: escrow 8752254D... is returned by
 * account_objects for both accounts. So a lender CAN enumerate collateral pledged in
 * their favour by scanning their own objects, which is the question that matters, and
 * we must DEDUPE BY INDEX or the same pledge is counted once per account scanned.
 *
 * What genuinely does not exist is a global index from an mpt_issuance_id to every
 * escrow holding it; you still have to start from an account.
 *
 * @param {import('./xrpl.mjs').Xrpl} xrpl
 * @param {string} shareMptId
 * @param {string[]} accounts accounts that might own such an escrow
 */
export async function findShareEscrows(xrpl, shareMptId, accounts) {
  /** @type {Map<string, object>} keyed by escrow index: the same object is returned
   * by both the pledgor's and the beneficiary's directory. */
  const byId = new Map()
  for (const account of [...new Set(accounts.filter(Boolean))]) {
    let objects = []
    try {
      objects = await xrpl.accountObjects(account, 'escrow')
    } catch (e) {
      log.debug('escrow scan failed', { account, err: (e?.data?.error ?? String(e)).slice(0, 60) })
      continue
    }
    for (const o of objects) {
      const amt = o.Amount
      if (!amt || typeof amt !== 'object' || amt.mpt_issuance_id !== shareMptId) continue
      const id = o.index ?? o.LedgerIndex ?? null
      if (id && byId.has(id)) continue
      byId.set(id, {
        escrowId: id,
        pledgor: o.Account,
        beneficiary: o.Destination ?? null,
        shares: num(amt.value),
        finishAfter: o.FinishAfter ?? null,
        cancelAfter: o.CancelAfter ?? null,
        condition: o.Condition ?? null,
        // Same reasoning as the oracle object: the explorer resolves transactions, not
        // bare ledger indexes. For an escrow that has not been finished or cancelled this
        // is its EscrowCreate.
        lastTxId: o.PreviousTxnID ?? null,
      })
    }
  }
  return [...byId.values()]
}

/**
 * Value one pledge two ways. This is the product applied to a lender's actual position.
 * @param {{shares: import('decimal.js').Decimal}} escrow
 * @param {string} navNaive  decimal string, assets per share
 * @param {string} navCorrect decimal string, loss-adjusted assets per share
 */
export function valuePledge(escrow, navNaive, navCorrect) {
  const shares = num(escrow.shares)
  const naive = shares.times(num(navNaive))
  const correct = shares.times(num(navCorrect))
  const overstatement = naive.minus(correct)
  return {
    shares: shares.toFixed(0),
    valueNaive: naive.toFixed(0),
    valueCorrect: correct.toFixed(0),
    overstatement: overstatement.toFixed(0),
    overstatementPct: naive.isZero() ? '0.00' : overstatement.div(naive).times(100).toFixed(2),
  }
}

/**
 * Everything a lender holding escrowed shares needs, in the contract's string style.
 * `haircutPct` is the lender's own policy discount, applied to the HONEST value —
 * a haircut absorbs volatility, it does not absorb a misstatement.
 */
export function presentCollateral(escrows, snap, haircutPct = 0) {
  const hc = num(haircutPct).div(100)
  const pledges = escrows.map((e) => {
    const v = valuePledge(e, snap.navNaive, snap.navCorrect)
    const lendable = num(v.valueCorrect).times(new Decimal(1).minus(hc))
    return {
      escrowId: e.escrowId,
      pledgor: e.pledgor,
      beneficiary: e.beneficiary,
      ...v,
      haircutPct: num(haircutPct).toFixed(2),
      maxLendable: lendable.toFixed(0),
      finishAfter: e.finishAfter,
      cancelAfter: e.cancelAfter,
      lastTxId: e.lastTxId ?? null,
      explorerUrl: e.lastTxId
        ? `${EXPLORER}/transactions/${e.lastTxId}`
        : e.pledgor ? `${EXPLORER}/accounts/${e.pledgor}` : null,
    }
  })
  const totalShares = pledges.reduce((a, p) => a.plus(num(p.shares)), new Decimal(0))
  const totalNaive = pledges.reduce((a, p) => a.plus(num(p.valueNaive)), new Decimal(0))
  const totalCorrect = pledges.reduce((a, p) => a.plus(num(p.valueCorrect)), new Decimal(0))
  const totalOver = totalNaive.minus(totalCorrect)
  return {
    shareMptId: snap.vault.shareMptId,
    navNaive: snap.navNaive,
    navCorrect: snap.navCorrect,
    pledgeCount: pledges.length,
    totalShares: totalShares.toFixed(0),
    totalValueNaive: totalNaive.toFixed(0),
    totalValueCorrect: totalCorrect.toFixed(0),
    totalOverstatement: totalOver.toFixed(0),
    totalOverstatementPct: totalNaive.isZero() ? '0.00' : totalOver.div(totalNaive).times(100).toFixed(2),
    pledges,
  }
}
