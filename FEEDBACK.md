# Developer feedback — building on XLS-65 / XLS-66

> ## ⚠️ DRAFT — REWRITTEN SUNDAY FROM THE REAL BUILD
>
> **This is not the finished deliverable.** It was assembled from pre-event protocol reconnaissance, before
> we had written a line of the product. The rulebook asks for *"your personal experience, in your own
> words"*, and a report written before the build cannot honestly claim that.
>
> It stays in the repo as the **evidence base**: every claim below is verified against live Devnet with
> transaction hashes, and the full 38-finding register is in [`FEEDBACK-APPENDIX.md`](FEEDBACK-APPENDIX.md).
>
> **It gets rewritten Sunday 10:30–12:00** from what actually happened building the product, using three
> sources: the friction we hit during the build (primary), the `/xrpl-session-analysis` outputs the hook
> produced, and this register (supporting). The three friction points may change — and if they do, that is
> the process working.

---

| | |
|---|---|
| **Track** | **2** — closed-ended vault, Lending Protocol **V1.1** |
| **Flavour** | **Loaded** (XLS-47 Price Oracle + XLS-70 Credentials + PermissionedDomains) |
| **Environment** | XRPL Devnet, `wss://s.devnet.rippletest.net:51233`, rippled **3.4.0-rc5**, `network_id` 2 |
| **Libraries** | `xrpl` **5.2.0** with `ripple-binary-codec` **2.11.0**, Node 24.13.0 · `xrpl-py` 5.1.0 and 5.2.0b0 |
| **Evidence** | 38 findings with transaction hashes: `FEEDBACK-APPENDIX.md` |

*The brief pins `xrpl@5.2.0-beta.0`; stable **5.2.0** shipped hours before the event and supersedes it.
We pinned stable and raised it with a mentor.*

---

## What we set out to build

A third-party solvency reader for lending vaults: a poller that re-reads vault state, a six-dimension
fragility score published as a native XLS-47 Oracle object, and an XLS-70 credential wired into a
PermissionedDomain so the grade actually gates deposits. To build it we had to originate real loans on
Devnet, service them, impair them, default them, liquidate first-loss cover and read the result back
correctly. We got all the way through.

One thing first, because it is the more important half. The design is good, and in one respect better than
what it will be compared against: a closed-ended vault forbids maturity transformation at the ledger level.
`VaultWithdraw` is refused for the whole Investment phase, and no `LoanSet` may mature after
`RedemptionDate`. Maple and Goldfinch retrofitted lockups *after* a run; you made the run mechanism
illegal. Nothing below is about that.

## The wall we hit first

`LoanBrokerSet` returned `tecNO_PERMISSION` on a vault we owned. The docs say the submitter must be the
vault owner. We were the vault owner. We spent two hours on key derivation, `VaultID` encoding and field
shapes before giving up and reading `LoanBrokerSet.cpp`, where the answer sat in a well-written comment:
under `LendingProtocolV1_1`, only a **closed-ended** vault may host a loan broker.

`VaultKind`, `SubscriptionDate`, `RedemptionDate` and `LEVersion` appear **zero times** across the published
XLS-65, XLS-65.1 and XLS-66. The spec for the vault kind our whole track is built on is PR #587, open since
21 July; cash-basis accounting is PR #582, open since 16 July. Both are by XLS-65's own authors. Library
maintainers can read them; application developers cannot.

Then we ran the official lending tutorial and it died at `Setting up tutorial: 5/7` with
`TypeError: Cannot read properties of undefined`, because `lendingSetup.js` creates an open-ended vault,
`submitAndWait` does not throw on a `tec`, and `.find()` over the metadata returns `undefined`. The
developer is shown a stack trace — not a result code, not a vault kind, not an amendment name. That is
what a participant hits at minute ten, and it is why our one code contribution is a fix for it.

## What it cost

The rest was the ordinary tax of a pre-mainnet amendment. Rate fields are in 1e-5 units — `100000` is 100%
— and the most useful written source we found for that was `node_modules/xrpl/.../loanSet.js`. Reading a
library's compiled validators beat reading the standard, which is a signal worth acting on.
`tecNO_PERMISSION` meant four different things on our path, and one probe of ours misread it into a false
bug report we caught only by cross-checking. And the minimum feedback loop is a wall clock:
`MIN_INVESTMENT_PERIOD` is 180 s, impairment needs a missed payment, default needs a grace
period. Cold faucet to funded loan measured 88 s and 143 s; a full originate→pay→impair→default cycle
395 s, ~380 s of it waiting. Nobody will write a CI suite against that.

What we shipped around it: never diff metadata; re-read the `Vault` SLE every four seconds; coalesce absent
to `"0"`; parse with `decimal.js` at precision 40; guard the four `Loan` fields a default deletes. One
`npm run verify` drives the whole chain live in 45 s, so every session starts from proof.

---

## The three things that would have saved us the most time

### 1 · The metadata hides the one credit event that matters

*Category: missing primitive (observability) · Severity: blocker · rippled 3.4.0-rc5 · repro
`8B9657E31D9130FE557682FE33E779789243EACEB0E0D97D83F5D6A3F477A1D5`, re-run unchanged today*

The first impairment of a previously-healthy vault emits `PreviousFields: {}` while `FinalFields` carries a
non-zero `LossUnrealized`: the field was absent at its type default, and cash-basis accounting leaves every
other Vault field untouched. An indexer that diffs metadata sees a node *touched but unchanged*. Naive NAV
reads **1.000000**; correct NAV reads **0.803922**. A 1,961 bps divergence, silent.

