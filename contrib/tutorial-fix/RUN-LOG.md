# Run log — validation of the xrpl-dev-portal lending tutorial fix (finding D2)

Date: 2026-09-12, morning (all timestamps UTC).
Operator: validation subagent. Everything below was executed live; nothing is reconstructed.

---

## 0. Environment, as measured

Devnet probe (`scripts/` sibling, `probe-env.js`):

```
rippled build_version : 3.4.0-rc5
network_id            : 2
validated ledger seq  : 5247598
close_time (ripple)   : 842513720
amendment LendingProtocol       enabled=true supported=true
amendment SingleAssetVault      enabled=true supported=true
amendment MPTokensV1            enabled=true supported=true
amendment fixCleanup3_4_0       enabled=true supported=true
amendment LendingProtocolV1_1   enabled=true supported=true
amendment PermissionedDomains   enabled=true supported=true
```

Node.js v24.13.0, npm 11.6.2, Windows 11 / Git Bash.

npm dist-tags for `xrpl` at time of run:

```
latest: 5.2.0     beta-experimental: 5.2.0-beta.1
```

Release timestamps from the GitHub API:

```
xrpl@5.2.0                  2026-09-11T22:20:47Z  prerelease=false
ripple-binary-codec@2.11.0  2026-09-11T20:56:35Z  prerelease=false
xrpl@5.1.0                  2026-08-25T00:29:54Z
xrpl-py  latest release     v5.1.0  2026-08-19T20:26:36Z
```

---

## 1. Upstream file located and pinned

Repository: `XRPLF/xrpl-dev-portal`. Default branch is **`master`** (`main` returns 404).

```
master HEAD          dc29bc4c895dd6268cdf1142cd7919f6dc8844b4   2026-09-10T18:35:43Z
lendingSetup.js blob fdb5a89cc20b8b2932bec5d0141859744ac77e6c   (341 lines, 10 170 bytes)
package.json blob    b709e194662c5986da3d4c0095aff15655f65b14   (174 bytes)
```

Fetched raw to `upstream/lendingSetup.js` and `upstream/package.json`.
sha256 `ddade59645b9901a83e8d3a6a4cc232053e76d8e5887b2d18de05cb7b9668f15` and
`8cf19a8478628dced6dc25253a7379d6f5d3bf3c612a0a823e999ef79241aba1`.

`release-3.4.0` branch carries a byte-identical copy of `lendingSetup.js` (`diff` empty).

**Line numbers verified against the real file** (`cat -n`), not against the probe notes:

| Claim in 91-FEEDBACK-DRAFT.md | Actual | Verdict |
|---|---|---|
| `VaultCreate` at L201-209 | L201-209 | correct |
| `LoanBrokerSet` at L242-246 | L242-246 | correct |
| `loanBrokerID` extraction at L258-260 | L258-260 | correct; Node reports the throw at `260:2` |
| `console.warn = () => {}` at L266-267 | L266-267 | correct |
| `signLoanSetByCounterparty` at L289 | L289 | correct |
| `package.json` pins `^4.6.0` | `"xrpl": "^4.6.0"` | correct |
| `create-a-loan-broker.md` L48 `npm install xrpl` | L48 | correct |
| `create-a-loan.md` L51 `npm install xrpl` | L51 | correct |

(The earlier probe note said "line 256" for the TypeError; the current file and the live stack trace
both say 260. The feedback draft already carries the corrected 258-260.)

Last five commits touching the file — none since February, i.e. it predates the amendment:

```
a83e6e3a1a  2026-02-25  update lendingSetup.js to use tickets instead of batch
9c729d9223  2026-02-13  update LoanSet code samples to use local signing
28e4927131  2026-02-12  update number fields to strings
883a6a1d29  2026-02-04  add coverClawback code
e32c12a359  2026-01-28  migrate lending protocol docs from opensource
```

---

## 2. RUN A — the tutorial exactly as written

Directory: fresh; `upstream/lendingSetup.js` + `upstream/package.json` copied verbatim, then `npm install`.

```
added 19 packages in 2s
xrpl             4.6.0     ("^4.6.0" resolves to 4.6.0)
ripple-binary-codec 2.11.0
```

