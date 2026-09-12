# Orma

A lending vault on XRPL Devnet took 51 XRP, lent 10, and the borrower stopped paying. The manager wrote the
loan down, the unit fell from 1.000000 to 0.803922, and the transaction metadata that every indexer diffs
came back with `PreviousFields: {}`, an empty change set. Orma is a credit measurement, publication and
enforcement layer for XLS-65 vaults and XLS-66 lending that reads solvency from ledger state instead of from
metadata diffs, publishes the result as a native XLS-47 Oracle object and as a pointer inside the share
token's own metadata, and lets an independent third party gate deposits on it through XLS-70 credentials.

**The asymmetry.** The party who decides *when* a vault recognises a loss is the same party who decides *in
what order* those losses are realised. The `LoanBroker` owner is necessarily the vault owner, by protocol.
Both decisions move money from investors to them, and neither is visible with the standard tools. Orma
measures both, publishes them, and enforces on them. One asymmetry, two levers, then enforcement.

---

## Compliance

| | |
|---|---|
| Track | **2**, closed-ended vault, Lending Protocol V1.1 |
| Flavour | **Loaded**, XLS-47 Price Oracle plus XLS-70 Credentials and XLS-80 Permissioned Domains |
| Network | XRPL **Devnet**, `wss://s.devnet.rippletest.net:51233`, `network_id` **2** |
| `rippled` | **3.4.0-rc5** |
| Libraries | `xrpl` **5.2.0** with `ripple-binary-codec` **2.11.0** |
| Runtime | Node **24.13.0** |
| Team | **BuzzBallz** |

Devnet is not a convenience. The lending amendments are not on Mainnet, so Devnet is the only network where
XLS-65 and XLS-66 exist. XLS-47, the publication rail, *is* live on Mainnet today; the measurement and the
gate are not deployable until the lending amendments ship.

---

## Transactions used

Every transaction type the project submits, grouped by the standard it belongs to.

### XLS-65, Single Asset Vault (amendment `SingleAssetVault`)

| Transaction | What Orma uses it for |
|---|---|
| `VaultCreate` | Creates each demo facility. All four are closed-ended: `VaultKind=1` with `SubscriptionDate` and `RedemptionDate`, because `LoanBrokerSet` returns `tecNO_PERMISSION` otherwise, and `VaultKind` is immutable. |
| `VaultDeposit` | Subscribes investor capital, and is the transaction the XLS-70 gate admits or refuses at Thorne. |
| `VaultWithdraw` | Redemption. Also the proof that revoking a credential closes entry without trapping the exit. |

### XLS-66, Lending Protocol (amendments `LendingProtocol`, `LendingProtocolV1_1`)

| Transaction | What Orma uses it for |
|---|---|
| `LoanBrokerSet` | Creates the `LoanBroker`. Its owner is necessarily the vault owner, which is the asymmetry the whole project measures. |
| `LoanBrokerCoverDeposit` | Posts the first-loss cover whose consumption the ordering lever moves. |
| `LoanSet` | Originates each loan, counterparty-signed. Under cash-basis accounting (`LEVersion=1`) origination moves `DebtTotal`, not `AssetsTotal`. |
| `LoanManage` | Impairs (`Flags 0x20000`) and defaults (`Flags 0x10000`). These are the two levers. Only the broker owner may submit either. |

### XLS-47, Price Oracles (amendment `PriceOracle`)

| Transaction | What Orma uses it for |
|---|---|
| `OracleSet` | Publishes the six-dimension score, one `PriceData` entry per dimension: `NAV`, `HDL`, `LIQ`, `COV`, `CNC`, `DDL`. The base asset is derived from the vault id. |
| `OracleDelete` | Retires a document id. `OracleSet` is not a merge, so a stale document accumulates pairs until nothing can be published at all. |

### XLS-70, Credentials (amendment `Credentials`)

| Transaction | What Orma uses it for |
|---|---|
| `CredentialCreate` | Issues the grade, credential type `ORMA-IG`. The subject's consent is not required to issue. |
| `CredentialAccept` | The subject accepts, which is what makes the credential usable inside a domain. |
| `CredentialDelete` | Revocation. Entry closes, the exit stays open. |

### XLS-80, Permissioned Domains (amendment `PermissionedDomains`)

| Transaction | What Orma uses it for |
|---|---|
| `PermissionedDomainSet` | An independent vault owner names Orma's issuer as an accepted credential. We signed nothing, and we cannot decline. |

### Supporting standards

| Transaction | Standard | What Orma uses it for |
|---|---|---|
| `MPTokenAuthorize` | XLS-33 MPT (`MPTokensV1`) | Lets a second lender hold a vault's share token before it is pledged. |
| `EscrowCreate` | XLS-85 TokenEscrow (`TokenEscrow`) | Pledges vault shares on ledger to a second lender. That pledge is what Orma prices. |

---

## The four live Devnet facilities

Each was originated, serviced, impaired or defaulted on live Devnet, and its capture is committed. The
reader loads all four at startup.