It is asymmetric, which is why it survives testing: un-impairment and a *second* impairment both diff
correctly; only the healthy→distressed transition is invisible. You sell fixed-term lending on clean
accounting under IFRS and GAAP, and the obvious way to compute NAV is wrong at exactly the moment an
auditor would care.

This was reported before us, as `rippled#6487`, by the operator of the XRPLWin explorer — precisely the
metadata-diffing indexer author this trap is built for. He closed it himself the same day: *"Not a bug."*
No maintainer replied. He was half right, and the missing half is one paragraph.

**Proposal.** Add to the transaction-metadata page: *"`PreviousFields` omits any field whose previous value
equalled the type default. Do not infer 'unchanged' from an empty `PreviousFields`."* Cross-link from `Vault`
and `LoanManage`. The better fix — recording the default when a field is created — needs an
amendment; the paragraph does not, and it would have saved us a day.

### 2 · The documented first hour cannot complete

*Category: documentation / tutorials · Severity: blocker · `xrpl-dev-portal` master;
`_code-samples/lending-protocol/js` pins `xrpl ^4.6.0` · repro and fixed script in `contrib/tutorial-fix/`*

Two halves. The code sample needs four transaction fields and one result-code check, and we have the PR for
it. The standard needs one line: XLS-66 §3.3.3.2 enumerates **ten** protocol-level failure conditions for
`LoanBrokerSet`, and the closed-ended requirement is not among them. `xrpl-dev-portal#3923` lands the
developer-facing half well — we verified every rule in its diff against rc5 — but it is unmerged, targets
`release-3.4.0`, and does not touch the lending code samples. PR #582 defers the rule to #587, and #587
never mentions `LoanBrokerSet`: the two in-flight specification PRs point at each other and neither
specifies it.

**Proposal.** Merge #3923, #587 and #582; add an eleventh failure condition to XLS-66 §3.3.3.2
(*"`Vault(VaultID).VaultKind` is not `ClosedEnded` — `tecNO_PERMISSION`, requires `LendingProtocolV1_1`"*).
And surface the transactor's `JLOG` reason in the result: rippled already computes *"LoanBroker requires a
closed-ended Vault."* and throws it away. `rippled#7848` is prototyping exactly that, and it would have
turned our two hours into one read.

### 3 · Composability, and no proof of ledger state

*Category: missing primitive (composability) · Severity: major · Devnet rippled 3.4.0-rc5 vs
`groth5.devnet.rippletest.net` rippled 3.0.0-b1, `network_id` 1256 · verified live 2026-09-11*

The workshop invited feedback on combining amendments, so here is ours: we tried, and could not. Standard
Devnet has `LendingProtocol`, `SingleAssetVault` and `ConfidentialTransfer` and no `SmartEscrow`;
`groth5.devnet` has the BN254 verifier and no vaults at all. Underneath that, `ledger_entry` has no `proof`
parameter — `LedgerEntry.cpp` contains zero occurrences of "proof" — so nothing off-ledger can verify a fact
about XRPL ledger state. Our own oracle publishes a number any rippled node serves, and still cannot
*prove* the state it read. `XRPL-Standards#611` hits the same wall from the accounting side.

**Proposal.** A read-only `proof` option on `ledger_entry` returning the SHAMap inclusion branch —
non-consensus, amendment-free, on a handler that already walks the map. And one Devnet carrying both
amendment sets, so the combination is testable by anybody.

---

## Where it got better mid-event

Twice, and worth saying. For 17 days `npm install xrpl` returned a library that could not serialize
a closed-ended `VaultCreate`, and `validate()` and `autofill()` both passed it, so the failure surfaced as
an opaque codec error inside `Wallet.sign()`. `ripple-binary-codec` **2.11.0** fixed that on 11 September,
and because the codec range floats it reached every fresh install; `xrpl` **5.2.0** followed hours later
with the `SIGNING_ENCODERS` table that fixed counterparty signing. We had a twenty-line raw-signing
workaround for each, deleted both at 05:30 on Saturday, and ran the full chain on stock `submitAndWait`.
Two of our findings became release notes before we could file them. (`xrpl-py` got neither — no published
version can counterparty-sign a `LoanSet` — so Python has no path to originate a loan.)

## What we contributed back

A Devnet-verified fix for the lending tutorial, offered as a PR against `xrpl-dev-portal`: closed-ended
`VaultCreate`, result-code checks before indexing `AffectedNodes`, a `close_time` poll before `LoanSet`,
and the `xrpl` bump. The corrected chain runs green in 79.6 s against rc5; diff and run log in
`contrib/tutorial-fix/`. Independent confirmation on rc5 that every rule in `#3923` behaves as written.
And our reproductions go onto existing threads rather than into duplicates: `rippled#6487`,
`xrpl-dev-portal#3612`, `xrpl-py#1016`, `XRPL-Standards#625`.

## What we would tell the next team

Read `LoanBrokerSet.cpp`, `LoanSet.cpp` and `VaultWithdraw.cpp` before anything else — for this amendment
the C++ is the most accurate document that exists, and its comments are written for exactly the confusion
they cause. Then read the open pull requests on `XRPL-Standards` and `xrpl-dev-portal` file by file, not by
title: the specification you need is in review rather than on the site, and we rewrote three findings the
morning we read a diff instead of a heading. Build a one-command script that drives the whole chain live,
and run it every session — the toolchain moved under us twice in 48 hours. Pre-bake your demo state; the
phase clock does not negotiate. And never trust an empty `PreviousFields`.

---

*Word count: 1,497.*
