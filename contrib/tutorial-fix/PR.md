# PR title

```
fix(lending): create a close-ended vault in lendingSetup.js so LoanBrokerSet succeeds
```

Alternate, if a shorter title is preferred:
`fix(lending-protocol): lendingSetup.js fails at step 5/7 under LendingProtocolV1_1`

---

# PR body — ready to paste

## Summary

`_code-samples/lending-protocol/js/lendingSetup.js` does not run to completion on Devnet. It fails at
`Setting up tutorial: 5/7` with a `TypeError`, not with a ledger result code. All six *Use the Lending
Protocol* tutorials run this script first, so all six are currently un-followable.

This PR makes the setup script create a **close-ended vault**, check engine results before indexing into
transaction metadata, wait for the vault's investment period before originating loans, and bump the pinned
`xrpl` version. Verified end to end against Devnet; details below.

## Environment

| | |
|---|---|
| Network | XRPL Devnet, `wss://s.devnet.rippletest.net:51233` |
| `rippled` | `3.4.0-rc5` (`network_id` 2) |
| Amendments | `LendingProtocol`, `LendingProtocolV1_1`, `SingleAssetVault`, `MPTokensV1`, `PermissionedDomains`, `fixCleanup3_4_0` — all `enabled: true` |
| Repo state | `master` @ `dc29bc4c895dd6268cdf1142cd7919f6dc8844b4`; `lendingSetup.js` blob `fdb5a89`, `package.json` blob `b709e19` |
| Node.js | v24.13.0 |
| Date of runs | 2026-09-12 |

## Symptom

Running the file exactly as committed, with dependencies installed from the committed `package.json`
(`"xrpl": "^4.6.0"`, which resolves to `4.6.0` today):

```
$ npm install && node lendingSetup.js
Setting up tutorial: 0/7
Setting up tutorial: 1/7
Setting up tutorial: 2/7
Setting up tutorial: 3/7
Setting up tutorial: 4/7
Setting up tutorial: 5/7
.../lendingSetup.js:260
).CreatedNode.LedgerIndex
 ^

TypeError: Cannot read properties of undefined (reading 'CreatedNode')
    at .../lendingSetup.js:260:2
```

The reader is on **step 5 of 7** and is shown a JavaScript crash. Nothing in the output names a
transaction, a result code, a vault, or an amendment.

## Root cause

Two independent problems, plus one that only becomes reachable once the first is fixed.

### 1. The vault is open-ended, and `LoanBrokerSet` now rejects open-ended vaults

`lendingSetup.js` L201-L209 creates a vault with no `VaultKind`. `VaultKind` defaults to `0` (open-ended);
`SubscriptionDate` and `RedemptionDate` appear nowhere in the file.