### 1. Meridian Trade Finance I, the empty change set

```
vault   864C5A2DDCED78C6198B0703169D533B747A56E5F9398D832033F79E37E8C835
broker  41BD2EA81CD03ED9EAC612BFFC6179AC742120FC4A5E0DD1D3E4DCE7DB5B2F38
impair  075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3
file    demo/indexer-race.json
```

`LossUnrealized` moved from 0, and rippled omits from `PreviousFields` any field whose previous value was the
type default. Under cash-basis accounting nothing else on the Vault object changes. The metadata is
therefore emitted empty: an indexer that diffs it sees a node touched but unchanged. Naive NAV reads
`1.000000`. Net of the recognised loss it is `0.803922`. **1961 basis points apart, on the same transaction,
from the same ledger.**

### 2. Kestrel Bridge Financing II, the ordering lever

```
vault   24EAA01AD4CE70D8ABB4ACB4255DC4C216B8AF3B9E7315DB8052BFC1E5810089
broker  8DB104980C31CBE9F196508E7D748E8C31FB783CD4E0A3620AE0B476CBDEA3FA
file    demo/ordering-vault.json
```

Cover liquidated on a default is sized against the broker's **total** book, not against the loan that
defaulted, and the book is decremented as each default lands. So the order of declaration changes the total.
Two bad loans of 30 XRP and 10 XRP, declared largest first, consumed **0.50 XRP** of the manager's own
first-loss capital. Smallest first would have consumed **0.70 XRP**. Same losses, same rates, only the order.
The **0.20 XRP** difference is investor money, and the party who chose the order is the party it spared.

By the rearrangement inequality this is general, not an artefact of these two numbers: total cover consumed
is minimised by declaring the largest exposure first. Conduct grade **E**, findings
`ORDERING_SELF_SERVING` and `DEFAULT_WITHOUT_IMPAIRMENT`. The facility destroyed **79% of subscribed
capital**, which notches the composite from an AAA anchor down 14 steps to **B**.

### 3. Calder Structured Credit III, the token that prices itself

```
vault     5763707D11EA19D1B5FF04E4EBA4F9336057955CDE65B725D1FF3EF2A96CB0E5
broker    1C160EFFCA8208DFD8CE9B065A3C3C41CCA80758FBC3099BE27AACFBD1478173
shareMPT  000000014D667775372D5B78E07FFF294678C7F9CE82AFBC
impair    BD18EFB94490CA540E7A9C249971740C1228D1FBC3ED97C9BA9F4908F52D5F4F
file      demo/metadata-vault.json
```

The share token carries a valuation pointer in its own MPT metadata. An investor pledges units to a second
lender who holds a token and nothing else; that lender reads the token's metadata, follows the declared
`nav_url`, and prices the pledge in five steps, none of which involve a relationship with us. A pledge of
1,000,000 units prices at **1.000000 XRP** naively and **0.803922 XRP** on what the instrument points to.
**0.196078 XRP of overstatement kept out of the second lender's book.** A haircut absorbs volatility; it does
not absorb a misstatement. This manager impaired the loan and has written nothing off, which the
conduct assessment scores **A** against Kestrel's E.

### 4. Thorne Senior Secured I, enforcement

```
vault   4A5A8E3716D52E334AEB077ADB09456EF4A941CC26021A8EAD37F95B00190DF5
domain  FFBEC89D98B4E7CF52F4F254235086514A90CED0EC531941BDF747AF40C5A2FB
issuer  rKQjjU5KFs9RAZCDvYVjcaoVK5gGsCJgkP, credential type ORMA-IG
file    demo/gate-vault.json
```

An unrelated vault owner named our credential issuer in their `PermissionedDomain` and bound the domain to
their vault. Two investors, same second: the graded one deposited, the ungraded one was refused **by the
ledger**, not by us. When the credential is revoked, `VaultDeposit` is refused and `VaultWithdraw` still
succeeds. A rater who could trap capital would be a worse problem than the one we solve.

---

## Running it

Node 24.13.0. **Do not run `npm install` or `pnpm install` in the repository root.** `node_modules/` is
installed and verified against live Devnet, and re-resolving it is the one reliable way to lose a working
toolchain.

```bash
node src/index.mjs
```

The reader auto-discovers the baked facilities: it reads every `demo/*.json`, takes the `vaultId` and
`label` from each, and serves all four without a single hex id being typed. Explicit
`--vault <64-hex>[:label]` arguments, or `VAULTS=<id>,<id>`, override the discovery. The API listens on
`http://localhost:8787` and the reader re-reads full vault state every 4 seconds.

```bash
cd app && pnpm install && pnpm dev
```

The frontend comes up on `http://localhost:5173` and talks to port 8787.

Optional and off by default: set `PUBLISH_SEED=s...` to publish the score to the ledger as XLS-47 Oracle
objects. Reading correctly is the product; publishing is distribution, and a missing seed must never stop
the reader from starting.

