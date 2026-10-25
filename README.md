# Orma

## Built in New York

**Orma Desk lends XRP against XRPL vault shares, and prices each share at what the vault would pay out for it.**
We built it at the XRPL hackathon in New York, 24–25 October 2026 (Lending & Borrowing track), on Orma's
information layer, which we built in Paris in September 2026. Everything runs on XRPL Devnet. The Harbor vaults,
the lender (Harbor Credit Desk) and the borrower (Tidewater Payments) are fictional.

[![ci](https://github.com/BuzzBallz/orma/actions/workflows/ci.yml/badge.svg)](https://github.com/BuzzBallz/orma/actions/workflows/ci.yml) [Desk](https://ormaprotocol.com/desk) · [Site](https://ormaprotocol.com) · [Docs](https://buzzballz.github.io/orma/) ·
[the event's diff, `nyc-start...main`](https://github.com/BuzzBallz/orma/compare/nyc-start...main) ·
[HACKATHON.md](HACKATHON.md), where the event's work starts.

### The problem, in plain words

An XRPL lending vault (XLS-65) takes deposits and lends them out through a loan broker (XLS-66). On Devnet it
must be closed-ended: since [rippled#8076](https://github.com/XRPLF/rippled/pull/8076) (merged 26 August 2026),
`LoanBrokerSet` refuses an open-ended vault ([CE477E29…](https://devnet.xrpl.org/transactions/CE477E29A099A6BBC30EBA52F3E09AB2A450CDB05F338AE517EDAAC0584827AB),
`tecNO_PERMISSION`). A closed-ended vault locks deposits until a redemption date: until then `VaultWithdraw`
returns `tecTOO_SOON` ([CC104682…](https://devnet.xrpl.org/transactions/CC104682C298DFB3619EE4C15F0112ACE2B6A95B4971CA0A0AC748F9B5B6617A)).
A holder who needs XRP sooner borrows against the shares, and the lender must price a share no one can redeem.

When the vault's manager (the curator) impairs a loan, the loss goes into `Vault.LossUnrealized` and
`AssetsTotal` does not move. Harbor-1 held 50 XRP (50,000,000 drops) for 50,000,000 share units when its first
impairment ([D38861C6…](https://devnet.xrpl.org/transactions/D38861C64E4228444AA04EEEAC5F2972E29FF378000446CCE0A5AA5C6C56A51F))
recorded 10 XRP of loss. One share unit then has two prices:

| Reading | Formula | One share unit of Harbor-1 |
|---|---|---|
| The value everyone reads: assets divided by shares | `AssetsTotal / shares` | 1.000000 drop |
| The withdrawal value, XLS-65's withdraw rate | `(AssetsTotal − LossUnrealized) / shares` | 0.800000 drop |

Orma Desk lends only against the second: what the vault would pay at redemption if no further loss is recorded.
A loss the curator has not recorded is not in it, so each ticket also prices the default of each vault loan.

### What the desk does

1. **Risk ticket** (`orma.ticket/1`): what the pledged shares are worth, what a default of each vault loan
   would cost, how long the money is locked. Each figure names its formula and its inputs, each read at one
   validated ledger (index and hash).
2. **Mandate** `desk-1`, its hash anchored on Devnet: loan-to-value at most 53.44%, one loan at most 4 XRP, at
   most 0.97 XRP lost if one vault loan defaults, at most 23 days locked. Breaking one is `409 BREACHED`.
3. **Pledge and countersignature.** The borrower escrows the shares (XLS-85) toward a 2-of-3 account {borrower,
   desk, Orma agent}; the desk countersigns the borrower's `LoanSet` only after re-reading all of it at a new
   validated ledger, and only if the mandate still passes.
4. **Change preview** (`orma.change/1`): every ledger field a transaction will change, including the ones its
   metadata will not show.
5. **After the loan:** margin calls cured by pledging more shares, a payment record per loan, loans in a Devnet
   test dollar standing in for RLUSD, and a hash-chained log of every decision.

### The demo loan, worked out

From the figures committed in `demo/desk.json` (ledger 6384857): 2 XRP against 5,000,000 Harbor-1 share units.

| Price per share unit | Pledge worth | Loan-to-value | Mandate (53.44%) |
|---|---|---|---|
| 0.800000 drop, the withdrawal value before L2's default | 4.000 XRP | 50.00% | passes |
| 0.703000 drop, after Harbor-1's loan L2 defaults | 3.515 XRP | 56.89% | **refused** |
| 1 drop, a lender at 1:1 | 5.000 XRP | 40.00% | passes |

L2 was defaulted on Devnet on 24 October at 22:11:21 UTC (ledger 6389290): 0.15 XRP of first-loss cover was
drawn and the withdrawal value fell to 0.703000, as `demo/desk.json` had computed. The production ticket now
refuses that loan while the 1:1 reading passes (this trusts our API; the next section does not):

```bash
curl -s "https://ormaprotocol.com/api/tickets?share=0000000113268B160349A129A3343579AE8B0059C4BDC2F8&op=pledge&units=5000000&mandate=desk-1" | grep -A1 -E '"verdict(1to1)?"'
# "verdict": { "status": "BREACHED" ...   "verdict1to1": { "status": "PASS" ...
```

## Check it yourself

From a fresh clone, with Node 24.13.0 (`.nvmrc`), no `.env` and no key:

```bash
git clone https://github.com/BuzzBallz/orma.git && cd orma && npm ci
npm test                                   # every offline check in src/dev; prints "all N passed", exit 0
node src/dev/check-evidence.mjs            # every Devnet capture below hashes back to its transaction id
node src/mark/verify.mjs 0000000113268B160349A129A3343579AE8B0059C4BDC2F8   # Harbor-1 re-read on Devnet
curl -s https://s.devnet.rippletest.net:51234 -d '{"method":"tx","params":[{"transaction":"81C2B143D9156E77370F332891B1B9601C58000519F6E1BA3AB29A92AF4B9431"}]}' | grep -oE '"(TransactionType|TransactionResult|ledger_index)":"?[A-Za-z0-9]+'
```

- `npm test` runs each `src/dev/check-*.mjs` that needs neither network nor key (32 at `step-15-hardening`);
  CI runs it, with the app's lint and build, on every push to `main`.
- `orma-mark` (`verify.mjs`) follows the share's valuation pointer, rejects one copied onto another share
  (`SPOOFED`), recomputes the withdrawal value from the vault and cross-checks Orma's Oracle object: 0.703000,
  exit 0. It trusts the Devnet node it reads (`--ws` picks another).
- The `curl` shows L2's default (`LoanManage`, `tesSUCCESS`, ledger 6389290), not yet captured in `evidence/`.
  Amendments relied on, enabled per Devnet's `feature` on 25 October 2026: `SingleAssetVault`, `LendingProtocol`,
  `LendingProtocolV1_1`, `TokenEscrow`, `MPTokensV1`, `PriceOracle`.

### What was built during the event

The annotated tag `nyc-start` (`bd39502`, 24 October 12:18:07 ET) marks the opening; `nyc-start..main` is the
event's work, one tag per step. Numbers follow the plan, not the clock (19 to 22 on Saturday, 15 on Sunday), and
16 to 18 have no tag, although HACKATHON.md, written from the plan at the opening (`4eccf89`), names `step-16-rehearsal`.

| Tag | What it adds | Check (offline unless marked) |
|---|---|---|
| `step-01-contract` | The `orma.*/1` documents: each figure names one formula from a closed table and its inputs; no amount is a JSON number. | `node src/dev/check-nyc-contracts.mjs` |
| `step-02-harness` | The New York routes in the existing API, and `src/dev/with-api.mjs`, a local API that never publishes. | `node src/dev/with-api.mjs --self-test` (Devnet) |
| `step-03-pinned-reads` | Every state read names a numeric validated `ledger_index` and keeps its hash. | `node src/dev/check-pinning.mjs` |
| `step-04-publisher-identity` | The XLS-47 publisher `r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL`, `Provider` `Orma`, one document id per vault. | `node src/dev/check-reader-edges.mjs` |
| `step-05-bake-nyc` | Harbor-1 to Harbor-3, the lending vaults `desk` and `spare`, the collateral accounts, the chain test and the anchored mandate. | `node src/dev/check-demo-ready.mjs --nyc --self-test` |
| `step-06-orma-mark` | `orma-mark`: anyone checks a share's valuation from its MPT id alone. | `node src/dev/check-mark.mjs` |
| `step-07-ticket` | The risk ticket, the mandate route and the desk's positions. | `node src/dev/check-ticket.mjs` |
| `step-08-role-engine` | The browser's only write path: a closed list of named actions, each previewed, then confirmed. | `node src/dev/check-roles.mjs` |
| `step-09-desk-kit`, `step-11-desk-screens`, `step-19-desk-copy` | `/desk`, tabs Ticket, Positions and Mandate, and its wording (a shortfall is a margin call); the browser replays each figure's formula on its inputs. | `node src/dev/with-api.mjs -- pnpm --dir app smoke` (Devnet) |
| `step-10-desk-signer` | The countersignature after a re-read at a new validated ledger, and the hash-chained decision log. | `node src/dev/check-desk.mjs` |
| `step-12-change-engine` | `orma.change/1`, the collateral release rule, the guard on what the Orma agent co-signs, a read-only auditor. | `node src/dev/check-change.mjs`, `node src/desk/audit.mjs --self-test` |
| `step-13-universe`, `step-14-feed` | Universe: every vault on file or seen in the transaction stream, priced at one ledger. Feed: credit events derived from full re-reads of each vault, by polling or server-sent events. | `node src/dev/check-universe.mjs`, `node src/dev/check-feed.mjs` |
| `step-15-hardening` | Per-client limits on the API's ledger walks, then a review pass over `nyc-start..main` and its fixes. | `npm run check:api` |
| `step-20-margin-call` | Margin calls under a declared policy, cured by pledging more shares. | `node src/dev/check-margin-call.mjs` |
| `step-21-usd-loans` | Loans in a Devnet test dollar, at an XRP/USD price read from three XLS-47 documents. | `node src/dev/check-usd.mjs` |
| `step-22-late-payments` | Each ticket's payment record: days past due, payments missed. | `node src/dev/check-payments.mjs` |

### The event's transactions on Devnet

Devnet prunes, so each link is saved in [`evidence/devnet-tx/`](evidence/devnet-tx/): the signed transaction
hashes back to its id; its result (the metadata) is the copy Devnet's server returned. Each Harbor vault has
two curator loans: L1 impaired, then explained in the vault's `Data` field; L2 defaulted on demand.

| Vault | Created | Loans L1 and L2 | L1 impaired | Curator's statement |
|---|---|---|---|---|
| Harbor-1 | [FBD87DF2…](https://devnet.xrpl.org/transactions/FBD87DF24EAC9B6537A09FA27D9CBD1E735C7C505066DB4C47E29D9551BA13F4) | [E4FEEA2E…](https://devnet.xrpl.org/transactions/E4FEEA2E814178F7D2A53CFEBBDAE569874C0CB8885B45837800BAAF7C66FA28) · [3420270B…](https://devnet.xrpl.org/transactions/3420270B93FA047C39580B71A882766797B23C06A4C6AB0AF7691B0EDB2C5182) | [D38861C6…](https://devnet.xrpl.org/transactions/D38861C64E4228444AA04EEEAC5F2972E29FF378000446CCE0A5AA5C6C56A51F) | [FF81A871…](https://devnet.xrpl.org/transactions/FF81A871D4437C40CE554BE3C293D480E514BDB14B3D993E3CFB26D953A85A79) |
| Harbor-2 | [B752D9AB…](https://devnet.xrpl.org/transactions/B752D9AB2A79990ED0404610A16CDC5585654D5A01FF297C87CEA9BCF97E675A) | [8FC8CB2A…](https://devnet.xrpl.org/transactions/8FC8CB2AB566D06128E0B105C0113C351C05FA8360D4B2CEBE11EF0DCBC54B07) · [C07E8885…](https://devnet.xrpl.org/transactions/C07E8885EEAC4BC1CA76BDCEAA5C72449C4ECA86F391543302E178753FC6DECA) | [F72442F6…](https://devnet.xrpl.org/transactions/F72442F6B625C0A45D55B35B269D9EDC17478D5E7A6E1B248E0D94F1A5D43843) | [3DC3B33F…](https://devnet.xrpl.org/transactions/3DC3B33F68689D913D3F166FF6FC97A594F73C0990EF255E59077C4F7B3A06E6) |
| Harbor-3 | [B471BFC2…](https://devnet.xrpl.org/transactions/B471BFC2E3AC5997C2679EBE725CB9A8BA678DE0749539FFE97C89E456E0F086) | [B2F2A187…](https://devnet.xrpl.org/transactions/B2F2A1871976A922C72764ED6296B09C81E666C259F15E1F26443B1D97A9834B) · [6EA40580…](https://devnet.xrpl.org/transactions/6EA40580AB4C5C6CB02232916DBDEA08F9F7B5668C5E7ADE7F57D46A6D03BC97) | [D155ED6C…](https://devnet.xrpl.org/transactions/D155ED6C45C9BC14588D960F1F373857822B388244357F7A5E8B93B948906B2C) | [5CBB6ED4…](https://devnet.xrpl.org/transactions/5CBB6ED468907DF3D802EB5A22AC90EE95FFB3A00EF903A30A560639AF43F28D) |
| `desk` and `spare`, the desk's lending vaults | [07D7FF14…](https://devnet.xrpl.org/transactions/07D7FF14A713A8D2657528F641CC71C871D2F3ACE4E771444FC2CF038962F2D2) · [954DA2B3…](https://devnet.xrpl.org/transactions/954DA2B3BBE1572EA37E0529EBC7D44BDFD7CEC1A5DBF6B50FFA8B4F17000791) | | | |

- The chain test on `spare`: the borrower's [escrow of 5,000,000 Harbor-1 share units](https://devnet.xrpl.org/transactions/9690077B02B4F8951182106AB315B9B51A92F31659466883DBD493D8510E22DD)
  into a 2-of-3 account, the [LoanSet countersigned by the desk](https://devnet.xrpl.org/transactions/8A8F8176C6DB9FC3E511D72144A4351C37084DBB99D069027510ED3FDC7648E1)
  whose `orma.escrow` memo names that escrow, and a [Payment of shares out of a 2-of-3 test account](https://devnet.xrpl.org/transactions/D3E98D23A112CCCC9E922D03625C41B8456984A1CB12696D9689F3074F09D4EC), signed by the desk and the agent.
- The mandate `desk-1`, [anchored by the risk officer](https://devnet.xrpl.org/transactions/E63C8AB9D41042B315AE41F45CF2B624592CDC190C66E87D17C8275A2A0A92ED)
  with its hash in the memo, and Orma's [XLS-47 publication of Harbor-1](https://devnet.xrpl.org/transactions/DE7AF2C4F11D3250A2AD66A85E65EE179A6B29277609EA76AE3E09F9AE135262), `NAV` 0.800000.
- Not captured yet, so not linked: L2's default (the `curl` above), the margin policy's and dollar terms' anchors
  and the dollar pool's transactions (hashes in `demo/margin-policy-desk-1.json`, `usd-terms-desk-1.json`, `desk-usd.json`).

## How it works

The reader (`src/poll.mjs`) re-reads each vault every 4 seconds; amounts stay decimal strings, in `decimal.js`
at 40 digits (`src/num.mjs`). It never trusts metadata for state: a field at its default is not stored, so
Harbor-1's first impairment has `LossUnrealized` in `FinalFields` and an empty `PreviousFields`, and a reader
that takes `PreviousFields` as the list of changes misses the loss. The browser writes only through the role
engine (`src/roles/engine.mjs`): a closed list of actions, a run token, a kill switch, one serial queue per
signing account; then `src/desk/signer.mjs`, `src/change/engine.mjs` and `src/nyc/contracts.mjs`.

## The rules, and the check for each

| | Rule | Check (offline unless marked) |
|---|---|---|
| I1 | A pledge is valued only at its withdrawal value, read at a validated ledger: every input of every figure carries that ledger's index and hash. | `node src/dev/check-ticket.mjs` |
| I2 | The desk countersigns a `LoanSet` only if, at the ledger it re-reads, the escrow its memo names exists, belongs to the borrower, holds the ticket's shares and pays into a conforming collateral account, and the recomputed ticket passes the mandate. | `node src/dev/check-desk.mjs` |
| I3a | The desk accepts a collateral account only with its master key disabled, no regular key and signers {borrower, desk, Orma agent} at weight 1, quorum 2: no one key moves the shares. | `node src/dev/check-nyc-contracts.mjs` |
| I3b | The Orma agent co-signs only the release `Payment` its published rule names. | `node src/desk/audit.mjs --self-test` |
| I4 | Only shares of XRP vaults are collateral (an issued asset can be clawed back or frozen by its issuer), with share flags exactly `0x38`: escrow, trade, transfer; no lock, no clawback. | `node src/dev/check-usd.mjs` |
| I5 | The role engine has no action that builds a `LoanPay`, a `tfLoanUnimpair` or a `VaultDeposit`. | `node src/dev/check-roles.mjs` (an action off the list is 404); `git grep -qE "LoanPay\|tfLoanUnimpair\|VaultDeposit" -- src/roles` exits 1 |
| I6 | A curator's statement (`orma.stmt/1` in `Vault.Data`) is labelled DECLARED and enters no figure. | `node src/dev/check-ticket.mjs` |
| I7 | No figure on an inconsistent snapshot: the vault is held to rippled 3.4.1's vault state checks (`VaultInvariant.cpp`, lines cited in `src/ticket/inputs.mjs`), else `409 INCONSISTENT_SNAPSHOT`. | `node src/dev/check-ticket.mjs` |
| Publisher | Only our server publishes Orma's Oracle objects; the local API every check starts blanks `PUBLISH_SEED` and `PUBLISH`. | `node --env-file-if-exists=.env src/dev/with-api.mjs --self-test` (Devnet) |
| Production | Production's decision log (from our API) and collateral accounts (from Devnet) break none of I1 to I3 and I7. | `node src/desk/audit.mjs`, no key (our API and Devnet): exit 0 clean, 1 on a violation, 2 when a read fails |

### What you have to trust, and what is not covered

- **Keys.** The borrower and the desk together can always move pledged shares, and in this demo our server holds
  both keys: I3a holds between distinct parties only. No release by the agent runs in the demo, and after a
  default the escrow must be finished before its `CancelAfter`, or anyone may cancel it and return the shares.
- **The publisher and the browser.** Orma's Oracle objects carry what our key signs; orma-mark recomputes from
  the vault and only cross-checks them. The browser replays each formula on the inputs the API sent; it does
  not re-read the ledger, orma-mark and `audit.mjs` do.
- **Between the re-read and the loan.** The `LoanSet` validates a few ledgers after the desk's re-read. The
  pledge cannot leave meanwhile (an `EscrowFinish` before `FinishAfter` or `EscrowCancel` before `CancelAfter`
  is refused, as the chain test showed), but the vault's value can move; the next ticket and margin call see it.
- **Rounding.** The withdrawal value is computed at 40 digits and printed to 6 decimals. It has not been compared
  with xrpld's own arithmetic on a real `VaultWithdraw`, which the lock-up does not allow yet.
- **The dollar price.** No one runs an XRP/USD oracle on Devnet: `src/demo/fx-relay.mjs` copies Kraken, Bitstamp
  and Coinbase trades into three XLS-47 documents every 60 s from one account. A mechanism, not independent prices.

## Running it

`npm start` serves the reader and the API on http://localhost:8787, read-only: writes answer `503 NOT_CONFIGURED`
until `ROLES_FILE` and `DESK_SEED` name Devnet accounts of your own (`.env.example`). The app, against it:
`pnpm -C app install --frozen-lockfile && pnpm -C app dev`. The API contract is `src/openapi.json`, described in
`documentation/pages/http-api.mdx`. Production is the `Dockerfile` container behind the site's `/api/*` rewrite.

## Before New York: Paris, September 2026

Orma's information layer was built at the De Vinci Blockchain XRPL Lending Protocol Hackathon in Paris, 12–13
September 2026; our issue on the empty `PreviousFields`, [xrpl-dev-portal#3926](https://github.com/XRPLF/xrpl-dev-portal/issues/3926),
is open. The Paris README, paper and feedback report are at [`nyc-start`](https://github.com/BuzzBallz/orma/tree/nyc-start);
the submission is the [`hackathon-submission`](https://github.com/BuzzBallz/orma/releases/tag/hackathon-submission) release.

## Team

Alexandre Lemiere ([@frytegg](https://github.com/frytegg)) and Andrea Gonzalez ([@andreagnzz](https://github.com/andreagnzz)),
team BuzzBallz, **1st place of 14 projects** at the Paris hackathon ([ESILV](https://www.esilv.fr/xrpl-hackathon-devinci-blockchain-remporte-deux-places-sur-le-podium/)).
In New York, by commit author in `nyc-start..main`: Alexandre, the contract, pinned reads, the bake, the ticket, the
desk signer, the change engine with the release rule and auditor, Universe, the per-client limits, the desk copy,
margin calls, test-dollar loans, late payments and the hardening fixes; Andrea, the harness, the publisher identity,
orma-mark, the role engine, the desk kit and screens, the Feed, and the desk's redraw and fixes.

MIT licence (`LICENSE`).
