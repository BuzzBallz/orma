// Check of the change engine, orma.change/1 (step 12). Offline by default:
//   node src/dev/check-change.mjs                 the two fixtures, the five normalisations each with its
//                                                 control, HIDDEN on a drift, the defaults table, the
//                                                 compared fields, realise MATCH and MISMATCH, the change
//                                                 rebuilt at confirm, and the role engine on a fake ledger:
//                                                 its orma.change/1 previews, the money of defaultL2 and
//                                                 money.realised, a delayed and a failing reread
//   node --env-file-if-exists=.env src/dev/check-change.mjs --capture
//                                                 read-only, once: writes src/dev/fixtures/change-first-impairment.json,
//                                                 src/dev/fixtures/change-escrow-lock.json and
//                                                 .demo/receipts/impairments-<timestamp>.json; nothing is submitted
//   node src/dev/check-change.mjs --impairments   offline: the latest impairments-* receipt against demo/<harbor>.json
// Exit: 0 all good, 1 a check failed, 2 an input is missing or unusable (the sentence says which).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import { Wallet } from 'xrpl'
import { RULES, buildChange, entryAt, hiddenOf, realise } from '../change/engine.mjs'
import { createRoleEngine } from '../roles/engine.mjs'
import { createApi } from '../api.mjs'
import { COLLATERAL_STAGES, SCHEMAS } from '../nyc/contracts.mjs'
import { issuanceIdOf, readCollateralAccount, readTicketInputs } from '../ticket/inputs.mjs'
import { buildTicket } from '../ticket/engine.mjs'
import { Xrpl } from '../xrpl.mjs'

const FIRST_IMPAIRMENT = 'src/dev/fixtures/change-first-impairment.json'
const ESCROW_LOCK = 'src/dev/fixtures/change-escrow-lock.json'
const BAKE_RECEIPT = '.demo/bake-nyc-receipt.json'
const RECEIPTS = '.demo/receipts'
const HARBORS = ['harbor-1', 'harbor-2', 'harbor-3']
const LOCKED_SENTENCE = 'Harbor-2 shares are already locked in escrow; the absent → present capture needs a lock-free holder and issuance.'