```
### RUN START 2026-09-12T07:35:29Z ###
Setting up tutorial: 0/7
Setting up tutorial: 1/7
Setting up tutorial: 2/7
Setting up tutorial: 3/7
Setting up tutorial: 4/7
Setting up tutorial: 5/7
file:///.../lendingSetup.js:260
).CreatedNode.LedgerIndex
 ^

TypeError: Cannot read properties of undefined (reading 'CreatedNode')
    at file:///.../lendingSetup.js:260:2

Node.js v24.13.0

real    0m42.971s
### EXIT=1 2026-09-12T07:36:12Z ###
```

**Reader-visible state at failure: `Setting up tutorial: 5/7`.** Step 5 of 7. No result code, no
transaction hash, no mention of a vault or an amendment. `lendingSetup.json` is never written, so every
downstream tutorial script fails too.

This reproduces finding D2 exactly as written.

---

## 3. RUN A' — instrumented, to prove the root cause

Same file, same `xrpl@4.6.0`, with six lines of print inserted immediately before the `const loanBrokerID`
line (anchor resolved to upstream line 258). Saved as `scripts/lendingSetup.DIAGNOSTIC.js`.

```
Setting up tutorial: 5/7

VaultCreate   result: tesSUCCESS       hash: ED8C771D2A2DE24B2882220B06E95DDD7A5DA93973FFCFEDC40B5433BEAE344E
LoanBrokerSet result: tecNO_PERMISSION hash: 1785DA8082AABC314B1BA925115D33E07F5B85B5D130209F890A7400F561591F
Vault on ledger: {"LedgerEntryType":"Vault"}
LoanBrokerSet AffectedNodes types: ["ModifiedNode:AccountRoot"]
```

Three things are established here:

1. `VaultCreate` **succeeds** — the vault is real, it is just open-ended.
2. The on-ledger `Vault` entry has **no `VaultKind` field at all**. A default-valued `UInt8` is dropped
   from the SLE, so absence is the normal appearance of an open-ended vault.
3. `LoanBrokerSet` returns `tecNO_PERMISSION` and its metadata contains only `ModifiedNode:AccountRoot`
   (the fee). There is no `CreatedNode:LoanBroker`, which is precisely why `.find()` yields `undefined`.

Rippled source confirming the gate, fetched at a pinned commit rather than a moving branch:

`src/libxrpl/tx/transactors/lending/LoanBrokerSet.cpp`, L149-L161 at
`421af6db796631da4ff8b78f5d3bafae0fd3ca32` (rippled PR #8076, "fix: Reject open-ended vaults at
LoanBrokerSet", merged 2026-08-21):

```cpp
// LP V1.1: only closed-ended vaults may host a loan broker. The
// lending protocol relies on the closed-ended Subscription /
// Investment / Redemption phase structure; attaching a broker to
// an open-ended vault has no well-defined lifecycle. VaultCreate
// stays unrestricted so existing open-ended flows keep working;
// the constraint is enforced here, at the point where the vault
// is first bound to the lending protocol.
if (ctx.view.rules().enabled(featureLendingProtocolV1_1) &&
    getVaultKind(sleVault) != VaultKind::ClosedEnded)
{
    JLOG(ctx.j.warn()) << "LoanBroker requires a closed-ended Vault.";
    return tecNO_PERMISSION;
}
```

(The probe report cited "LoanBrokerSet.cpp:155-161". The true span is L149-L161 for the comment plus the
guard, with the `if` itself at L156-L161. Use L149-L161 in the deliverable.)

---

## 4. RUN B — negative control: result check only, vault left open-ended

Isolates fix (3) from fix (1). Corrected script with `VaultKind`/`SubscriptionDate`/`RedemptionDate`
removed again, `xrpl@5.2.0`. Saved as `scripts/lendingSetup.RESULTCHECK-ONLY.js`.

```
Setting up tutorial: 5/7
Error: LoanBrokerSet failed: tecNO_PERMISSION (tx F0500DF94B5529F1065316ABFA1D36665650E5A1FC13C2C6615CBC75633E372B)
    at checkResult (.../lendingSetup.resultcheck-only.js:16:11)
### EXIT=1 ###
```

Same failure point, but the reader now gets a result code and a hash they can paste into an explorer. This
is the evidence for the claim that a tutorial reporting `tecNO_PERMISSION` teaches something and a
`TypeError` teaches nothing.

---

## 5. RUN C — the corrected tutorial

`scripts/lendingSetup.AFTER.js` + `scripts/package.AFTER.json` (`"xrpl": "^5.2.0"`).

```
added 17 packages in 3s
xrpl             5.2.0
ripple-binary-codec 2.11.0
```

```
### RUN START 2026-09-12T07:40:54Z ###
Setting up tutorial: 0/7
Setting up tutorial: 1/7
Setting up tutorial: 2/7
Setting up tutorial: 3/7
Setting up tutorial: 4/7
Setting up tutorial: 5/7
Setting up tutorial: 6/7
Setting up tutorial: 7/7
Setting up tutorial: Complete!

real    1m19.636s
### EXIT=0 2026-09-12T07:42:14Z ###
```

(An earlier attempt at 07:40:34Z died on `getaddrinfo ENOTFOUND faucet.devnet.rippletest.net` — a transient
DNS failure on the faucet, unrelated to the code. The immediate retry above succeeded.)

`lendingSetup.json` written with all six IDs:

```json
{
  "loanBroker":       { "address": "rNmNYQmSfaCmgjQQi1XBS9kTfJ7biaAHV8" },
  "borrower":         { "address": "rHkGm7MmrdU7nwESnk65NZkYJUsYX1Kc3C" },
  "depositor":        { "address": "rP4gy7wVuACyDKyxazr78YydyAApnxMYSm" },
  "credentialIssuer": { "address": "rp1UC1xzbtv1MTNnuAefXgQcRmaPY78wgW" },
  "domainID":     "D7603A8CB0368DC828D3F7F44647496129BBA7C5550CA6C58F9E095C8E6D237C",
  "mptID":        "005012D2F56CDEE72C99A4295CDB779BB1CC84D5BBEAA43D",
  "vaultID":      "495C9ED4E0ECA55942AB0136D0DD46B6A45218737A02391FC80190FFC45741F4",
  "loanBrokerID": "00BD46B4A49D1C5051C9FBE5C444CA880B20D89A0EB285A048C30776EDFD1EB3",
  "loanID1":      "58199B549327F2DD4FD3CA2E7A63BF1034FE087ECA319193068C9C02630DD8B1",
  "loanID2":      "07310F3A950A4D40FF2F8E20717047D2E7BE468ED81BEF8DEE692EA4F6F3A118"
}
```

(Seeds are in the raw artefact; these are throwaway Devnet faucet accounts.)

### Transactions, from `account_tx` on the loan-broker account, oldest first

```
Payment                tesSUCCESS       A8B7E32D901045433BD18088C92D9D9517CE6BD49B4678FE455562835088F3A7
TicketCreate           tesSUCCESS       55A339D1A86248A621D8A10F43C85D810723AEEB31079FA07A2D741B942F0106
CredentialCreate       tesSUCCESS       6C39E327237CB7BB064582EC75558371F4933F31CED33090FFE6B255962057E6
CredentialAccept       tesSUCCESS       0369B07D2B5C77A6EA06877B2D5ECB0EC171FE75D7238E6C0AAA0728DA172E5F
MPTokenAuthorize       tesSUCCESS       D8956C1188F75C1CF00F57DA6077AAA2E9948FF8EFD9377F548905773AB4A308
Payment                tesSUCCESS       E6EA7A68C4A0D3BAD6CFC4494C09179A2B85EC9F896829630A9D80B6B8F0FB39
VaultCreate            tesSUCCESS       C587A94699E6244BDDF8D5C15DB5F617F8E5E59F77F494CD20BD99AB94976573
LoanBrokerSet          tesSUCCESS       2766793FB6DA13DB0B79F2836AE0122EFD6084FD2C9B7C2E40645DC36C42BF85
VaultDeposit           tesSUCCESS       9DFABC5ED8A668F8FA9321F3DC737BEDB120C84CC035E217FBE05493FC9D2412
LoanSet                tesSUCCESS       226597F009584D7975A42A5471EC4F2F4489F71D4E17C6214E689B0E42347E37
LoanSet                tesSUCCESS       1001467F863434FE9B473F6B235A56903FCACDECAC88ECD49E9A5652FBCEEC78
```

### Ledger state afterwards (`ledger_entry`, validated ledger 5247722, close_time 842514151)

```
VAULT       (Vault) 495C9ED4E0ECA55942AB0136D0DD46B6A45218737A02391FC80190FFC45741F4
   VaultKind: 1
   SubscriptionDate: 842514127
   RedemptionDate:   847698127
   AssetsTotal:     "50000000"
   AssetsAvailable: "49998000"
   Owner: rNmNYQmSfaCmgjQQi1XBS9kTfJ7biaAHV8

LOANBROKER  (LoanBroker) 00BD46B4A49D1C5051C9FBE5C444CA880B20D89A0EB285A048C30776EDFD1EB3
   DebtTotal: "2000"
   VaultID:   495C9ED4E0ECA55942AB0136D0DD46B6A45218737A02391FC80190FFC45741F4

LOAN 1      (Loan) 58199B549327F2DD4FD3CA2E7A63BF1034FE087ECA319193068C9C02630DD8B1
   PrincipalOutstanding: "1000"   PaymentInterval: 2592000
   StartDate: 842514140           NextPaymentDueDate: 845106140

LOAN 2      (Loan) 07310F3A950A4D40FF2F8E20717047D2E7BE468ED81BEF8DEE692EA4F6F3A118
   PrincipalOutstanding: "1000"   PaymentInterval: 2592000
   StartDate: 842514140           NextPaymentDueDate: 845106140
```

Both `LoanSet`s landed `tesSUCCESS`, which independently proves that `xrpl@5.2.0`'s
`signLoanSetByCounterparty` produces a signature `rippled 3.4.0-rc5` accepts under `fixCleanup3_4_0`.

---

## 6. The diff

`tutorial-fix.diff`. Produced with `git diff --no-index` over trees holding the byte-exact upstream files
and the corrected ones. The `index` lines carry the real upstream blob hashes (`fdb5a89`, `b709e19`),
so provenance is checkable.

Apply check against a fresh fetch of `master`:

```
$ git apply --check --verbose tutorial-fix.diff
Checking patch _code-samples/lending-protocol/js/lendingSetup.js...
Checking patch _code-samples/lending-protocol/js/package.json...
APPLIES CLEANLY
$ git apply tutorial-fix.diff && diff lendingSetup.js <the script that ran green>
RESULT IDENTICAL TO THE SCRIPT THAT RAN GREEN ON DEVNET
```

Five hunks in `lendingSetup.js`, one in `package.json`; +46 lines, -3.

---

## 7. Toolchain forensics (supports the version claims in the PR body)

### Why the `xrpl` bump is required, and what it is *not* required for

Both `xrpl@4.6.0` and `xrpl@5.2.0` resolve `ripple-binary-codec@2.11.0` today, because the dependency
range floats. Measured in both installs:

```
FIELD VaultKind             true
FIELD SubscriptionDate      true
FIELD RedemptionDate        true
FIELD LEVersion             true
FIELD CounterpartySignature true
encodeForSigningCounterparty(tx) -> prefix 43505400   (correct)
encodeForSigning(tx)             -> prefix 53545800
```

So the **binary-codec** side of the toolchain is fixed at `ripple-binary-codec@2.11.0` (published
2026-09-11T20:56Z) and reaches a fresh `npm install` of `xrpl@4.6.0` as well. That is worth stating
precisely, because it is easy to over-attribute to `xrpl@5.2.0`.

What `xrpl@5.2.0` actually adds is the **role-aware signer**. `dist/npm/Wallet/utils.js`:

```js
// 4.6.0 — no role at all
function computeSignature(tx, privateKey, signAs) {
  ...
  return sign(encodeForSigning(tx), privateKey)          // always STX 0x53545800
}

// 5.2.0
const SIGNING_ENCODERS = {
  transaction:  { single: encodeForSigning,             multi: encodeForMultisigning },
  counterparty: { single: encodeForSigningCounterparty, multi: encodeForMultisigningCounterparty },
  sponsor:      { single: encodeForSigningSponsor,      multi: encodeForMultisigningSponsor },
}
function computeSignature(tx, privateKey, signAs, role = 'transaction') { ... }
```

`signLoanSetByCounterparty` is byte-identical in both versions; the difference is entirely in which encoder
`computeSignature` reaches for. On 4.6.0 the counterparty signature is computed over the wrong prefix, which
is why the server answers `fails local checks: Counterparty: Invalid signature.` This is the reason the
`package.json` bump belongs in the same PR as the `VaultKind` fix: without it the script fails later, at
step 6/7 instead of 5/7.

### `xrpl@5.2.0` still warns on the `LoanSet` success path

`node_modules/xrpl/dist/npm/sugar/autofill.js:225`:

```js
console.warn(`For LoanSet transaction the auto calculated Fee accounts for total number of signers the counterparty has to avoid transaction failure.`)
```

Still present in 5.2.0, so `lendingSetup.js` L266-267 still needs its `console.warn = () => {}` monkey-patch.
Finding L12's version label ("xrpl.js 5.2.0") is accurate. This PR deliberately leaves that line alone.

### The Python sample cannot be fixed yet

`_code-samples/lending-protocol/py/lending_setup.py` L270-L275:

```python
VaultCreate(
    account=loan_broker.address,
    asset=MPTCurrency(mpt_issuance_id=mpt_id),
    flags=VaultCreateFlag.TF_VAULT_PRIVATE,
    domain_id=domain_id,
),
```

Zero occurrences of `VaultKind`/`SubscriptionDate`/`RedemptionDate` in the file — the identical defect.
`requirements.txt` says `xrpl-py>=4.5.0`; latest `xrpl-py` release is `v5.1.0` (2026-08-19) and
`xrpl/models/transactions/vault_create.py` on `main` has no `vault_kind` field. `XRPLF/xrpl-py#1034`
("feat: Support LendingProtocolV1_1") is **open**, not merged, last updated 2026-09-09. So the Python
tutorial path is broken and unfixable from the docs repo today.

The Go sample (`_code-samples/lending-protocol/go/lending-setup/main.go`, `Peersyst/xrpl-go v0.1.17`) was
not evaluated.

---

## 8. Prior-art search — is this already filed?

`XRPLF/xrpl-dev-portal`, issues and PRs, open and closed:

| Query | Result |
|---|---|
| `VaultKind` | no hits |
| `lendingSetup` | no hits |
| `LoanBrokerSet` | no hits |
| `SubscriptionDate` | no hits |
| `closed-ended` | only unrelated 2018/2023 hits |
| `lending tutorial` | #3522, #3509, #3506, #3495, #3469, #3497 — all merged/closed in Jan-Feb 2026, all predating the amendment |

Org-wide (`--owner XRPLF`, issues + PRs):

```
xrpl.js#3456          open    2026-08-31  feat: Support Lending Protocol V1_1
xrpl-py#1034          open    2026-08-26  feat: Support LendingProtocolV1_1
XRPL-Standards#587    open    2026-07-21  Closed-ended Vault
XRPL-Standards#582    open    2026-07-16  XLS-65 / XLS-66: Principal-only Vault/LoanBroker accounting
rippled#7921          merged  2026-07-31  feat: Add a new closed ended vault to extend SAV
rippled#8076          merged  2026-08-21  fix: Reject open-ended vaults at LoanBrokerSet
```

**Nothing reports the code-sample breakage.** D2 is unreported and the PR is not a duplicate.

### The one thing that *is* moving: xrpl-dev-portal#3923

Open, not draft, created 2026-09-11T19:56Z, base branch `release-3.4.0` (not `master`), 11 files,
+158/-57. Every file is under `docs/`; **it does not touch `_code-samples/` at all**. Its relevant
content:

`docs/references/protocol/transactions/types/loanbrokerset.md` gains:

> A loan broker can only be attached to a _closed-ended_ vault. This restriction only applies to loan
> brokers created after the [LendingProtocolV1_1 amendment][] is enabled.

and a `tecNO_PERMISSION` row: "The transaction is creating a new `LoanBroker` and the associated vault
isn't closed-ended."

`docs/references/protocol/transactions/types/vaultcreate.md` gains full rows for `VaultKind`,
`SubscriptionDate` and `RedemptionDate`, a note that `RedemptionDate - SubscriptionDate` must be at least
180 s and less than 946 708 560 s and that both dates must be in the future relative to the parent
ledger's close time, plus a `tecEXPIRED` row and expanded `temMALFORMED`/`temDISABLED` rows.

Consequences for the feedback document are set out in the findings summary; the PR body already
frames #3923 as complementary rather than overlapping, which is the accurate and the diplomatic reading.