```bash
npm run verify      # ~45s, live Devnet, proves the whole lending chain signs with no workarounds
```

The HTTP contract is frozen and documented in `docs/01-API-CONTRACT.md`:

```
GET  /api/health
GET  /api/vaults
GET  /api/vaults/:vaultId
GET  /api/vaults/:vaultId/nav
GET  /api/vaults/:vaultId/collateral
GET  /api/vaults/:vaultId/broker-history
GET  /api/vaults/:vaultId/gate
GET  /api/mpt/:mptIssuanceId/nav          # CORS-open: called by a party with no relationship to us
GET  /api/mpt/:mptIssuanceId/resolve      # CORS-open
```

---

## Repository map

### `src/`, the backend

Plain ESM `.mjs` with JSDoc typedefs, no build step.

| File | What it does |
|---|---|
| `index.mjs` | Entrypoint. Facility discovery, reader, API, optional oracle publishing. |
| `poll.mjs` | The 4-second reader. Re-reads the `Vault` SLE every tick and never diffs `PreviousFields`. |
| `score.mjs` | The five measured factors and the ordinal notching. No weights anywhere: a weighted average lets a strong factor pay for a broken one. |
| `history.mjs` | Broker history reconstruction and the cover-ordering mathematics. |
| `nav.mjs`, `collateral.mjs` | NAV both ways, and pledge valuation against escrowed shares. |
| `metadata.mjs` | Reads and writes the share token's valuation pointer. |
| `oracle.mjs` | The XLS-47 publisher and the four invariants that corrupt data silently rather than erroring. |
| `credentials.mjs` | XLS-70 issuance and acceptance, and the XLS-80 domain. |
| `api.mjs` | The frozen HTTP contract. |
| `num.mjs` | `decimal.js` at precision 40. No `Number()` and no `parseFloat` ever touches a monetary value. |
| `demo/` | The bakers that create each facility on Devnet, plus the phase matrix and the collateral scenario. |
| `dev/` | `check-*` scripts, each proving one claim against live Devnet. |

### `app/`, the frontend

React 19, Vite, Tailwind, TypeScript. Screens: Portfolio, Facility, Evidence, PledgeResolution, EntryGate,
Methodology, Event. It polls the backend and renders the same numbers the API serves, with the notch trace
that produced each grade.

### `demo/`

The four captured facilities, one JSON file each, with vault ids, transaction hashes, the readings and the
verdict. These are committed artefacts: the Evidence screen renders from them and needs no API.

### `contrib/`

`contrib/tutorial-fix/` is our code contribution upstream: a Devnet-proven fix for the official XRPL lending
tutorial. `lendingSetup.js` creates an open-ended vault, `submitAndWait` does not throw on a `tec`, and
`.find()` over the metadata returns `undefined`, so the script dies at `Setting up tutorial: 5/7` with a
`TypeError` rather than a result code. All six *Use the Lending Protocol* tutorials run it first, so all six
are currently un-followable. The directory holds the diff, the ready-to-paste PR body, a full run log, the
before and after scripts, and the upstream sources it was taken from.

### `FEEDBACK.md` and `FEEDBACK-APPENDIX.md`

`FEEDBACK.md` is the developer feedback report: what we set out to build, the wall we hit first, what it
cost, and the three things that would have saved us the most time. `FEEDBACK-APPENDIX.md` is the full
register behind it, with transaction hashes, repro steps and tracker status for every finding.

---

## Developer feedback

**40 findings: 7 P0, 19 P1, 14 P2.** Three more were withdrawn after cross-checking, and are listed as
withdrawn rather than deleted. Every finding carries a component, a severity, a status against the live
trackers, and a Devnet repro.

The three that cost us the most:

1. **The metadata hides the one credit event that matters.** The first impairment of a healthy vault emits
   `PreviousFields: {}` while `FinalFields` carries a non-zero `LossUnrealized`. This was raised before us
   as `rippled#6487` by the author of an XRPL explorer, who closed it himself as not-a-bug. He was half
   right: it is correct metadata, and it is still a silent wrong answer for every consumer downstream.
2. **The documented first hour cannot complete.** See `contrib/tutorial-fix`. We shipped the fix.
3. **A broker's action history cannot be reconstructed by filtering.** `LoanManage` carries no
   `LoanBrokerID`, and an impairment does not touch the `LoanBroker` object at all, so a filter over
   `account_tx` silently drops every impairment. `Loan.FinalFields.LoanBrokerID` in the same metadata closes
   the join. Before that fix, every default looked unsignalled, and the conduct rule written to reward
   disclosure was penalising it. That one shipped a wrong answer inside our own code before we caught it.

The register is `FEEDBACK-APPENDIX.md`. The contribution is `contrib/tutorial-fix/`.

---

## Team

**Alexandre Lemiere**, backend, protocol, research.
**Andrea Gonzalez**, frontend.

Team BuzzBallz. De Vinci Blockchain XRPL Lending Protocol Hackathon, Paris, 12 and 13 September 2026.