let bad = 0
let unusable = null
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`)
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const hex64 = (c) => c.repeat(64).slice(0, 64)
const fieldsOf = (change) => change.rows.map((r) => `${r.object.type}.${r.field}`)
const rowOf = (change, key) => change.rows.find((r) => `${r.object.type}.${r.field}` === key) ?? null

// --- the two fixtures -----------------------------------------------------------------------------------

/** The fixture's `before` holds two ledger_entry keys per object (index, LedgerEntryType): never compared fields. */
function fixtures() {
  console.log('Fixtures')
  if (!existsSync(FIRST_IMPAIRMENT)) {
    eq(`${FIRST_IMPAIRMENT} exists (written once by --capture)`, false, true)
  } else {
    const f = readJson(FIRST_IMPAIRMENT)
    const c = buildChange(f)
    eq('first impairment: hiddenCount 1, Vault.LossUnrealized alone', [c.hiddenCount, hiddenOf(c)], [1, ['Vault.LossUnrealized']])
    eq('first impairment: its rule is LoanManage.cpp:311 (rippled 3.4.1)', rowOf(c, 'Vault.LossUnrealized')?.rule, { source: 'rippled 3.4.1', file: 'LoanManage.cpp', line: 311 })
    eq('first impairment: real metadata, LossUnrealized absent from the Vault read at L and from PreviousFields',
      [f.before.find((o) => o.LedgerEntryType === 'Vault')?.LossUnrealized ?? null, 'LossUnrealized' in (f.simulated.meta.AffectedNodes.find((n) => n.ModifiedNode?.LedgerEntryType === 'Vault')?.ModifiedNode.PreviousFields ?? {})],
      [null, false])
    eq('first impairment: every object of before carries index and LedgerEntryType, and neither is a row',
      [f.before.every((o) => o.index && o.LedgerEntryType), fieldsOf(c).some((k) => /\.(index|LedgerEntryType)$/.test(k))], [true, false])
    eq('first impairment: the unsigned LoanManage of the bake, its txHash its demo/harbor-1.json impairL1Tx',
      [c.txType, 'TxnSignature' in f.txJson, f.txHash === readJson('demo/harbor-1.json').impairL1Tx], ['LoanManage', false, true])
    eq('first impairment: the document passes SCHEMAS.change', SCHEMAS.change(c), [])
  }
  if (!existsSync(ESCROW_LOCK)) {
    eq(`${ESCROW_LOCK} exists (written once by --capture)`, false, true)
    return
  }
  const f = readJson(ESCROW_LOCK)
  const mptoken = f.before.find((o) => o.LedgerEntryType === 'MPToken')
  const issuance = f.before.find((o) => o.LedgerEntryType === 'MPTokenIssuance')
  if (!mptoken || !issuance || 'LockedAmount' in mptoken || 'LockedAmount' in issuance) {
    console.log(`  ${LOCKED_SENTENCE}`)
    unusable = LOCKED_SENTENCE
    return
  }
  eq('escrow lock: read in its before, neither the MPToken nor the issuance carries LockedAmount', [mptoken.LockedAmount ?? null, issuance.LockedAmount ?? null], [null, null])
  const c = buildChange(f)
  eq('escrow lock: HIDDEN are the LockedAmount of the MPToken and of the MPTokenIssuance', [...hiddenOf(c)].sort(), ['MPToken.LockedAmount', 'MPTokenIssuance.LockedAmount'])
  eq('escrow lock: their rules are MPTokenHelpers.cpp:774 and :801',
    [rowOf(c, 'MPToken.LockedAmount')?.rule.line, rowOf(c, 'MPTokenIssuance.LockedAmount')?.rule.line, rowOf(c, 'MPToken.LockedAmount')?.rule.file], [774, 801, 'MPTokenHelpers.cpp'])
  eq('escrow lock: an EscrowCreate of one Harbor-2 share unit, simulated tesSUCCESS', [c.txType, f.txJson.Amount?.value, c.engineResult], ['EscrowCreate', '1', 'tesSUCCESS'])
  eq('escrow lock: the document passes SCHEMAS.change', SCHEMAS.change(c), [])
}

// --- constructed metadata --------------------------------------------------------------------------------

const BORROWER = 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv'
const POOL_A = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const SIGNER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const at = { ledgerIndex: 7000, ledgerHash: hex64('7') }
const simulatedOf = (...nodes) => ({ engine_result: 'tesSUCCESS', meta: { AffectedNodes: nodes, TransactionResult: 'tesSUCCESS' } })

function normalisations() {
  console.log('Normalisations, each on a value that would be a row without it')
  const share2 = readJson('demo/harbor-2.json').shareMptId

  // indexes: a directory's Indexes change with every object added to it
  const dir = { index: hex64('D'), LedgerEntryType: 'DirectoryNode', Owner: POOL_A, RootIndex: hex64('D'), Flags: 0, Indexes: [hex64('1')] }
  const dirMeta = simulatedOf({ ModifiedNode: { LedgerEntryType: 'DirectoryNode', LedgerIndex: hex64('D'), FinalFields: { Owner: POOL_A, RootIndex: hex64('D'), Flags: 0, Indexes: [hex64('1'), hex64('2')] }, PreviousFields: { Indexes: [hex64('1')] } } })
  const tx = { TransactionType: 'EscrowCreate', Account: BORROWER }
  eq('indexes: a DirectoryNode whose Indexes grew has no row', fieldsOf(buildChange({ txJson: tx, before: [dir], simulated: dirMeta, ...at })), [])
  eq('indexes, control: without the normalisation, DirectoryNode.Indexes is a row', fieldsOf(buildChange({ txJson: tx, before: [dir], simulated: dirMeta, ...at }, { skip: ['indexes'] })), ['DirectoryNode.Indexes'])
  // the real direction (change-escrow-lock.json): Indexes on the directory read at L, never in its metadata
  const dirReal = simulatedOf({ ModifiedNode: { LedgerEntryType: 'DirectoryNode', LedgerIndex: hex64('D'), FinalFields: { Owner: POOL_A, RootIndex: hex64('D'), Flags: 0 } } })
  eq('indexes, real direction: Indexes only on the object read at L is no row, with or without the normalisation',
    [fieldsOf(buildChange({ txJson: tx, before: [dir], simulated: dirReal, ...at })), fieldsOf(buildChange({ txJson: tx, before: [dir], simulated: dirReal, ...at }, { skip: ['indexes'] }))], [[], []])

  // defaults: NewFields leaves out the defaults the created object holds
  const escrowNew = (destination) => simulatedOf({ CreatedNode: { LedgerEntryType: 'Escrow', LedgerIndex: hex64('E'), NewFields: { Account: BORROWER, Destination: destination, Amount: { mpt_issuance_id: share2, value: '1' }, FinishAfter: 846300000, CancelAfter: 846386400 } } })
  const created = buildChange({ txJson: tx, before: [], simulated: escrowNew(POOL_A), ...at })
  eq('defaults: Escrow.DestinationNode completed to "0" by the defaults table (Destination is not Account), with OwnerNode and Flags',
    [rowOf(created, 'Escrow.DestinationNode')?.after, rowOf(created, 'Escrow.OwnerNode')?.after, rowOf(created, 'Escrow.Flags')?.after, rowOf(created, 'Escrow.DestinationNode')?.rule.line], ['0', '0', 0, 240])
  eq('defaults, control: without the normalisation, there is no Escrow.DestinationNode row', rowOf(buildChange({ txJson: tx, before: [], simulated: escrowNew(POOL_A), ...at }, { skip: ['defaults'] }), 'Escrow.DestinationNode'), null)
  eq('defaults: an escrow to its own Account carries no DestinationNode (EscrowCreate.cpp:512-521)', rowOf(buildChange({ txJson: tx, before: [], simulated: escrowNew(BORROWER), ...at }), 'Escrow.DestinationNode'), null)
  const reread = { Account: BORROWER, Destination: POOL_A, Amount: { mpt_issuance_id: share2, value: '1' }, FinishAfter: 846300000, CancelAfter: 846386400, DestinationNode: '0', OwnerNode: '0', Flags: 0, LedgerEntryType: 'Escrow', index: hex64('E') }
  eq('defaults: the created escrow read again after validation matches every row', realise(created, { txHash: hex64('F'), ...at, objects: [reread] }).realised.rows.map((r) => r.verdict), created.rows.map(() => 'MATCH'))

  // noFinalFields: a ModifiedNode that carries no FinalFields changed nothing a row could show
  const root = { index: hex64('A'), LedgerEntryType: 'AccountRoot', Account: SIGNER, Balance: '100000000', Sequence: 5, Flags: 0, OwnerCount: 0 }
  const bare = simulatedOf({ ModifiedNode: { LedgerEntryType: 'AccountRoot', LedgerIndex: hex64('A'), PreviousFields: { Balance: '100000000' } } })
  eq('noFinalFields: a ModifiedNode without FinalFields is unchanged, no row', fieldsOf(buildChange({ txJson: tx, before: [root], simulated: bare, ...at })), [])
  eq('noFinalFields, control: without the normalisation, AccountRoot.Balance is a row', fieldsOf(buildChange({ txJson: tx, before: [root], simulated: bare, ...at }, { skip: ['noFinalFields'] })), ['AccountRoot.Balance'])

  // mptIssuanceId: the synthetic id the API adds is not a ledger field (here, Harbor-2's share)
  const iss = { index: hex64('9'), LedgerEntryType: 'MPTokenIssuance', Issuer: POOL_A, Sequence: 1, OutstandingAmount: '20000000', Flags: 0x38 }
  const issMeta = simulatedOf({ ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', LedgerIndex: hex64('9'), FinalFields: { Issuer: POOL_A, Sequence: 1, OutstandingAmount: '20000000', Flags: 0x38, mpt_issuance_id: share2 }, PreviousFields: {} } })
  eq('mptIssuanceId: the synthetic mpt_issuance_id is removed, no row', fieldsOf(buildChange({ txJson: tx, before: [iss], simulated: issMeta, ...at })), [])
  eq('mptIssuanceId, control: without the normalisation, MPTokenIssuance.mpt_issuance_id is a row, wrongly HIDDEN, its value the Harbor-2 share',
    (({ field, admitted, after }) => [field, admitted, after])(buildChange({ txJson: tx, before: [iss], simulated: issMeta, ...at }, { skip: ['mptIssuanceId'] }).rows[0] ?? {}), ['mpt_issuance_id', 'HIDDEN', share2])
  // the real direction (change-escrow-lock.json): ledger_entry adds mpt_issuance_id to the issuance read at L, metadata never does
  const issRealMeta = simulatedOf({ ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', LedgerIndex: hex64('9'), FinalFields: { Issuer: POOL_A, Sequence: 1, OutstandingAmount: '20000000', Flags: 0x38 }, PreviousFields: {} } })
  const issRead = { ...iss, mpt_issuance_id: share2 }
  const issChange = buildChange({ txJson: tx, before: [issRead], simulated: issRealMeta, ...at })
  eq('mptIssuanceId, real direction: on the issuance read at L only, no row, and a reread carrying it matches',
    [fieldsOf(issChange), realise(issChange, { txHash: hex64('F'), ...at, objects: [issRead] }).realised.rows], [[], []])

  // previousTxn: PreviousTxnID and PreviousTxnLgrSeq change with every transaction that touches the object
  const loan = { index: hex64('4C'), LedgerEntryType: 'Loan', Flags: 0, PrincipalOutstanding: '10000000', PreviousTxnID: hex64('1'), PreviousTxnLgrSeq: 6990 }
  const loanMeta = simulatedOf({ ModifiedNode: { LedgerEntryType: 'Loan', LedgerIndex: hex64('4C'), FinalFields: { Flags: 0x20000, PrincipalOutstanding: '10000000', PreviousTxnID: hex64('2'), PreviousTxnLgrSeq: 6995 }, PreviousFields: { Flags: 0 } } })
  eq('previousTxn: PreviousTxnID and PreviousTxnLgrSeq are ignored, Loan.Flags alone', fieldsOf(buildChange({ txJson: tx, before: [loan], simulated: loanMeta, ...at })), ['Loan.Flags'])
  eq('previousTxn, control: without the normalisation, both are rows', fieldsOf(buildChange({ txJson: tx, before: [loan], simulated: loanMeta, ...at }, { skip: ['previousTxn'] })), ['Loan.Flags', 'Loan.PreviousTxnID', 'Loan.PreviousTxnLgrSeq'])
}

function rules() {
  console.log('HIDDEN, drift, compared fields, objects not read at L')
  const vault = { index: hex64('C0'), LedgerEntryType: 'Vault', Asset: { currency: 'XRP' }, AssetsTotal: '50000000', AssetsAvailable: '35000000', Flags: 0, shares: { OutstandingAmount: '50000000' } }
  const tx = { TransactionType: 'LoanManage', Account: SIGNER }
  // between L and the open ledger, AssetsAvailable moved to 34 XRP; the transaction sets it to 33 and sets a first LossUnrealized
  const drift = simulatedOf({ ModifiedNode: { LedgerEntryType: 'Vault', LedgerIndex: hex64('C0'), FinalFields: { Asset: { currency: 'XRP' }, AssetsTotal: '50000000', AssetsAvailable: '33000000', LossUnrealized: '10000000', Flags: 0 }, PreviousFields: { AssetsAvailable: '34000000' } } })
  const c = buildChange({ txJson: tx, before: [vault], simulated: drift, ...at })
  eq('drift: a field that moved between L and the open ledger is YES, its before its value at L', (({ admitted, before, after }) => [admitted, before, after])(rowOf(c, 'Vault.AssetsAvailable')), ['YES', '35000000', '33000000'])
  eq('HIDDEN: LossUnrealized absent at L, present after, absent from PreviousFields, with its money effect',
    (({ admitted, before, after, rule, moneyEffect }) => [admitted, before, after, rule.file, rule.line, moneyEffect])(rowOf(c, 'Vault.LossUnrealized')),
    ['HIDDEN', null, '10000000', 'LoanManage.cpp', 311, { value: '-10000000', unit: 'drops' }])
  const driftIn = simulatedOf({ ModifiedNode: { LedgerEntryType: 'Vault', LedgerIndex: hex64('C0'), FinalFields: { AssetsTotal: '50000000', AssetsAvailable: '35000000', LossUnrealized: '12000000', Flags: 0 }, PreviousFields: { LossUnrealized: '11000000' } } })
  eq('drift: a field absent at L but present on the open ledger is in PreviousFields, so YES and never HIDDEN',
    (({ admitted, before }) => [admitted, before])(rowOf(buildChange({ txJson: tx, before: [vault], simulated: driftIn, ...at }), 'Vault.LossUnrealized')), ['YES', null])
  const same = simulatedOf({ ModifiedNode: { LedgerEntryType: 'Vault', LedgerIndex: hex64('C0'), FinalFields: { Asset: { currency: 'XRP' }, AssetsTotal: '50000000', AssetsAvailable: '35000000', Flags: 0 } } })
  eq('compared fields: index, LedgerEntryType and the shares vault_info adds are never rows', fieldsOf(buildChange({ txJson: tx, before: [vault], simulated: same, ...at })), [])
  eq('compared fields: a field at its default on one side and absent on the other is unchanged',
    fieldsOf(buildChange({ txJson: tx, before: [{ ...vault, LossUnrealized: '0' }], simulated: same, ...at })), [])
  const signer = simulatedOf({ ModifiedNode: { LedgerEntryType: 'AccountRoot', LedgerIndex: hex64('5A'), FinalFields: { Account: SIGNER, Balance: '99999988', Sequence: 6, Flags: 0, OwnerCount: 1, RegularKey: BORROWER }, PreviousFields: { Balance: '100000000', Sequence: 5 } } })
  const s = buildChange({ txJson: tx, before: [vault], simulated: signer, ...at })
  eq('an object not read at L: its before is FinalFields under PreviousFields, and none of its fields is HIDDEN',
    [s.rows.map((r) => [r.field, r.before, r.after, r.admitted]), s.hiddenCount], [[['Balance', '100000000', '99999988', 'YES'], ['Sequence', 5, 6, 'YES']], 0])
  eq('money effect of a signer Balance: -12 drops', rowOf(s, 'AccountRoot.Balance').moneyEffect, { value: '-12', unit: 'drops' })
  const gone = simulatedOf({ DeletedNode: { LedgerEntryType: 'Escrow', LedgerIndex: hex64('E'), FinalFields: { Account: BORROWER, Destination: POOL_A, Amount: '5000000', Flags: 0, OwnerNode: '0', PreviousTxnID: hex64('3'), PreviousTxnLgrSeq: 6000 } } })
  const d = buildChange({ txJson: tx, before: [{ index: hex64('E'), LedgerEntryType: 'Escrow', Account: BORROWER, Destination: POOL_A, Amount: '5000000', Flags: 0, OwnerNode: '0' }], simulated: gone, ...at })
  eq('DeletedNode: each field to null, rule ApplyStateTable.cpp:183, the escrowed amount out',
    [fieldsOf(d), d.rows.every((r) => r.after === null && r.rule.line === 183), rowOf(d, 'Escrow.Amount').moneyEffect], [['Escrow.Account', 'Escrow.Amount', 'Escrow.Destination'], true, { value: '-5000000', unit: 'drops' }])
  eq('RULES carries the four hidden fields with their rippled 3.4.1 lines',
    Object.entries(RULES).map(([k, v]) => `${k}=${v.file}:${v.line}`), ['Vault.LossUnrealized=LoanManage.cpp:311', 'Vault.Data=VaultSet.cpp:144', 'MPToken.LockedAmount=MPTokenHelpers.cpp:774', 'MPTokenIssuance.LockedAmount=MPTokenHelpers.cpp:801'])

  console.log('realise')
  const after = { index: hex64('C0'), LedgerEntryType: 'Vault', Asset: { currency: 'XRP' }, AssetsTotal: '50000000', AssetsAvailable: '33000000', LossUnrealized: '10000000', Flags: 0 }
  const r = realise(c, { txHash: hex64('F'), ledgerIndex: 7003, ledgerHash: hex64('8'), objects: [after] })
  eq('realise: a reread equal to after is MATCH on every row', r.realised.rows.map((x) => x.verdict), ['MATCH', 'MATCH'])
  eq('realise: the realised document passes SCHEMAS.change', SCHEMAS.change(r), [])
  const off = realise(c, { txHash: hex64('F'), ledgerIndex: 7003, ledgerHash: hex64('8'), objects: [{ ...after, LossUnrealized: '10000001' }] })
  eq('realise: MISMATCH on the row whose reread differs, MATCH on the other', off.realised.rows.map((x) => [x.field, x.verdict]), [['AssetsAvailable', 'MATCH'], ['LossUnrealized', 'MISMATCH']])
}

// --- the role engine on a fake ledger ----------------------------------------------------------------------

const LSF_DEFAULT = 0x00010000
const LSF_IMPAIRED = 0x00020000
const CT = 846200000

/**
 * A fake ledger with one state per ledger index. Three Kestrel-like Harbors (loans of 30 and 10 XRP,
 * both late; DebtTotal 40 XRP, rates 10 %, cover 20 XRP). `simulate` applies the transaction to the open
 * state and writes metadata the way ApplyStateTable does: PreviousFields holds only fields present before.
 */
function world() {
  const W = Object.fromEntries(['holder', 'borrower', 'broker', 'deskOwner', 'agent'].map((r) => [r, Wallet.generate()]))
  // After a submission, every read at a later ledger is a reread: `gate` holds each one, `failOn` fails the
  // commands it names there (`ledger_entry:index` for the change's objects alone), `onReread` sees each one.
  const w = { L: 5000, states: new Map(), gate: null, failOn: new Set(), onReread: null, submitted: [], W, vaults: {}, reread: [], meta: true, failPreviewRead: false }
  const objects = new Map()
  const vaults = {}
  HARBORS.forEach((label, i) => {
    const pseudo = Wallet.generate().address
    const share = issuanceIdOf({ Issuer: pseudo, Sequence: 1 })
    const vid = hex64(String(i + 1)), bid = hex64('BCD'[i]), l1 = hex64(String(i + 4)), l2 = hex64(String(i + 7))
    objects.set(vid, { index: vid, LedgerEntryType: 'Vault', Account: pseudo, Owner: W.broker.address, ShareMPTID: share, Asset: { currency: 'XRP' }, VaultKind: 1, LEVersion: 1, AssetsTotal: '50000000', AssetsAvailable: '10000000', Scale: 0, RedemptionDate: 847598400, Flags: 0, OwnerNode: '0' })
    objects.set(`iss:${share}`, { index: hex64(`E${i}`), LedgerEntryType: 'MPTokenIssuance', Issuer: pseudo, Sequence: 1, OutstandingAmount: '50000000', Flags: 0x38, mpt_issuance_id: share })
    objects.set(bid, { index: bid, LedgerEntryType: 'LoanBroker', VaultID: vid, Owner: W.broker.address, LoanSequence: 3, DebtTotal: '40000000', CoverAvailable: '20000000', CoverRateMinimum: 10000, CoverRateLiquidation: 10000, Flags: 0 })
    objects.set(l1, { index: l1, LedgerEntryType: 'Loan', LoanBrokerID: bid, LoanSequence: 1, Borrower: BORROWER, PrincipalOutstanding: '30000000', TotalValueOutstanding: '30000000', Flags: 0, NextPaymentDueDate: CT - 900, GracePeriod: 60 })
    objects.set(l2, { index: l2, LedgerEntryType: 'Loan', LoanBrokerID: bid, LoanSequence: 2, Borrower: BORROWER, PrincipalOutstanding: '10000000', TotalValueOutstanding: '10000000', Flags: 0, NextPaymentDueDate: CT - 900, GracePeriod: 60 })
    vaults[label] = { label, vaultId: vid, shareMptId: share, loanBrokerId: bid, owner: W.broker.address, loans: { L1: l1, L2: l2 } }
  })
  const rootIndex = hex64('F')
  objects.set(rootIndex, { index: rootIndex, LedgerEntryType: 'AccountRoot', Account: W.broker.address, Balance: '100000000', Sequence: 10, Flags: 0, OwnerCount: 9 })
  vaults.desk = { label: 'desk', vaultId: hex64('AB'), shareMptId: '14'.repeat(24), loanBrokerId: hex64('AC'), owner: W.deskOwner.address, loans: { L1: null, L2: null }, plannedLoan: { units: '5000000', principalDrops: '2000000', paymentInterval: 86400, gracePeriod: 3600 } }
  vaults.spare = { label: 'spare', vaultId: hex64('AD'), shareMptId: '15'.repeat(24), loanBrokerId: hex64('AE'), owner: W.deskOwner.address, loans: { L1: null, L2: null } }
  w.states.set(w.L, objects)
  w.vaults = vaults
  w.rootIndex = rootIndex

  const stateAt = (L) => w.states.get(L) ?? null
  const open = () => stateAt(w.L)
  const clone = (m) => new Map([...m].map(([k, v]) => [k, structuredClone(v)]))
  const notFound = () => Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
  const findByIndex = (m, index) => [...m.values()].find((o) => o.index === String(index).toUpperCase()) ?? null

  /** The transaction applied to a copy of state m: the copy, and its metadata. */
  function apply(m, tx) {
    const next = clone(m)
    const touch = []
    const put = (o) => touch.push(o.index)
    const root = findByIndex(next, rootIndex)
    root.Balance = String(BigInt(root.Balance) - 12n)
    root.Sequence += 1
    put(root)
    if (tx.TransactionType === 'LoanManage') {
      const loan = findByIndex(next, tx.LoanID)
      const broker = findByIndex(next, loan.LoanBrokerID)
      const vault = findByIndex(next, broker.VaultID)
      const exp = BigInt(loan.PrincipalOutstanding)
      if (tx.Flags === 0x20000) { // impair: the loan's exposure becomes a paper loss
        loan.Flags |= LSF_IMPAIRED
        vault.LossUnrealized = String(BigInt(vault.LossUnrealized ?? '0') + exp)
      } else { // default, alone: min(ceil(Debt × 10 % × 10 %), exposure, cover) liquidated
        const cover = [BigInt(broker.DebtTotal) / 100n, exp, BigInt(broker.CoverAvailable)].reduce((a, b) => (a < b ? a : b))
        loan.Flags |= LSF_DEFAULT
        loan.PrincipalOutstanding = '0'
        loan.TotalValueOutstanding = '0'
        broker.CoverAvailable = String(BigInt(broker.CoverAvailable) - cover)
        broker.DebtTotal = String(BigInt(broker.DebtTotal) - exp)
        vault.AssetsTotal = String(BigInt(vault.AssetsTotal) - (exp - cover) + (w.lastDigit ?? 0n))
        vault.AssetsAvailable = String(BigInt(vault.AssetsAvailable) + cover)
      }
      put(loan); put(broker); put(vault)
    }
    const strip = ({ index, LedgerEntryType, ...f }) => f
    const AffectedNodes = touch.map((index) => {
      const was = findByIndex(m, index)
      const now = findByIndex(next, index)
      const PreviousFields = Object.fromEntries(Object.entries(strip(was)).filter(([k, v]) => JSON.stringify(now[k]) !== JSON.stringify(v)))
      return { ModifiedNode: { LedgerEntryType: now.LedgerEntryType, LedgerIndex: index, FinalFields: strip(now), PreviousFields } }
    })
    return { next, meta: { AffectedNodes, TransactionResult: 'tesSUCCESS' } }
  }

  const xrpl = {
    lastLedger: null, lastLedgerHash: null, lastCloseTime: null,
    async closeTime() {
      this.lastLedger = w.L
      this.lastLedgerHash = hex64(w.L.toString(16).toUpperCase())
      this.lastCloseTime = CT
      return CT
    },
    async req(p) {
      const L = p.ledger_index
      if (L > 5000) {
        const kind = p.command === 'ledger_entry' && p.index ? 'ledger_entry:index' : p.command
        w.reread.push(kind)
        w.onReread?.(kind)
        if (w.gate) await w.gate
        if (w.failOn.has(kind)) throw Object.assign(new Error('lgrNotFound'), { data: { error: 'lgrNotFound' } })
      }
      if (L === 5000 && w.failPreviewRead && p.command === 'ledger_entry' && p.index) throw Object.assign(new Error('lgrNotFound'), { data: { error: 'lgrNotFound' } })
      if (p.command === 'ledger') {
        if (!stateAt(L)) throw Object.assign(new Error('lgrNotFound'), { data: { error: 'lgrNotFound' } })
        return { result: { ledger_hash: hex64(L.toString(16).toUpperCase()), ledger: { ledger_index: L, close_time: CT + 4 * (L - 5000) } } }
      }
      const m = stateAt(L)
      if (!m) throw Object.assign(new Error('lgrNotFound'), { data: { error: 'lgrNotFound' } })
      if (p.command === 'vault_info') {
        const v = m.get(p.vault_id)
        if (!v) throw notFound()
        return { result: { vault: { ...v, shares: m.get(`iss:${v.ShareMPTID}`) }, ledger_index: L } }
      }
      if (p.command === 'ledger_entry') {
        let node = null
        if (p.mpt_issuance) node = m.get(`iss:${p.mpt_issuance}`) ?? null
        else if (p.loan) node = [...m.values()].find((o) => o.LedgerEntryType === 'Loan' && o.LoanBrokerID === p.loan.loan_broker_id && o.LoanSequence === p.loan.loan_seq) ?? null
        else if (p.index) node = findByIndex(m, p.index)
        if (!node) throw notFound()
        return { result: { node: structuredClone(node), ledger_index: L } }
      }
      if (p.command === 'account_objects' && p.type === 'loan_broker') {
        return { result: { account_objects: [...m.values()].filter((o) => o.LedgerEntryType === 'LoanBroker' && o.Owner === p.account), ledger_index: L } }
      }
      throw new Error(`fake ledger: no ${p.command}`)
    },
    client: { autofill: async (tx) => ({ ...tx, Sequence: findByIndex(open(), rootIndex).Sequence, Fee: '12', LastLedgerSequence: tx.LastLedgerSequence ?? w.L + 20 }) },
  }
  const simulate = async (tx) => (w.meta
    ? { engine_result: 'tesSUCCESS', engine_result_message: 'The simulated transaction would have been applied.', meta: apply(open(), tx).meta, ledger_index: w.L + 1 }
    : { engine_result: 'temBAD_FEE', engine_result_message: 'Invalid fee, negative or not XRP.', ledger_index: w.L + 1 }) // nothing applied, no metadata
  const submit = async (tx) => {
    const { next } = apply(open(), tx)
    w.L += 2
    w.states.set(w.L, next)
    w.submitted.push(tx)
    return { txHash: hex64(String(w.submitted.length)), engineResult: 'tesSUCCESS', ledgerIndex: w.L }
  }
  const reader = {
    serverTime: '2026-10-25T12:00:00Z', ledgerIndex: w.L, snapshots: new Map(), vaultIds: [], missing: new Set(), passes: 1, degraded: false,
    all: () => HARBORS.map((l) => ({ vaultId: vaults[l].vaultId, vault: { vaultId: vaults[l].vaultId, shareMptId: vaults[l].shareMptId } })),
    getByShareMpt(id) { return this.all().find((s) => s.vault.shareMptId.toUpperCase() === String(id).toUpperCase()) ?? null },
    get: () => null,
  }
  return { w, xrpl, simulate, submit, reader, vaults, apply, W }
}

const MANDATE = {
  schema: 'orma.mandate/1', id: 'desk-1', desk: 'Test desk (fictional)', riskOfficer: SIGNER, hash: hex64('9'), anchorTx: hex64('8'),
  limits: { maxLtvBps: 6000, maxSingleLoanDrops: '10000000', maxN2LossDrops: '10000000', maxLockupDays: 30 },
  policy: { escrowFinish: 'only-after-default', finishAfterMarginSeconds: 14400, approvalSlackSeconds: 120, cancelAfterOffsetSeconds: 86400 },
}

async function engineOn(fx) {
  const engine = createRoleEngine({ reader: fx.reader, xrpl: fx.xrpl, env: {}, accounts: fx.W, vaults: fx.vaults, mandate: () => MANDATE, submit: fx.submit, simulate: fx.simulate })
  const api = createApi(fx.reader, { port: 0, nyc: engine, demo: { run: async () => engine.newRun(), kill: async () => ({}), unkill: async () => ({}) } })
  await api.listen()
  const port = api.server.address().port
  const call = (method, path, { token, body } = {}) => new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let s = ''
      res.on('data', (c) => { s += c })
      res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }))
    })
    r.on('error', reject)
    r.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const run = (await call('POST', '/api/demo/run')).body
  return {
    engine, api, run,
    post: (role, action, body) => call('POST', `/api/roles/${run.runId}/${role}/${action}`, { token: run.token, body }),
    confirm: (actionId) => call('POST', `/api/roles/${run.runId}/actions/${actionId}/confirm`, { token: run.token }),
    get: async (actionId) => (await call('GET', `/api/roles/${run.runId}/actions/${actionId}`)).body,
    /** Every GET until a final state; each response kept. */
    async until(actionId, seen = []) {
      for (let i = 0; i < 2000; i++) {
        const a = await this.get(actionId)
        seen.push(a)
        if (['validated', 'failed', 'refused'].includes(a.state)) return a
        await new Promise((r) => setImmediate(r))
      }
      throw new Error(`action ${actionId} never settled`)
    },
  }
}

async function roleEngine() {
  console.log('Role engine on a fake ledger')
  {
    const fx = world()
    const e = await engineOn(fx)
    const p = await e.post('broker', 'impairL1', { vault: 'harbor-1' })
    eq('impairL1 preview: 202, an orma.change/1 that passes SCHEMAS.change', [p.status, p.body.preview.schema, SCHEMAS.change(p.body.preview)], [202, 'orma.change/1', []])
    eq('impairL1 preview: LossUnrealized of the healthy vault HIDDEN, the Loan flag and the broker account YES',
      [p.body.preview.hiddenCount, hiddenOf(p.body.preview), fieldsOf(p.body.preview).sort()],
      [1, ['Vault.LossUnrealized'], ['AccountRoot.Balance', 'AccountRoot.Sequence', 'Loan.Flags', 'Vault.LossUnrealized']])
    eq('impairL1 preview: simulatedAt is the validated L the objects were read at', p.body.preview.simulatedAt, { ledgerIndex: 5000, ledgerHash: hex64((5000).toString(16).toUpperCase()) })

    // an object value changes between the preview and the confirm: the broker account pays for another transaction
    const root = fx.w.states.get(fx.w.L).get(fx.w.rootIndex)
    root.Balance = '99999000'
    root.Sequence = 11
    await e.confirm(p.body.actionId)
    const v = await e.until(p.body.actionId)
    eq('a value changed between preview and confirm: the change is rebuilt at confirm, realise MATCH on every row',
      [v.state, v.change.rows.find((r) => r.field === 'Balance')?.before, v.change.realised.rows.map((r) => r.verdict)],
      ['validated', '99999000', v.change.rows.map(() => 'MATCH')])
    const objects = [...fx.w.states.get(v.ledgerIndex).values()]
    eq('control: the preview\'s change against the same reread would be MISMATCH on the account',
      realise(p.body.preview, { txHash: v.txHash, ledgerIndex: v.ledgerIndex, ledgerHash: hex64('1'), objects }).realised.rows.filter((r) => r.verdict === 'MISMATCH').map((r) => r.field).sort(),
      ['Balance', 'Sequence'])
    eq('the validated action passes SCHEMAS.action and its change SCHEMAS.change', [SCHEMAS.action(v), SCHEMAS.change(v.change)], [[], []])
    await e.api.close()
  }

  for (const [name, lastDigit, verdict] of [['an equal reread', 0n, 'MATCH'], ['a reread that differs in the last digit', 50n, 'MISMATCH']]) {
    const fx = world()
    fx.w.lastDigit = lastDigit
    const e = await engineOn(fx)
    const p = await e.post('broker', 'defaultL2', { vault: 'harbor-2' })
    const inputs = await readTicketInputs(fx.xrpl, { shareMptId: fx.vaults['harbor-2'].shareMptId, reader: fx.reader, at: { ledgerIndex: 5000, ledgerHash: p.body.preview.simulatedAt.ledgerHash, closeTime: CT }, history: false })
    const n2 = buildTicket(inputs, { op: 'pledge', units: '5000000', mandate: MANDATE, principalDrops: '2000000' }).figures.n2.find((x) => x.loanId === fx.vaults['harbor-2'].loans.L2)
    const money = p.body.preview.money
    if (lastDigit === 0n) {
      eq('defaultL2 preview: orma.change/1 with money, four decimal strings, never Figures',
        [p.body.preview.schema, Object.keys(money), Object.values(money).every((x) => typeof x === 'string')], ['orma.change/1', ['heldPerUnitNow', 'heldPerUnitIfDefault', 'lossAfterCover', 'cover'], true])
      eq('defaultL2 preview: money.heldPerUnitIfDefault, lossAfterCover and cover are the n2 entry of L2 at the preview L',
        [money.heldPerUnitIfDefault, money.lossAfterCover, money.cover], [n2.heldPerUnitIfDefault.value, n2.lossAfterCover.value, n2.cover.value])
      eq('defaultL2 preview: Kestrel, L2 of 10 XRP alone: 1.000000 now, 0.808000 if it defaults, cover 400000', [money.heldPerUnitNow, money.heldPerUnitIfDefault, money.cover], ['1.000000', '0.808000', '400000'])
    }
    await e.confirm(p.body.actionId)
    const v = await e.until(p.body.actionId)
    eq(`defaultL2 validated, ${name}: money.realised { predicted, realised, verdict } is ${verdict}`,
      [v.state, v.preview.money.realised.predicted, v.preview.money.realised.verdict], ['validated', '0.808000', verdict])
    if (lastDigit !== 0n) eq('the reread differs in the last digit: realised 0.808001', v.preview.money.realised.realised, '0.808001')
    else eq('the change of the confirm is realised, MATCH on every row', v.change.realised.rows.every((r) => r.verdict === 'MATCH'), true)
    await e.api.close()
  }

  {
    const fx = world()
    const e = await engineOn(fx)
    const p = await e.post('broker', 'defaultL2', { vault: 'harbor-3' })
    // seen from inside the fake: the published action at each reread after validation
    const published = []
    fx.w.onReread = () => {
      const a = e.engine.action(e.run.runId, p.body.actionId)
      published.push([a.state, Boolean(a.change?.realised), Boolean(a.preview?.money?.realised)])
    }
    let release
    fx.w.gate = new Promise((r) => { release = r })
    await e.confirm(p.body.actionId)
    const seen = []
    const settle = e.until(p.body.actionId, seen)
    // let the confirm reach its reread, polled the whole time, then answer it
    for (let i = 0; i < 2000 && fx.w.reread.length === 0; i++) await new Promise((r) => setImmediate(r))
    for (let i = 0; i < 20; i++) seen.push(await e.get(p.body.actionId))
    release()
    const v = await settle
    const okEach = seen.every((a) => ['queued', 'submitted'].includes(a.state) || (a.state === 'validated' && a.preview?.money?.realised && a.change?.realised))
    eq('delayed reread: every GET is queued, submitted, or validated with preview.money.realised and change.realised already there',
      [okEach, seen.some((a) => a.state === 'submitted'), v.state], [true, true, 'validated'])
    eq('during every reread (the ledger, the vault, the change\'s objects) the action is submitted, with neither realised: one publication',
      [published.every(([s, c, m]) => s === 'submitted' && !c && !m), ['ledger', 'vault_info', 'ledger_entry:index'].every((k) => fx.w.reread.includes(k))], [true, true])
    await e.api.close()
  }
  for (const [fail, what, money] of [
    ['ledger', 'the validation ledger', 'error'],
    ['vault_info', 'the vault (read first)', 'error'],
    ['ledger_entry:index', 'the change\'s objects, lgrNotFound never read as absent', 'MATCH'],
  ]) {
    const fx = world()
    const e = await engineOn(fx)
    const p = await e.post('broker', 'defaultL2', { vault: 'harbor-1' })
    fx.w.failOn.add(fail)
    await e.confirm(p.body.actionId)
    const v = await e.until(p.body.actionId)
    const r = v.preview.money.realised
    eq(`a reread that fails on ${what}: validated, money.realised ${money}, change.realised absent`,
      [v.state, r.error ? (typeof r.error === 'string' ? 'error' : r.error) : r.verdict, 'realised' in v.change], ['validated', money, false])
    await e.api.close()
  }
  {
    const fx = world()
    fx.w.meta = false
    const e = await engineOn(fx)
    const p = await e.post('broker', 'impairL1', { vault: 'harbor-2' })
    eq('a simulate without metadata (temBAD_FEE): the preview is still orma.change/1, no row, SCHEMAS.change passes',
      [p.status, p.body.preview.schema, p.body.preview.rows, p.body.preview.engineResult, SCHEMAS.change(p.body.preview)], [202, 'orma.change/1', [], 'temBAD_FEE', []])
    await e.confirm(p.body.actionId)
    const v = await e.until(p.body.actionId)
    eq('its confirm fails with that engine result and keeps no change', [v.state, v.engineResult, v.change], ['failed', 'temBAD_FEE', null])
    await e.api.close()
  }
  {
    const fx = world()
    fx.w.failPreviewRead = true
    const e = await engineOn(fx)
    const p = await e.post('broker', 'impairL1', { vault: 'harbor-1' })
    eq('an object the simulation touches cannot be read at L (lgrNotFound): no preview, never a document short of its HIDDEN row',
      [p.status, p.body?.error?.code, p.body?.preview], [500, 'INTERNAL', undefined])
    await e.api.close()
  }
}

// --- --capture -----------------------------------------------------------------------------------------

const unsigned = (tx) => {
  const { TxnSignature, SigningPubKey, Signers, ctid, date, ledger_index, hash, inLedger, ...rest } = tx
  return rest
}
const objectsOf = (before) => Object.values(before).filter((o) => o && typeof o === 'object' && o.LedgerEntryType)
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const write = (path, doc) => {
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
  console.log(`  wrote ${path}`)
}

function stop(sentence) {
  console.log(`  ${sentence}`)
  process.exitCode = 2
}

async function capture() {
  if (!existsSync(BAKE_RECEIPT)) return stop(`${BAKE_RECEIPT} is missing: the capture runs in clone A, after the bake.`)
  const receipt = readJson(BAKE_RECEIPT)
  const harbor1 = readJson('demo/harbor-1.json')
  const imp = receipt.impairments?.['harbor-1']
  if (!imp?.meta || !imp.before) return stop('The bake receipt carries no impairments.harbor-1 with its metadata and its before.')
  if (imp.txHash !== harbor1.impairL1Tx) return stop(`The receipt's impairment ${imp.txHash} is not demo/harbor-1.json impairL1Tx ${harbor1.impairL1Tx}.`)
  const before1 = objectsOf(imp.before)
  if (before1.length !== 4 || before1.some((o) => !o.index)) return stop('An object of the receipt\'s before is missing or has no index; nothing was written.')

  // (b) the escrow lock, simulated on a lock-free holder and issuance of Harbor-2
  const harbor2 = readJson('demo/harbor-2.json')
  const desk = readJson('demo/desk.json')
  const mandate = readJson('demo/mandate-desk-1.json')
  const holder = receipt.roles?.holder
  if (!holder) return stop('The bake receipt names no holder address.')
  const share = harbor2.shareMptId
  const x = new Xrpl(process.env.XRPL_WS ?? 'wss://s.devnet.rippletest.net:51233')
  try {
    const t0 = await x.closeTime()
    const L = x.lastLedger
    const H = x.lastLedgerHash
    const read = async (params) => {
      try {
        return (await x.req({ command: 'ledger_entry', ...params, ledger_index: L })).result.node
      } catch (e) {
        if (e?.data?.error === 'entryNotFound') return null
        throw e
      }
    }
    const holderToken = await read({ mptoken: { mpt_issuance_id: share, account: holder } })
    const issuance = await read({ mpt_issuance: share })
    if (!holderToken || !issuance) return stop(`The holder's MPToken or the Harbor-2 issuance was not found at ledger ${L}; nothing was written.`)
    if ('LockedAmount' in holderToken || 'LockedAmount' in issuance) return stop(LOCKED_SENTENCE)
    let destination = null
    for (const address of desk.collateral?.accounts?.['harbor-2'] ?? []) {
      const acct = await readCollateralAccount(x, { address, shareMptId: share, at: { ledgerIndex: L, ledgerHash: H }, ...COLLATERAL_STAGES.free, history: true })
      if (acct.conforming && (acct.pledges ?? []).length === 0) {
        destination = address
        break
      }
    }
    if (!destination) return stop('No collateral account of harbor-2 is free at this ledger; nothing was written.')
    const plan = desk.plannedLoan
    const finishAfter = t0 + plan.paymentInterval + plan.gracePeriod + mandate.policy.finishAfterMarginSeconds
    const txJson = await x.client.autofill({
      TransactionType: 'EscrowCreate', Account: holder, Destination: destination, Amount: { mpt_issuance_id: share, value: '1' },
      FinishAfter: finishAfter, CancelAfter: finishAfter + mandate.policy.cancelAfterOffsetSeconds, LastLedgerSequence: L + 20,
    })
    const sim = (await x.req({ command: 'simulate', tx_json: txJson })).result
    if (sim.engine_result !== 'tesSUCCESS') return stop(`The EscrowCreate simulates ${sim.engine_result}: ${sim.engine_result_message ?? ''}; nothing was written.`)
    const before2 = []
    for (const n of sim.meta?.AffectedNodes ?? []) {
      const m = n.ModifiedNode ?? n.DeletedNode
      if (!m) continue
      const obj = await entryAt(x, m.LedgerIndex, L)
      if (!obj) return stop(`The ${m.LedgerEntryType} ${m.LedgerIndex} the simulation modifies was not found at ledger ${L}; nothing was written.`)
      before2.push({ ...obj, index: obj.index ?? m.LedgerIndex })
    }
    const capturedAt = new Date().toISOString()
    mkdirSync('src/dev/fixtures', { recursive: true })
    write(FIRST_IMPAIRMENT, {
      txJson: unsigned(imp.txJson), before: before1, simulated: { engine_result: imp.meta.TransactionResult, meta: imp.meta },
      ledgerIndex: imp.before.ledgerIndex, ledgerHash: imp.before.ledgerHash, capturedAt, txHash: imp.txHash,
    })
    write(ESCROW_LOCK, {
      txJson, before: before2, simulated: { engine_result: sim.engine_result, engine_result_message: sim.engine_result_message, meta: sim.meta, ledger_index: sim.ledger_index },
      ledgerIndex: L, ledgerHash: H, capturedAt,
    })
  } finally {
    await x.disconnect?.()
  }

  // every Harbor's impairment and statement, from the same receipt
  const entry = (harbor, e) => {
    const c = buildChange({ txJson: unsigned(e.txJson), before: objectsOf(e.before), simulated: { engine_result: e.meta.TransactionResult, meta: e.meta }, ledgerIndex: e.before.ledgerIndex, ledgerHash: e.before.ledgerHash })
    return { harbor, txHash: e.txHash, hiddenCount: c.hiddenCount, hidden: hiddenOf(c) }
  }
  const doc = {
    capturedAt: new Date().toISOString(),
    impairments: HARBORS.map((h) => entry(h, receipt.impairments[h])),
    statements: HARBORS.map((h) => entry(h, receipt.statements[h])),
  }
  mkdirSync(RECEIPTS, { recursive: true })
  write(join(RECEIPTS, `impairments-${stamp()}.json`), doc)
  for (const e of doc.impairments) eq(`${e.harbor} impairment: hiddenCount 1, ['Vault.LossUnrealized']`, [e.hiddenCount, e.hidden], [1, ['Vault.LossUnrealized']])
  for (const e of doc.statements) eq(`${e.harbor} statement: hiddenCount 1, ['Vault.Data']`, [e.hiddenCount, e.hidden], [1, ['Vault.Data']])
  if (bad) process.exitCode = 1
}