L242-L246 then attaches a loan broker to that vault. Since the `LendingProtocolV1_1` amendment that
transaction cannot succeed. From
[`src/libxrpl/tx/transactors/lending/LoanBrokerSet.cpp` L149-L161][src], introduced by
[XRPLF/rippled#8076][rippled-pr] ("fix: Reject open-ended vaults at LoanBrokerSet", merged 2026-08-21):

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

Note that `VaultCreate` is deliberately left unrestricted, so the vault is created happily and the failure
surfaces one transaction later, on a different transaction type.

### 2. The script indexes into metadata without checking the engine result

`submitAndWait` resolves normally for `tec*` results; it rejects only on `tem*`/`tef*`/local failures. So
when `LoanBrokerSet` returns `tecNO_PERMISSION`, execution reaches L258-L260:

```js
const loanBrokerID = loanBrokerSetResponse.result.meta.AffectedNodes.find(node =>
  node.CreatedNode?.LedgerEntryType === 'LoanBroker'
).CreatedNode.LedgerIndex
```

`.find()` returns `undefined` and the script dies on the property access. Instrumenting the unmodified file
to print results confirms the chain:

```
VaultCreate   result: tesSUCCESS       hash: ED8C771D2A2DE24B2882220B06E95DDD7A5DA93973FFCFEDC40B5433BEAE344E
LoanBrokerSet result: tecNO_PERMISSION hash: 1785DA8082AABC314B1BA925115D33E07F5B85B5D130209F890A7400F561591F
Vault on ledger: {"LedgerEntryType":"Vault"}                     <- no VaultKind field, i.e. open-ended
LoanBrokerSet AffectedNodes types: ["ModifiedNode:AccountRoot"]  <- fee only, no LoanBroker created
```

### 3. Once the broker exists, the pinned `xrpl` version cannot sign `LoanSet`

With a close-ended vault the script reaches L289, `xrpl.signLoanSetByCounterparty(...)`. On the pinned
`xrpl@4.6.0` that call signs over the ordinary transaction prefix, because `computeSignature` has no notion
of a signing role:

```js
// xrpl@4.6.0 - dist/npm/Wallet/utils.js
return sign(encodeForSigning(tx), privateKey)          // STX prefix 0x53545800
```

`rippled` with `fixCleanup3_4_0` expects the counterparty prefix `0x43505400` and rejects the blob locally
with `fails local checks: Counterparty: Invalid signature.` `xrpl@5.2.0` (published 2026-09-11) routes
counterparty signing correctly:

```js
// xrpl@5.2.0 - dist/npm/Wallet/utils.js
counterparty: { single: (tx) => encodeForSigningCounterparty(tx), ... }   // CPT prefix 0x43505400
```

The tutorial *pages* already tell readers to run `npm install xrpl` (`create-a-loan-broker.md` L48,
`create-a-loan.md` L51), which resolves to `5.2.0` today, but the code-sample directory pins `^4.6.0`.
Readers who follow the page text and readers who run `npm install` inside the sample directory currently
get different outcomes. This PR aligns them.

## The fix

`_code-samples/lending-protocol/js/lendingSetup.js`

1. Compute `SubscriptionDate` / `RedemptionDate` just before the vault is created, with comments explaining
   the constraints: dates are seconds since the Ripple Epoch, `RedemptionDate - SubscriptionDate` must be at
   least 180 s, and `RedemptionDate` must outlast the loans, which run 30 days here.
2. Add `VaultKind: 1`, `SubscriptionDate` and `RedemptionDate` to the `VaultCreate`.
3. Add a small `checkResult(response, label)` helper and call it on `VaultCreate`, `LoanBrokerSet`,
   `VaultDeposit` and both `LoanSet`s. A reader who hits a `tec` now sees
   `LoanBrokerSet failed: tecNO_PERMISSION (tx ...)` instead of a `TypeError`.
4. Poll the validated ledger's `close_time` past `SubscriptionDate` before originating loans. `LoanSet` is
   valid only during a close-ended vault's investment period and returns `tecTOO_SOON` before it; the local
   clock is not authoritative.

`_code-samples/lending-protocol/js/package.json`

5. `"xrpl": "^4.6.0"` becomes `"xrpl": "^5.2.0"`.

No tutorial prose changes are needed: the pages describe the setup script's outcome, not its vault
parameters, and they already say `npm install xrpl`.

## Verification

Three runs on Devnet, fresh faucet accounts each time.

**A. Unmodified file, `xrpl@4.6.0`** — fails at 5/7 with
`TypeError: Cannot read properties of undefined (reading 'CreatedNode')`, 43.0 s.

**B. Result check applied, vault still open-ended** — isolates fix (3) from fix (1). Same failure point, but
now a usable message:

```
Error: LoanBrokerSet failed: tecNO_PERMISSION (tx F0500DF94B5529F1065316ABFA1D36665650E5A1FC13C2C6615CBC75633E372B)
```

**C. This PR's version, `xrpl@5.2.0`** — completes in 79.6 s:

```
Setting up tutorial: 0/7 ... 7/7
Setting up tutorial: Complete!
```

All transactions `tesSUCCESS`:

| Transaction | Hash |
|---|---|
| `VaultCreate` | `C587A94699E6244BDDF8D5C15DB5F617F8E5E59F77F494CD20BD99AB94976573` |
| `LoanBrokerSet` | `2766793FB6DA13DB0B79F2836AE0122EFD6084FD2C9B7C2E40645DC36C42BF85` |
| `VaultDeposit` | `9DFABC5ED8A668F8FA9321F3DC737BEDB120C84CC035E217FBE05493FC9D2412` |
| `LoanSet` 1 | `226597F009584D7975A42A5471EC4F2F4489F71D4E17C6214E689B0E42347E37` |
| `LoanSet` 2 | `1001467F863434FE9B473F6B235A56903FCACDECAC88ECD49E9A5652FBCEEC78` |

Resulting ledger state (`ledger_entry`, validated):

```
Vault      495C9ED4E0ECA55942AB0136D0DD46B6A45218737A02391FC80190FFC45741F4
             VaultKind: 1   SubscriptionDate: 842514127   RedemptionDate: 847698127
             AssetsTotal: 50000000   AssetsAvailable: 49998000
LoanBroker 00BD46B4A49D1C5051C9FBE5C444CA880B20D89A0EB285A048C30776EDFD1EB3
             VaultID: 495C9ED4...   DebtTotal: 2000
Loan       58199B549327F2DD4FD3CA2E7A63BF1034FE087ECA319193068C9C02630DD8B1
Loan       07310F3A950A4D40FF2F8E20717047D2E7BE468ED81BEF8DEE692EA4F6F3A118
```

`lendingSetup.json` is written with all six IDs, which is what the six downstream tutorial scripts consume.

## Scope note: the Python and Go samples

`_code-samples/lending-protocol/py/lending_setup.py` has the identical defect. Its `VaultCreate`
(L270-L275) sets no `vault_kind`, and the file contains no `subscription_date` / `redemption_date`. It is
**not** fixed here, because `xrpl-py` cannot express those fields yet: the latest release is `v5.1.0` and
`xrpl/models/transactions/vault_create.py` on `main` has no `vault_kind`. Support is in flight in
[XRPLF/xrpl-py#1034][pypr] ("feat: Support LendingProtocolV1_1", open). Once that ships and
`requirements.txt` (`xrpl-py>=4.5.0`) is bumped, the same four-line change applies. Happy to follow up with
that PR, or to fold it in here if you would rather hold this one. The Go sample was not evaluated.

## Related

- [XRPLF/rippled#8076][rippled-pr] — the transactor change that introduced the gate
- XRPLF/xrpl-dev-portal#3923 — documents the closed-ended requirement on `loanbrokerset.md` and the new
  `VaultCreate` fields on `vaultcreate.md`. That PR is docs-only and does not touch `_code-samples/`, so
  this change is complementary, not overlapping.
- [XRPLF/xrpl-py#1034][pypr] — blocks the equivalent Python fix

[src]: https://github.com/XRPLF/rippled/blob/421af6db796631da4ff8b78f5d3bafae0fd3ca32/src/libxrpl/tx/transactors/lending/LoanBrokerSet.cpp#L149-L161
[rippled-pr]: https://github.com/XRPLF/rippled/pull/8076
[pypr]: https://github.com/XRPLF/xrpl-py/pull/1034
