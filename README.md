# Orma

## Built in New York

Nobody can tell you what an XRPL vault share is worth, so nobody can safely lend against it. Orma prices
a vault share straight from the ledger, and Orma Desk lets institutions borrow against their locked
shares, with a report their risk committee can sign.

[Desk](https://ormaprotocol.com/desk) · [Site](https://ormaprotocol.com) · [Docs](https://buzzballz.github.io/orma/) ·
[HACKATHON.md](HACKATHON.md): where the event's work starts, and how to check that without trusting us.
It was committed at the start of the build (`4eccf89`), from the plan, and two of its sentences describe
the plan, not the result: the step tags do not run to `step-16-rehearsal`, and not every transaction of the
event is captured yet. The tags actually pushed, what was not built and what is not captured are below.

At the XRPL hackathon in New York, 24–25 October 2026 (Lending & Borrowing track), we built **Orma Desk**,
collateral management for XRPL lending. It sits on Orma's information layer, built in Paris in September 2026.
Everything runs on XRPL Devnet, the only network where XLS-65 vaults and XLS-66 lending exist. The three Harbor
vaults, the lender and the borrower of the demo are fictional.

Today, every XRPL lending vault is closed-ended: `LoanBrokerSet` refuses an open-ended vault
(`tecNO_PERMISSION`, [rippled#8076](https://github.com/XRPLF/rippled/pull/8076), merged on 26 August 2026),
and capital stays locked until redemption (`VaultWithdraw` returns `tecTOO_SOON` for the whole Investment
phase, from `SubscriptionDate` to `RedemptionDate`).
A holder who needs XRP before then borrows against the shares, and the lender has to price a share the vault
will not redeem yet. One share has three prices:

- **the value read by all**, `AssetsTotal / shares`, what anyone gets who reads `AssetsTotal` alone;
- **the withdrawal value**, the XLS-65 withdraw rate `(AssetsTotal − LossUnrealized) / shares`, what
  `VaultWithdraw` pays out;
- **a lender at 1:1**, one drop (0.000001 XRP) per share unit, reading nothing.

When the curator, the vault's manager, impairs a loan, the loss goes into `Vault.LossUnrealized` and
`AssetsTotal` does not move. Harbor-1's first impairment
([D38861C6…](https://devnet.xrpl.org/transactions/D38861C64E4228444AA04EEEAC5F2972E29FF378000446CCE0A5AA5C6C56A51F))
put 10 XRP of loss on 50 XRP of assets and 50,000,000 shares: the value read by all stayed 1.000000 drop per
share unit and the withdrawal value became 0.800000, which Orma's XLS-47 publication of Harbor-1
([DE7AF2C4…](https://devnet.xrpl.org/transactions/DE7AF2C4F11D3250A2AD66A85E65EE179A6B29277609EA76AE3E09F9AE135262))
carries as its `NAV`. Before the impairment the field sat at its default value, and a field at its default
value is not stored, so the Vault node of that transaction's metadata has an empty `PreviousFields`: the
standard metadata diff misses the loss.

Orma Desk lends XRP against such shares and values them at the withdrawal value only, read at a validated
ledger. Before each operation it produces a risk ticket, `orma.ticket/1`: what the collateral is worth, what
can be lost and how long the money is locked; before each signature, a change preview, `orma.change/1`, lists
the ledger fields the transaction will change. The borrower pledges the shares through an XLS-85 token escrow
into a 2-of-3 collateral account whose keys belong to the borrower, the desk and the Orma agent, a third key
that co-signs only the release `Payment` its published rule names (I3b). The desk countersigns the
borrower's `LoanSet` only after reading everything again at the ledger it signs at, and refuses with
`409 BREACHED` when the risk officer's mandate (`desk-1`, four limits whose hash is anchored on Devnet) does
not hold. With the figures committed in `demo/desk.json` (ledger 6384857), the demo loan of 2 XRP against
5,000,000 Harbor-1 share units has a loan-to-value of 50.00% at the withdrawal value, under the mandate's
53.44%; if Harbor-1's loan L2 defaults it becomes 56.89% and the desk refuses, while a lender at 1:1 would
still read 40.00%. Harbor-1's L2 has since been defaulted on Devnet (below): its withdrawal value, read on
25 October, is that second case's 0.703000.

**The boundary.** The event's work is `nyc-start..main`. `nyc-start` is an annotated tag on commit `bd39502`,
tagged `2026-10-24 12:18:07 -0400` when the build opened (its message names the event's start, "sat 24 oct
10:00 ET"). On GitHub:
[`nyc-start...main`](https://github.com/BuzzBallz/orma/compare/nyc-start...main). In a clone:

```bash
git fetch --tags && git log --oneline nyc-start..main
```

Each step that was built ends on a tag: `step-01-contract` to `step-14-feed`, from the plan written before
the event, then `step-19-desk-copy` to `step-22-late-payments`, steps added to the plan later.

| Tag | What it adds | Offline check |
|---|---|---|
| `step-01-contract` | The `orma.*/1` documents the desk serves. Each figure names one formula from a closed table and exactly its inputs, each input with a ledger index and hash; no amount is a JSON number. | `node src/dev/check-nyc-contracts.mjs` |
| `step-02-harness` | The New York routes inside the existing API, and `src/dev/with-api.mjs`, a local API that neither signs nor publishes. | `node src/dev/with-api.mjs --self-test` (reads Devnet) |
| `step-03-pinned-reads` | Every state read asks for a numeric validated `ledger_index` and keeps that ledger's hash. | `node src/dev/check-pinning.mjs` |
| `step-04-publisher-identity` | The XLS-47 publisher `r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL`, `Provider` `Orma`, `Domain` `ormaprotocol.com`, one document id per vault, derived from the vault id. | `node src/dev/check-reader-edges.mjs` (document ids, collision refusal); the account and its `Domain` read live, see How it works |
| `step-05-bake-nyc` | Harbor-1 to Harbor-3, the desk's lending vaults `desk` and `spare`, the pools of 2-of-3 collateral accounts, the chain test (a pledge, a `LoanSet` the desk countersigned out of `spare` and a 2-of-3 `Payment`, linked below) and the anchored mandate, on Devnet. | `node src/dev/check-demo-ready.mjs --nyc --self-test` |
| `step-06-orma-mark` | `orma-mark`: anyone checks a share's valuation from its MPT id alone. | `node src/dev/check-mark.mjs` |
| `step-07-ticket` | The risk ticket `orma.ticket/1`, the mandate route and the desk's positions. | `node src/dev/check-ticket.mjs` |
| `step-08-role-engine` | The browser's only write path: a closed list of named actions, each previewed (by `simulate` when it carries a transaction), then confirmed. | `node src/dev/check-roles.mjs` |
| `step-09-desk-kit`, `step-11-desk-screens` | `/desk`, with the tabs Ticket, Positions and Mandate (Universe and Feed came with steps 13 and 14); the browser recomputes every figure from its inputs. | `pnpm -C app build` |
| `step-10-desk-signer` | The desk's countersignature after a re-read at the signing ledger, and a hash-chained decision log. | `node src/dev/check-desk.mjs` |
| `step-12-change-engine` | `orma.change/1`: field by field, what a transaction will change and, once validated, what it did. Also the collateral release rule, the guard on what the Orma agent co-signs, and a read-only auditor. | `node src/dev/check-change.mjs`, `node src/desk/audit.mjs --self-test` |
| `step-13-universe` | Every vault on file or seen in the transaction stream, priced at one ledger. | `node src/dev/check-universe.mjs` |
| `step-14-feed` | Credit events derived from full re-reads of each vault, by polling or server-sent events. | `node src/dev/check-feed.mjs` |
| `step-19-desk-copy` | The desk's wording: Harbor Credit Desk (fictional) lends to Tidewater Payments (fictional), and a shortfall is a margin call; the XLS-66 field `CoverRateLiquidation` keeps its name, beside the label "Share of the cover drawn on a default". | `node src/dev/with-api.mjs -- pnpm --dir app smoke` (reads Devnet) |
| `step-20-margin-call` | Margin calls under a declared policy, cured by pledging more shares. | `node src/dev/check-margin-call.mjs` |
| `step-21-usd-loans` | Loans in a Devnet test dollar that stands in for RLUSD, against the same XRP-vault shares, at an XRP/USD price read from three XLS-47 documents. | `node src/dev/check-usd.mjs` |
| `step-22-late-payments` | Each ticket's payment record: how long each loan is past due and how many payments it missed. | `node src/dev/check-payments.mjs` |

Also in `nyc-start..main`, without a step tag: per-client limits on the API's ledger walks, on `/api/mark` and
on `/api/feed/stream` (`npm run check:api`), the documentation of the new publisher, this README's event
section with its captures, a redraw of the desk screens (`d7ecfba`) and fixes to them.

**Not built.** Step 15, hardening, was only partly done (the per-client limits and the documentation above)
and has no tag. Step 16, the predict-then-realise rehearsal, was not built. Step 17, an OTC purchase of shares
in two legs, was not built: the role engine registers no `buyer` action, so a request for one from an
authorised operator answers `404 NOT_FOUND`, and the two buyer rows still listed in `OPERATOR_ACTIONS`
(`app/src/screens/Desk.tsx`) and the server's `op=buy` ticket lead to no settlement. Step 18, role pages for phones, was dropped from the plan.

### The event's transactions on Devnet

Each link below is a validated Devnet transaction of the event, captured as JSON and as binary in
[`evidence/devnet-tx/`](evidence/devnet-tx/) ([how](evidence/devnet-tx/README.md), written for the captures of
13 October; Halden's, added on 20 October, and the New York ones, added on 24 October, follow the same
format). Devnet nodes prune their history, so the capture is the lasting record: its signed blob hashes back to
the transaction id, but its metadata is the server's copy and cannot be checked offline
(`node src/dev/check-evidence.mjs --self-test` shows that case on purpose). Ledger objects (vaults, brokers,
loans, oracles) still read live with `ledger_entry`.

Each fictional Harbor vault has two loans of its own curator, L1 and L2, which produce its losses. L1 is
impaired, then declared in the vault's `Data`; L2 is defaulted on demand by the broker's `defaultL2` action.
Harbor-1's L2 was defaulted on 24 October at 22:11:21 UTC
(`81C2B143D9156E77370F332891B1B9601C58000519F6E1BA3AB29A92AF4B9431`, ledger 6389290; not captured yet, so
not linked): 0.15 XRP of first-loss cover was drawn and the withdrawal value fell from 0.800000 to 0.703000,
the `heldIfL2` that `demo/desk.json` had computed at ledger 6384857. At ledger 6404835, on 25 October,
Harbor-2's and Harbor-3's L2 were still open. The desk lends against Harbor shares out of the `desk` vault,
and in the chain test out of `spare`.

| Vault | Created | Loans L1 and L2 | L1 impaired | Curator's statement |
|---|---|---|---|---|
| Harbor-1 | [FBD87DF2…](https://devnet.xrpl.org/transactions/FBD87DF24EAC9B6537A09FA27D9CBD1E735C7C505066DB4C47E29D9551BA13F4) | [E4FEEA2E…](https://devnet.xrpl.org/transactions/E4FEEA2E814178F7D2A53CFEBBDAE569874C0CB8885B45837800BAAF7C66FA28) · [3420270B…](https://devnet.xrpl.org/transactions/3420270B93FA047C39580B71A882766797B23C06A4C6AB0AF7691B0EDB2C5182) | [D38861C6…](https://devnet.xrpl.org/transactions/D38861C64E4228444AA04EEEAC5F2972E29FF378000446CCE0A5AA5C6C56A51F) | [FF81A871…](https://devnet.xrpl.org/transactions/FF81A871D4437C40CE554BE3C293D480E514BDB14B3D993E3CFB26D953A85A79) |
| Harbor-2 | [B752D9AB…](https://devnet.xrpl.org/transactions/B752D9AB2A79990ED0404610A16CDC5585654D5A01FF297C87CEA9BCF97E675A) | [8FC8CB2A…](https://devnet.xrpl.org/transactions/8FC8CB2AB566D06128E0B105C0113C351C05FA8360D4B2CEBE11EF0DCBC54B07) · [C07E8885…](https://devnet.xrpl.org/transactions/C07E8885EEAC4BC1CA76BDCEAA5C72449C4ECA86F391543302E178753FC6DECA) | [F72442F6…](https://devnet.xrpl.org/transactions/F72442F6B625C0A45D55B35B269D9EDC17478D5E7A6E1B248E0D94F1A5D43843) | [3DC3B33F…](https://devnet.xrpl.org/transactions/3DC3B33F68689D913D3F166FF6FC97A594F73C0990EF255E59077C4F7B3A06E6) |
| Harbor-3 | [B471BFC2…](https://devnet.xrpl.org/transactions/B471BFC2E3AC5997C2679EBE725CB9A8BA678DE0749539FFE97C89E456E0F086) | [B2F2A187…](https://devnet.xrpl.org/transactions/B2F2A1871976A922C72764ED6296B09C81E666C259F15E1F26443B1D97A9834B) · [6EA40580…](https://devnet.xrpl.org/transactions/6EA40580AB4C5C6CB02232916DBDEA08F9F7B5668C5E7ADE7F57D46A6D03BC97) | [D155ED6C…](https://devnet.xrpl.org/transactions/D155ED6C45C9BC14588D960F1F373857822B388244357F7A5E8B93B948906B2C) | [5CBB6ED4…](https://devnet.xrpl.org/transactions/5CBB6ED468907DF3D802EB5A22AC90EE95FFB3A00EF903A30A560639AF43F28D) |
| desk, the vault the desk lends from | [07D7FF14…](https://devnet.xrpl.org/transactions/07D7FF14A713A8D2657528F641CC71C871D2F3ACE4E771444FC2CF038962F2D2) | | | |
| spare, its second lending vault | [954DA2B3…](https://devnet.xrpl.org/transactions/954DA2B3BBE1572EA37E0529EBC7D44BDFD7CEC1A5DBF6B50FFA8B4F17000791) | | | |

`node src/dev/check-change.mjs` replays Harbor-1's first impairment from a fixture captured read-only.

- The chain test on `spare`: the borrower's
  [escrow of 5,000,000 Harbor-1 share units](https://devnet.xrpl.org/transactions/9690077B02B4F8951182106AB315B9B51A92F31659466883DBD493D8510E22DD)
  into a 2-of-3 account, the
  [LoanSet countersigned by the desk](https://devnet.xrpl.org/transactions/8A8F8176C6DB9FC3E511D72144A4351C37084DBB99D069027510ED3FDC7648E1)
  whose `orma.escrow` memo names that escrow, and a
  [Payment of shares out of a 2-of-3 test account](https://devnet.xrpl.org/transactions/D3E98D23A112CCCC9E922D03625C41B8456984A1CB12696D9689F3074F09D4EC),
  multi-signed by the desk and the agent, two of its three keys.
- The mandate `desk-1`,
  [anchored by the risk officer](https://devnet.xrpl.org/transactions/E63C8AB9D41042B315AE41F45CF2B624592CDC190C66E87D17C8275A2A0A92ED)
  with its hash in the memo (`demo/mandate-desk-1.json`).
- [Harbor-1's XLS-47 publication](https://devnet.xrpl.org/transactions/DE7AF2C4F11D3250A2AD66A85E65EE179A6B29277609EA76AE3E09F9AE135262)
  by `r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL`, at 20:07:30 UTC on 24 October.

Not captured yet, so not linked: Harbor-1's L2 default (its hash is above), the anchors of the margin policy
and of the dollar terms, and the transactions of the dollar pool, whose hashes are in
`demo/margin-policy-desk-1.json`, `demo/usd-terms-desk-1.json` and `demo/desk-usd.json`.

### What must never happen, and how anyone can check it

Each command runs from a fresh clone after `npm ci`, with no `.env`, no `.demo/` and no key (`with-api.mjs`
writes its receipts under `.demo/receipts/`). Of the commands in the table, only I4's self-test goes to the
network, to Devnet. Three checks read our servers: the former host in I4's row, the ticket screen named in
I3a, and the auditor below the table, which reads our production API.

| | Rule | Check |
|---|---|---|
| I1 | A pledge is valued only at its withdrawal value, read at a validated ledger: every input of every figure carries that ledger's index and hash. | `node src/dev/check-ticket.mjs` |
| I2 | The desk countersigns a `LoanSet` only if, at the ledger it signs at, the escrow its memo names exists, belongs to the borrower, holds the ticket's shares and pays into a conforming 2-of-3 account, and the ticket recomputed there passes the mandate. | `node src/dev/check-desk.mjs` |
| I3a | No single party, the desk, the borrower or Orma, can move pledged shares. | `node src/dev/check-nyc-contracts.mjs`, and the ticket screen's collateral line, labelled REAL (read from the ledger), at a ledger |
| I3b | The Orma agent's published rule: it co-signs only the release `Payment` that rule names. | `node src/desk/audit.mjs --self-test` |
| I4 | Only the API container on our server publishes with the publisher's key: the local API every check here runs blanks `PUBLISH_SEED` and `PUBLISH` (`src/dev/with-api.mjs`), and our former host is suspended. | `node --env-file-if-exists=.env src/dev/with-api.mjs --self-test`; and our former host, https://orma-api.onrender.com/api/health, is suspended, so it must not answer `ok: true` |
| I5 | The role engine can build no `LoanPay`, no `tfLoanUnimpair` and no `VaultDeposit`: no action from the browser repays a loan, lifts an impairment or deposits into a vault. | `git grep --untracked -qE "LoanPay\|tfLoanUnimpair\|VaultDeposit" -- src/roles`, which exits 1 |
| I6 | A curator's statement (`orma.stmt/1` in `Vault.Data`) is labelled DECLARED and enters no computed figure. | `node src/dev/check-ticket.mjs` |
| I7 | Orma recomputes the vault's withdrawal price as a second implementation, held to the vault-state invariants xrpld checks after every transaction: those of `ValidVault::finalize` (`VaultInvariant.cpp`, xrpld 3.4.1, run when a transaction touches a vault) that one vault state can fail. No shares means no assets, 0 ≤ AssetsAvailable ≤ AssetsTotal, LossUnrealized ≤ AssetsTotal − AssetsAvailable, LossUnrealized ≥ 0, AssetsTotal ≥ 0; not its shares-maximum and assets-maximum checks. | `node src/dev/check-ticket.mjs` |

The same commands, to copy:

```bash
node src/dev/check-ticket.mjs                     # I1, I6, I7
node src/dev/check-desk.mjs                       # I2
node src/dev/check-nyc-contracts.mjs              # I3a
node src/desk/audit.mjs --self-test               # I3b
node --env-file-if-exists=.env src/dev/with-api.mjs --self-test   # I4
git grep --untracked -qE "LoanPay|tfLoanUnimpair|VaultDeposit" -- src/roles; echo $?   # I5: 1
git grep --untracked -qE "LoanManage|EscrowCreate" -- src/roles; echo $?             # control: 0
```

I7 covers the state checks only, not the transition and transaction-type checks that `ValidVault::finalize`
also makes; a single snapshot cannot replay those. A snapshot that fails them gets no figure: the ticket,
the positions and the approval answer `409 INCONSISTENT_SNAPSHOT`, and Universe shows the vault as not priced.

The auditor reads production. `node src/desk/audit.mjs` takes the desk's decision log from the production API
and the collateral accounts from Devnet, with no key, and `--api <base>` points it elsewhere. It exits 0 with
no violation, 1 on a violation of I1 to I3 or I7, and 2 when a read is impossible.

What these rules do not cover: the borrower and the desk together can always move the pledged shares, a
consensual exit. In this demo our server holds both of those keys (the API signs for the borrower and for
the desk), so two of the three keys are ours, and I3a holds between distinct parties only. The agent's
release command (`node src/desk/audit.mjs --release --account <address>`) is built and tested offline; no live
release is run in the demo. After a default the escrow has to be finished before its `CancelAfter`: past it,
anyone may cancel it and the shares go back to the borrower.

## How it works

```
                 XRPL Devnet, one validated ledger L (index and hash)
  +-------------+  +--------------------+  +-------------------+  +------------------+
  | Vault       |  | LoanBroker, Loan   |  | Escrow of shares  |  | Oracle           |
  | XLS-65      |  | XLS-66             |  | XLS-85            |  | XLS-47           |
  +------+------+  +---------+----------+  +---------+---------+  +--------^---------+
         |                   |                       |                     |
         +-------------------+-----------------------+                     | OracleSet
                             | re-read whole at L, never diffed            |
  +--------------------------v---------------------------------------------+-------+
  | Orma, the information layer                                                    |
  | withdrawal value, XLS-47 publication, orma-mark, Universe, Feed, statements    |
  +--------------------------+-----------------------------------------------------+
                             | figures, each with its formula and its inputs at L
  +--------------------------v-----------------------------------------------------+
  | Orma Desk, collateral management                                               |
  | ticket -> mandate verdict -> change preview -> countersigned LoanSet -> calls  |
  +--------------------------------------------------------------------------------+

  borrower --EscrowCreate--> 2-of-3 collateral account {borrower, desk, Orma agent}
```

### Orma, the information layer

**The reader.** `src/poll.mjs` re-reads each vault's full state every 4 seconds and never diffs
`PreviousFields`. Every state read (vault, broker, loan, share issuance, account objects) names a numeric
validated ledger and keeps its hash (`Xrpl.pinned` in `src/xrpl.mjs`), so any figure can be recomputed at the
ledger it names. Amounts are decimal strings handled by `decimal.js` at precision 40 (`src/num.mjs`). No
`Number()` and no `parseFloat` touches money in the reader, the ticket or the desk, and `check-ticket` greps
`src/ticket/` for both; the one-off scripts of `src/demo/` are not held to that rule.

**XLS-47 publication.** Each vault's figures are published as a native Oracle object with six `PriceData`
entries (`buildPriceData` in `src/oracle.mjs`), told apart by their `QuoteAsset`: `NAV`, the withdrawal value
at `Scale` 6, which orma-mark cross-checks; and five dimensions from the Paris build at `Scale` 4, `HDL` (the
Paris score as a number, `gradeNumeric / 100`), `LIQ`, `COV`, `CNC` and `DDL`. No desk figure uses those five.
The document id is `oracleDocId(vaultId)` (`src/oracle.mjs`): `sha256(vaultId)` read as a
big-endian `UInt32` from its first four bytes, where the hash is taken over the 64-character upper-case hex
string of the vault id, not over its 32 bytes. The id depends on the vault alone, and the publisher refuses to
publish a second vault under an id already held. `BaseAsset` is the first 20 bytes of the vault id, with its
first hex digit set to `A` when the id starts with `00`, so that the code is never read as XRP
(`vaultToBaseAsset` in `src/oracle.mjs`).

| `oracle_document_id` | Vault | Vault id |
|---|---|---|
| 2611978006 | Harbor-1 | `E216E96D…` |
| 1197106457 | Harbor-2 | `1F50CE2B…` |
| 3647726209 | Harbor-3 | `0BAC80C3…` |
| 587307429 | desk | `3422A5AD…` |
| 2761675937 | spare | `88849E4F…` |
| 3412668304 | Halden Structured Credit IV | `DAB9E1EE…` |
| 275365832 | Meridian Trade Finance I | `864C5A2D…` |
| 4197695612 | Kestrel Bridge Financing II | `24EAA01A…` |
| 3238869064 | Thorne Senior Secured I | `4A5A8E37…` |

Calder is retired: it is not read and has no document under the current publisher. Three accounts hold
Orma's Oracle objects:

| Publisher | Its objects |
|---|---|
| [`r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL`](https://devnet.xrpl.org/accounts/r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL) | The current publisher, `Provider` `Orma`, since 24 October 2026. Its `Domain` is `ormaprotocol.com`, whose `/.well-known/xrp-ledger.toml` lists it (`app/public/.well-known/xrp-ledger.toml`). It republishes when a vault's figures change, and on a 60-second heartbeat (`HEARTBEAT_MS` in `src/publish-loop.mjs`). |
| [`rPuYT6SZopnZopp4fmvkfd5eeXQTsozz6H`](https://devnet.xrpl.org/accounts/rPuYT6SZopnZopp4fmvkfd5eeXQTsozz6H) | The previous publisher, under the project's former name, document ids 1 to 5. Its objects are no longer updated: read on 25 October, the `LastUpdateTime` of documents 1, 2, 4 and 5 is 24 October 2026, 20:44 UTC, and that of Calder's document 3 is 20 October. `src/demo/set-domain.mjs` records that `OracleSet` refuses a changed `Provider` on an existing Oracle, so the new name needed a new account. |
| [`rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B`](https://devnet.xrpl.org/accounts/rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B) | Written during the Paris event and frozen since, `LastUpdateTime` 2026-09-13 between 14:20 and 14:21 UTC, document ids 1 to 4. |

`devnet.xrpl.org` has no route for a ledger object, so fetch the object itself. Halden, from the current
publisher:

```bash
curl -s https://s.devnet.rippletest.net:51234 -H 'Content-Type: application/json' -d '{"method":"ledger_entry","params":[{"oracle":{"account":"r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL","oracle_document_id":3412668304},"ledger_index":"validated"}]}'
```

Every `PriceData` entry carries `BaseAsset` `DAB9E1EE3D8899C2112FCFC90F40D7C93B74B06C`, and `NAV` reads `c4452`
hex at `Scale` 6, which is 0.803922.

**Universe** (`GET /api/universe`) lists the vaults in `demo/` and those the transaction stream has shown
since the process started (200 at most), each priced at the reader's latest validated ledger. It is not a full
ledger scan, and the screen says so. The stream reveals vault ids only; every figure comes from a read.

**Feed and curator statements.** `GET /api/feed` (polling) and `GET /api/feed/stream` (server-sent events)
carry `LOAN_ORIGINATED`, `LOAN_LATE`, `IMPAIRMENT`, `DEFAULT`, `COVER_DRAWN` and `SHARES_PLEDGED`, all REAL,
plus `STATEMENT` and the three margin-call events, DECLARED. Each event is derived from two successive full
reads of a vault (the reader's, every 4 seconds; a ledger whose reads fail is skipped), never from metadata,
with its reason, its money effect, its ledger and, when there is one, its transaction hash. A curator can
write a statement on the ledger, `orma.stmt/1` in `Vault.Data` (at most 120 characters of text): Harbor-1's ([FF81A871…](https://devnet.xrpl.org/transactions/FF81A871D4437C40CE554BE3C293D480E514BDB14B3D993E3CFB26D953A85A79))
reads "L1 marked impaired: payment missed by 1 min". The desk shows it as DECLARED, compares it with the
loan's state (`CONSISTENT`, `INCONSISTENT`, `NOT_CHECKABLE`, `UNPARSEABLE`), and lets it enter no figure (I6).

### Orma Desk, collateral management

The Lending Protocol does not link a loan to collateral. Orma Desk makes the link: an escrow of shares that
runs until the loan can be defaulted, and the `orma.escrow` memo on the `LoanSet` that names it.

1. **Ticket.** `GET /api/tickets?share=<48-hex MPT id>&op=pledge&units=<n>&mandate=desk-1` returns
   `orma.ticket/1` for the planned loan of `demo/desk.json` (2 XRP; the principal is not a parameter). N1,
   the overpayment: the value read by all minus the withdrawal value, for the shares of the operation. N2: what those shares would lose if each late loan defaulted alone, after the broker's
   cover, which is `min(ceil(DebtTotal × CoverRateMinimum/1e5 × CoverRateLiquidation/1e5), exposure,
   CoverAvailable)`. N3: how long the shares are locked, and the vault's cash. Then the largest loan the
   mandate allows, the loan-to-value at the withdrawal value and for a lender at 1:1, and the verdict, PASS or
   BREACHED, against the mandate's four limits (for `desk-1`: 5344 bps of loan-to-value, 4 XRP per loan,
   0.97 XRP of N2 loss, 23 days of lock-up). Each figure carries its formula, its provenance (REAL, DECLARED,
   MODELLED or SIMULATED) and its inputs with their ledger, and the browser recomputes it with `decimal.js`
   (`app/src/components/Ledger.tsx`).
2. **Pledge.** The borrower escrows the shares (`EscrowCreate`, XLS-85) to a 2-of-3 collateral account: master
   key disabled, a signer list of quorum 2 with weight 1 on the borrower, the desk and the Orma agent, no
   `RegularKey`, no `lsfDepositAuth`, no other object. `FinishAfter` is the pledge's close time plus the
   loan's payment interval and grace period plus 14,400 s; `CancelAfter` is 86,400 s later; there is no
   condition. Anyone may finish the escrow between the two, and the shares then sit in the 2-of-3 account,
   not with the desk. Only shares of a closed-ended XRP vault whose issuance flags are exactly `0x00000038`
   (escrow, trade, transfer; no lock, no clawback) and that are not locked are accepted (`judgeCollateralShare`
   in `src/nyc/contracts.mjs`); anything else is refused with `409 ESCROW_POLICY` and its reason. XRP only,
   because an issued asset can be clawed back or frozen by its issuer.
3. **Approval.** The borrower signs a `LoanSet` carrying the `orma.ticket` and `orma.escrow` memos. At the
   ledger of the approval the desk re-reads the escrow the memo names, the collateral account, the share and
   the borrower's account, recomputes the ticket (same `inputsDigest`), checks the mandate and the borrower's
   `Sequence`, then countersigns with `signLoanSetByCounterparty` and submits (`src/desk/signer.mjs`).
   Otherwise it refuses, among other codes, with `ESCROW_POLICY`, `STALE`, `BREACHED` and the limits crossed,
   `SEQUENCE_PASSED` or `INCONSISTENT_SNAPSHOT`. Every outcome, approved, refused or declined, goes into a
   JSONL log chained by sha256 with the ledger read, served at `GET /api/desk/decisions`.
4. **Change preview.** Before any signature, `orma.change/1` (`src/change/engine.mjs`) fixes the validated
   ledger L, runs `simulate` on the open ledger, re-reads at L every object the simulated metadata modifies or
   deletes, and lists each field it will change, including the ones the metadata leaves out of
   `PreviousFields` (`Vault.LossUnrealized`, `Vault.Data`, the `LockedAmount` of an `MPToken` and of an
   `MPTokenIssuance`), marked HIDDEN with the xrpld 3.4.1 rule (`ApplyStateTable.cpp`) that explains the
   omission. After validation it re-reads the objects and marks each row MATCH or MISMATCH. `PreviousFields`
   is read only to decide what the metadata admitted, never for the value of an object read at L.
5. **Margin calls.** Each open loan is judged against the risk officer's policy `orma.marginpolicy/1`
   (`demo/margin-policy-desk-1.json`): above the mandate's loan-to-value limit, a call is issued with the exact
   number of share units to add; pledging them cures it, through the same pledge with a `cureLoanId` and an
   `orma.cure` memo; past the cure window, 600 s on Devnet, it expires. Statuses `NONE`, `ISSUED`, `CURED`,
   `EXPIRED`; every transition is read at one ledger, chained into the decision log and pushed to the Feed.
   After expiry the policy says: "The desk may act under its escrow policy (finish only after a default). No
   automatic seizure." `GET /api/desk/margin-calls`.
6. **Late payments.** Each ticket carries, for every open loan of the vault, a payment record read at the
   ticket's ledger: status (`current`, `due_soon`, `overdue`, `defaultable`, `impaired`, `defaulted`), next due
   date, end of grace, `pastDue = max(0, close_time − NextPaymentDueDate)` (REAL), and the payments missed.
7. **Loans in a test dollar.** With `&asset=USD`, the desk lends a "test dollar, stands in for RLUSD (Devnet)"
   against the same shares of XRP vaults. The collateral and its withdrawal value do not change; the dollar
   figures, MODELLED, convert it at the XRP/USD price read below, less the FX haircut the terms declare
   (`fxHaircutBps` 1000, that is 10%), and the single-loan limit becomes the terms' `maxSingleLoanUsd`
   (10 USD) in place of the mandate's 4 XRP. The XRP/USD price is read, never declared: the risk officer's terms (`demo/usd-terms-desk-1.json`) name three XLS-47 documents, and at each
   ticket the desk reads them at L and takes the median of at least two sources no older than 300 s and no
   further apart than 100 bps, which `get_aggregate_price` on the same documents at L must match; otherwise
   `409 PRICE_UNAVAILABLE` and no dollar figure. No one maintains an XRP/USD oracle on Devnet, so
   `src/demo/fx-relay.mjs` copies the last trades of Kraken, Bitstamp and Coinbase into those three documents
   every 60 s from one test account: a stand-in for independent providers, not independence.

`GET /api/desk/positions` lists the desk's loans with their collateral, loan-to-value and margin call, each
with the hash and ledger of its `LoanSet`, found through the `orma.escrow` memo. `GET /api/desk/mandates/{id}`
serves the mandate. In the demo every action goes through the role engine (`src/roles/engine.mjs`), played
from the "Operator controls (demo)" panel: a run token, a kill switch, one serial queue per signing account,
and only the actions it lists.

## Verify it yourself

`orma-mark` checks a share's valuation from its MPT id alone:

```bash
node src/mark/verify.mjs 0000000113268B160349A129A3343579AE8B0059C4BDC2F8   # Harbor-1's share
node src/mark/verify.mjs <shareMptId> --ws <your node>                       # any other node
```

It prints one `orma.mark/1` line after six steps: read the `MPTokenIssuance`, decode its metadata, fetch the
nav document its pointer names, check that the share's issuer is the pseudo-account of a vault whose
`ShareMPTID` is this share (a pointer copied onto another share is `SPOOFED`), recompute the withdrawal value
at the document's ledger, and cross-check the Orma Oracle object found through the domain's toml. Exit 0
agree, 4 disagree (`SPOOFED`, `RECOMPUTE_MISMATCH`, `ORACLE_MISMATCH`, `UNREACHABLE`), 64 invalid usage, 1 the
node could not be reached. Two reads go to the publisher's domain, `ormaprotocol.com`: the nav document,
which our production API serves, and the domain's toml; every other step reads the ledger from the node. This
is a recompute against a public node, and it trusts the node you point it at. The API runs the same check at
`GET /api/mark/{mptId}`, and `GET /api/mpt/{mptId}/status` says whether a share is attested.
`node src/dev/check-mark.mjs` runs the chain offline on a fake ledger.

## Running it

| | |
|---|---|
| Network | XRPL Devnet, `wss://s.devnet.rippletest.net:51233`, `network_id` 2; explorer https://devnet.xrpl.org, faucet https://faucet.devnet.rippletest.net/accounts |
| Server | `xrpld`, built from `XRPLF/rippled`; the change engine and I7 cite its 3.4.1 source. Read the version Devnet runs with `server_info`: it moves |
| Libraries | `xrpl` 5.3.0, `ripple-binary-codec` 2.11.0, `decimal.js` 10.6.0; app: React 19, Vite 8, TypeScript, pnpm 12.11.2 in CI |
| Runtime | Node 24.13.0 (`.nvmrc`, `Dockerfile`, CI); `package.json` allows 20.19 or later, which CI does not test |

Orma reads, publishes and signs on Devnet only: the vault and lending amendments (`SingleAssetVault`,
`LendingProtocol`) are not enabled on Mainnet.

```bash
git clone https://github.com/BuzzBallz/orma.git && cd orma
nvm use                      # Node 24.13.0
npm ci                       # the committed lockfile, never npm install
npm test                     # every offline check in src/dev (src/dev/run-checks.mjs); no network, no key
npm start                    # reader and API on http://localhost:8787, read-only
```

`npm ci` installs exactly the lockfile we checked against Devnet; re-resolving it can move
`ripple-binary-codec`, which serializes closed-ended vaults. `npm start` serves the nine vaults recorded in
`demo/` and needs no key; `/api/health` answers `ok: false` until the reader's first pass. Without
`ROLES_FILE` (the role accounts) and `DESK_SEED`, a write route answers `503 NOT_CONFIGURED`; a browser origin
not listed in `ALLOWED_WRITE_ORIGINS` is refused `403 FORBIDDEN` first. `PUBLISH_SEED` is the publisher's key,
and without it (or `PUBLISH=faucet`) the API publishes nothing. The API logs the names it lacks when it starts
(`nyc config incomplete`). The seeds were written when the demo was set up on Devnet, by
`src/demo/bake-nyc.mjs` (the script that created the demo's accounts, vaults and loans) and
`src/demo/set-domain.mjs` (the publisher), and are not in the repository; `.env.example` names the variables.
`node src/desk/audit.mjs --self-test` is not part of `npm test`; run it on its own.

The app:

```bash
pnpm -C app install --frozen-lockfile
pnpm -C app dev              # http://localhost:5173, calls VITE_API_BASE (default http://localhost:8787)
pnpm -C app lint && pnpm -C app build
```

Live checks, read-only against Devnet, through a local API that neither signs nor publishes:

```bash
node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-ticket.mjs --live
node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-payments.mjs --live
node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-margin-call.mjs --live
node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-usd.mjs --live
node --env-file-if-exists=.env src/dev/with-api.mjs -- node src/dev/check-universe.mjs --live
```

**HTTP API.** 31 routes. The contract is `src/openapi.json`, served at `/api/openapi.json`, and
`documentation/pages/http-api.mdx` describes each route. `npm run check:openapi` checks that the OpenAPI
document names every route the prose indexes, and `node src/dev/check-nyc-contracts.mjs` that every New York
route is in both. The New York routes:

```
GET  /api/tickets               GET  /api/desk/mandates/{id}     GET  /api/desk/positions
GET  /api/desk/decisions        GET  /api/desk/margin-calls      GET  /api/universe
GET  /api/feed                  GET  /api/feed/stream            GET  /api/mark/{mptId}
GET  /api/mpt/{mptId}/status    POST /api/roles/{runId}/{role}/{action}
POST /api/roles/{runId}/actions/{actionId}/confirm               GET  /api/roles/{runId}/actions/{actionId}
POST /api/demo/run              POST /api/demo/kill              POST /api/demo/unkill
```

`npm run mcp` serves the same readings as read-only MCP tools; set `ORMA_API`, because its default in
`src/mcp.mjs` is the suspended Render host.

**Deploying.** The API is a long-running process, so it runs as a container: `docker build -t orma-api . &&
docker run -p 8787:8787 orma-api` (Node 24.13.0, as the `node` user). With the desk configured, give it a
writable `DESK_LOG_PATH`, because the image's working directory is not writable by that user. Production is
that container on our server; the static site's `app/vercel.json` rewrites `/api/*` and `/v/:mpt/nav` to it.
`render.yaml` and `railway.json` are still in the repository, but the Render host is suspended (I4).

## Before New York: Paris, September 2026

Orma's information layer was built at the De Vinci Blockchain XRPL Lending Protocol Hackathon in Paris,
12–13 September 2026, where team BuzzBallz took **1st place of 14 projects**
([ESILV](https://www.esilv.fr/xrpl-hackathon-devinci-blockchain-remporte-deux-places-sur-le-podium/)). It
reads a vault's solvency from ledger state rather than from metadata diffs, publishes it as an XLS-47 Oracle
object and as a pointer inside the share token's own metadata, and lets a vault owner gate deposits on an
XLS-70 credential through an XLS-80 domain. Meridian, Kestrel and Thorne below, and Halden, are still on
Devnet, and the API still reads them live, falling back on the captures in `evidence/devnet-tx/` for the
history Devnet has pruned; the New York demo uses the Harbor vaults. The Paris screens also show a letter
grade (`src/score.mjs`, `app/src/lib/grades.ts`) and a conduct assessment (`reputation` in `src/history.mjs`)
derived from these readings. Orma Desk shows neither, and no New York document may carry a `grade` key
(`deepProblems` in `src/nyc/contracts.mjs`); its ticket reads the broker's history (`readBrokerHistory` and
`analyseOrdering` in `src/history.mjs`) for facts only, in its `conduct` block: how long each impairment came
after the missed payment, the defaults with no impairment before them, and what the order of the defaults
cost depositors.

- **Meridian Trade Finance I.** 51 XRP deposited, 10 lent, the loan impaired: withdrawal value 0.803922,
  value read by all 1.000000, 1961 bps apart on the same ledger, while the Vault node of the impairment's
  metadata had an empty `PreviousFields`.
- **Kestrel Bridge Financing II.** The cover drawn on a default is sized against the broker's whole book, not
  the defaulted loan, and the book shrinks with each default. Two loans of 30 and 10 XRP defaulted largest
  first drew 0.50 XRP of the curator's first-loss cover; smallest first would have drawn 0.70 XRP. The 0.20 XRP
  difference is investor money (`npm run check:ordering`).
- **Thorne Senior Secured I.** A vault owner (an account our setup script created) named Orma's credential
  issuer in its permissioned domain: the investor holding the credential deposited, the one without it was
  refused by the ledger, and after revocation entry was refused while the exit stayed open.
- **Halden Structured Credit IV**, baked on 19 October 2026, between the two events: the share token's XLS-89
  metadata points to its valuation, so a second lender holding only the token prices a pledge of 1,000,000
  units at 0.803922 XRP instead of 1.000000.

<details>
<summary>The Paris transactions, one per claim above</summary>

| What | Transaction | Result |
|---|---|---|
| Meridian, created | [D07C5925…](https://devnet.xrpl.org/transactions/D07C59257F0C568DAF401C4253E8609C206B900F838289E9B45B418F7DE4807C) | `tesSUCCESS` |
| Meridian, loan impaired, empty `PreviousFields` | [075FE6D2…](https://devnet.xrpl.org/transactions/075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3) | `tesSUCCESS` |
| Kestrel, larger loan defaulted first | [FB23EC53…](https://devnet.xrpl.org/transactions/FB23EC5313F85FA157D56966E0B0B1665068905988D925C70BB0E7C35C3B221B) | `tesSUCCESS` |
| Kestrel, smaller loan defaulted second | [DE49DF0D…](https://devnet.xrpl.org/transactions/DE49DF0D6136B96AD28B253CD32100E5715078FD2D0AE6D1DB747AFECB803D1F) | `tesSUCCESS` |
| Thorne, deposit with the credential | [7FC5C01B…](https://devnet.xrpl.org/transactions/7FC5C01BD735E9A41A0AC6ACFA4B6994B1347A8FA06DAEF8012A62B0E1DF98AF) | `tesSUCCESS` |
| Thorne, deposit without it | [E7CF5DB2…](https://devnet.xrpl.org/transactions/E7CF5DB29DFE652801F4936C11D50A493EB3C474D6EEDFE9FC24394E8DD26101) | `tecNO_AUTH` |
| Thorne, deposit after revocation | [AA25246A…](https://devnet.xrpl.org/transactions/AA25246AE452DF1719751E4F03BAD8B6C286250DE8FB65EC2B7FBBFE272ADDBF) | `tecNO_AUTH` |
| Thorne, withdrawal after revocation | [2E71A259…](https://devnet.xrpl.org/transactions/2E71A25973D55E26C8AECFDFDF1EF3BF0571B8FB4DD9D524B6A8C750994F39FE) | `tesSUCCESS` |
| `LoanBrokerSet` on an open-ended vault | [CE477E29…](https://devnet.xrpl.org/transactions/CE477E29A099A6BBC30EBA52F3E09AB2A450CDB05F338AE517EDAAC0584827AB) | `tecNO_PERMISSION` |
| `VaultWithdraw` in the Investment phase | [CC104682…](https://devnet.xrpl.org/transactions/CC104682C298DFB3619EE4C15F0112ACE2B6A95B4971CA0A0AC748F9B5B6617A) | `tecTOO_SOON` |
| `VaultDeposit` in the Investment phase | [7A10D805…](https://devnet.xrpl.org/transactions/7A10D8053FEE687A008F17E2AD98121EE08553CBDEAAE92DDEC3C2798A1CB15B) | `tecEXPIRED` |
| `LoanSet` in the Subscription phase | [E1121DED…](https://devnet.xrpl.org/transactions/E1121DED12D4A320FB58F77D02549429885D8A826B794F2B2539EC936BE39011) | `tecTOO_SOON` |
| First XLS-47 publication, by `rpVg1u…` | [DC5754D2…](https://devnet.xrpl.org/transactions/DC5754D2EE4A6A7AB9233EA3EE704A9C2FD97FA06C80EA364E5D4811CAD75255) | `tesSUCCESS` |
| `DelegateSet`: `Payment` delegates, every lending permission is refused `temMALFORMED` before a ledger | [547DA719…](https://devnet.xrpl.org/transactions/547DA71992D469ACA345A0B3CEAD07864E2801919201B256EA606C3A7910AF17) | `tesSUCCESS` |
| Halden, created with its share metadata | [1A226B33…](https://devnet.xrpl.org/transactions/1A226B33CD370E82683A39F58FF8465A16FD1DED99C87EC65B00E8BA2B7B4CF5) | `tesSUCCESS` |
| Halden, loan impaired | [EC385DAF…](https://devnet.xrpl.org/transactions/EC385DAF2DF412F86F06648B7855AEFDB1A1B8596048DA33C33B0A09FB2D08E5) | `tesSUCCESS` |

</details>

The delegation result still holds in New York: XLS-75 delegation does not reach the lending transactions.
The full Paris record, transaction by transaction, is in the README
of the [`hackathon-submission`](https://github.com/BuzzBallz/orma/releases/tag/hackathon-submission) release,
and every one of its transactions is captured in `evidence/devnet-tx/`.

During the Paris event we set two of our own accounts against each other on Meridian, so that
`get_aggregate_price` had something to aggregate. `rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B` (document 2) read the
vault object and reported 0.803922. `raiwYKSDdrhiediLdgJyGEzP1estXcmVcM` (document 1), a throwaway Devnet
faucet account we created to stand in for a naive indexer, published once the 1.000000 a metadata-diffing
indexer computes. It is ours, not an independent publisher. The server returned a median of 0.901961; the
capture and the request that reproduces it are in [`demo/oracle-aggregate.json`](demo/oracle-aggregate.json).

Between the two events: the site's redesign (23 September) and a NAV-history route,
`GET /api/vaults/{vaultId}/nav-history` (1 October); corrections of 13 October to the README, the paper and
the feedback report, with dated notes in the paper, the register and `FEEDBACK.pdf`, the repository as then
submitted staying in the `hackathon-submission` release; then, on 19–20 October, `xrpl` 5.3.0, Node 24.13.0,
the MCP server, the OpenAPI document, Halden, and Calder's retirement.

## Developer feedback, from Paris

**40 findings: 7 P0 (blocks a developer entirely), 19 P1 (costs hours, with a non-obvious workaround), 14 P2
(friction, or a documentation inaccuracy)**, plus 3 withdrawn after cross-checking and listed as withdrawn
(the rubric is in `feedback/register.md`).
`FEEDBACK.pdf` is the three-page report, corrected on 13 October 2026 with a dated line under the signature;
`feedback/appendix.pdf` is the 34-page register behind it, and `FINDINGS.md` indexes the findings. The three
that cost us the most:

1. The first impairment of a healthy vault leaves `LossUnrealized` out of the Vault's `PreviousFields`: the
   field was at its default value, so it was not stored and has no previous value to record. It was raised
   before us as [`rippled#6487`](https://github.com/XRPLF/rippled/issues/6487) by the operator of an XRPL
   explorer, and closed by its reporter. Our follow-up, `rippled#8222`, was moved by a Ripple
   maintainer to the documentation repo as
   [xrpl-dev-portal#3926](https://github.com/XRPLF/xrpl-dev-portal/issues/3926), where it is open.
2. The documented lending tutorial could not complete on 12 September: its setup created an open-ended vault.
   Our fix is in `contrib/tutorial-fix/`;
   [xrpl-dev-portal#3923](https://github.com/XRPLF/xrpl-dev-portal/pull/3923), merged on 16 September 2026,
   carries four of its five changes by our count.
3. `LoanManage` carries no `LoanBrokerID` and an impairment does not touch the `LoanBroker`, so filtering
   `account_tx` by broker drops every impairment; `Loan.FinalFields.LoanBrokerID` in the same metadata closes
   the join.

Upstream, three notes on the closed-ended vault draft
([XRPL-Standards#587](https://github.com/XRPLF/XRPL-Standards/pull/587#issuecomment-5655843515)) were
addressed by its author ([reply](https://github.com/XRPLF/XRPL-Standards/pull/587#issuecomment-5665157387))
and merged on 15 September. [`contrib/filings/`](contrib/filings/README.md) records what was filed and what
was not. The technical paper, [`paper/orma-paper.pdf`](paper/orma-paper.pdf), fourteen pages, states the
arithmetic: the two readings of a share, the cover formula, and the ordering result with its proof.

## Repository map

| Path | What it is | From |
|---|---|---|
| `src/` | The backend, plain ESM `.mjs` with JSDoc, no build step: reader (`poll.mjs`, `xrpl.mjs`), valuation (`nav.mjs`, `num.mjs`), publisher (`oracle.mjs`, `publish-loop.mjs`), share metadata (`metadata.mjs`), history, credentials, API (`api.mjs`, `openapi.json`), MCP (`mcp.mjs`) | Paris, extended in New York |
| `src/nyc/`, `src/ticket/`, `src/desk/`, `src/roles/`, `src/change/` | Orma Desk: contracts, ticket, signer, decision log, margin calls, release rule and auditor, role engine, change engine | New York |
| `src/mark/`, `src/universe/`, `src/feed/`, `src/fx/` | orma-mark, Universe, Feed, XRP/USD price | New York |
| `src/demo/`, `src/dev/` | Scripts that create the facilities on Devnet (`bake-*.mjs` among them); `check-*` scripts, `run-checks.mjs` being `npm test` | both |
| `app/` | React, Vite, TypeScript. `/desk` (`Desk.tsx`, `DeskUniverse.tsx`, `DeskFeed.tsx`, `components/Ledger.tsx`, `components/Charts.tsx`) is New York; Portfolio, Facility, Evidence and the other screens are Paris | both |
| `demo/` | The committed record of each baked vault, the mandate, the margin policy and the dollar terms | both |
| `evidence/devnet-tx/` | Captures of every linked transaction, and the archive the history routes fall back on as Devnet prunes | both |
| `documentation/` | Mintlify MDX, also built to https://buzzballz.github.io/orma/ by `build.mjs` and `deploy.sh` | Paris, updated |
| `paper/`, `FEEDBACK.pdf`, `feedback/`, `FINDINGS.md`, `contrib/` | Paper, feedback report and register, upstream work | Paris |
| `deck/` | The Paris presentation, not updated for New York | Paris |

## Team

Alexandre Lemiere ([@frytegg](https://github.com/frytegg)) and Andrea Gonzalez
([@andreagnzz](https://github.com/andreagnzz)).

In New York, by commit author in `nyc-start..main`: Alexandre, the contract, pinned reads, the bake, the
ticket, the desk signer, the change engine with the release rule and auditor, Universe, the per-client
limits, the desk copy, margin calls, test-dollar loans and late payments; Andrea, the harness, the publisher
identity, orma-mark, the role engine, the desk kit and screens, the Feed, and the desk's redraw and fixes.
In Paris: Alexandre, the reader, the scoring, the XLS-47 publisher, the credential gate, the finding register,
the upstream filings, the paper and the documentation; Andrea, the app, its visual identity and its redesign,
the three-page feedback report and `FINDINGS.md`.

MIT licence (`LICENSE`).