// --- --impairments -------------------------------------------------------------------------------------

function impairments() {
  const files = existsSync(RECEIPTS) ? readdirSync(RECEIPTS).filter((f) => /^impairments-.*\.json$/.test(f)).sort() : []
  if (!files.length) {
    console.log(`  no ${RECEIPTS}/impairments-*.json: run --capture first`)
    process.exitCode = 2
    return
  }
  const doc = readJson(join(RECEIPTS, files.at(-1)))
  console.log(`Receipt ${files.at(-1)}`)
  for (const harbor of HARBORS) {
    const demo = readJson(`demo/${harbor}.json`)
    const i = doc.impairments?.find((e) => e.harbor === harbor)
    eq(`${harbor} impairment: txHash its impairL1Tx, hiddenCount 1, hidden ['Vault.LossUnrealized'] and its impairL1Hidden`,
      [i?.txHash === demo.impairL1Tx, i?.hiddenCount, i?.hidden, JSON.stringify(i?.hidden) === JSON.stringify(demo.impairL1Hidden)], [true, 1, ['Vault.LossUnrealized'], true])
    const s = doc.statements?.find((e) => e.harbor === harbor)
    eq(`${harbor} statement: txHash its statementTx, hiddenCount 1, hidden ['Vault.Data']`, [s?.txHash === demo.statementTx, s?.hiddenCount, s?.hidden], [true, 1, ['Vault.Data']])
  }
  console.log(bad ? `\n  ${bad} failed` : '\n  all ok')
  process.exitCode = bad ? 1 : 0
}

// --- dispatch (last: every const above is initialised) ------------------------------------------------

const mode = process.argv.includes('--capture') ? 'capture' : process.argv.includes('--impairments') ? 'impairments' : 'offline'
if (mode === 'capture') {
  await capture()
  console.log(process.exitCode === 2 ? '' : bad ? `\n  ${bad} failed` : '\n  all ok')
} else if (mode === 'impairments') {
  impairments()
} else {
  fixtures()
  normalisations()
  rules()
  await roleEngine()
  console.log(unusable ? `\n  unusable fixture: ${unusable}` : bad ? `\n  ${bad} failed` : '\n  all ok')
  process.exitCode = unusable ? 2 : bad ? 1 : 0
}
