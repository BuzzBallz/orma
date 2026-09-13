Built the closed-ended vault + lending chain on XRPL Devnet this week (rippled 3.4.0-rc4 and 3.4.0-rc5, `network_id` 2, `LendingProtocolV1_1` enabled; `xrpl` 5.2.0 / `ripple-binary-codec` 2.11.0). The phase model in this draft matches the wire behaviour I measured — the `VaultDeposit` / `VaultWithdraw` phase rejections and the `LoanSet` / `LoanAccept` gates all behaved as §2.1 says they should.

Three notes from that: one transactor that is missing, one pair of constants that does not match the server, and one clause that is short by a buffer.

---

## 1. `LoanBrokerSet` is absent from §2.1, and it is the transactor carrying a closed-ended restriction

§2.1's permission matrix enumerates eight transactors — `VaultDeposit`, `VaultWithdraw`, `VaultClawback`, `LoanSet`, `LoanAccept`, `LoanPay`, `LoanManage`, `LoanDelete` — and the paragraph below it accounts for `VaultDelete`. `LoanBrokerSet` is in neither. The string `LoanBrokerSet` occurs zero times in this draft; `LoanBroker` occurs twice, both about a `Loan` object holding a broker owner-count that blocks `LoanBrokerDelete`.

Under `LendingProtocolV1_1` a `LoanBroker` may only be attached to a **closed-ended** vault. `LoanBrokerSet` against an open-ended vault returns `tecNO_PERMISSION` even when the submitter is the vault owner. Proved by exhaustion — same accounts, same field set, only the vault kind varying:

| Submitter | Vault kind | Result | Hash |
|---|---|---|---|
| non-owner | open-ended | `tecNO_PERMISSION` | `A260515DE5C615E1A1A2E299D98FA6D652ADD75F3A2C105B7497965323FBF226` |
| non-owner | closed-ended | `tecNO_PERMISSION` | `FCF6DC50385AC1D143EC25BB5204B040A607E64EA9BCCE7D78D4F2BC5E77E70B` |
| **vault owner** | **open-ended** | **`tecNO_PERMISSION`** | `86AC8182A100EEDA32495706C06CDAC6D522B0E0772F5F65696064B6F3C0E5ED` |
| **vault owner** | **closed-ended** | **`tesSUCCESS`** | `CFC576DF9DCF7DB12059C559F93BE6F6094011820796859A1E814586C0E4AD5F` |

Row 3 is the one that isolates the vault-kind requirement from the already-documented owner requirement: the submitter *is* the vault owner, so the documented precondition is satisfied, and it still fails. Reproduced on four separate vaults across three probes (`F4646C83891785A87881DBBCB83D0B0F2F64A53FA1DD169D1E80F3185AEC9DA8`, `76E384CC9FE14628B7DE9E8739A970B05AE04B09FC29EE76B887AFF2EF211418`, `45A3264CD4B02B41458B38468DAA03BE889171764CCC9A85416D96C1DD2934CA`, `D6A3C93E0389AA705B96C59EA395228796A31DF08429C30102A5520AE6FB2306`), including with the transaction stripped to `Account` + `VaultID` to eliminate every optional field as a cause (`F4A97E9BD627DB7397AD33866C2830D286195863CDAF9EDBBC4DBE4CC696417B`), and re-proved on 3.4.0-rc5 (`9049D56423AB5E61B0D1FF157666DA6CD9DF0D504333B988EF27753597BB22D5`).

The rule is in merged code — XRPLF/rippled#8076 "fix: Reject open-ended vaults at `LoanBrokerSet`", merged 2026-08-26, `LoanBrokerSet.cpp` preclaim, create-new branch. Quoting it as evidence of the intent behind the behaviour, **not** as proposed spec text:

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

Where it is *not* written down is any specification. The published XLS-66's `LoanBrokerSet` protocol-level failure list does not contain it, and neither do the revised versions of that list proposed in #497 or #484. #582 scopes it out explicitly, in its rewritten §2.7 Amendments:

> Closed-ended Vault phase checks on `LoanSet` and the closed-ended requirement on `LoanBrokerSet` are specified in [PR #587](https://github.com/XRPLF/XRPL-Standards/pull/587), not in this patch.

So the deferral points here, and the rule is not here.

This draft already carries §7 `LoanSet (modified)` and §8 `LoanAccept (modified)` with their own protocol-level failure conditions, which makes it look like the natural home. Suggested, in the shape of §6.2.1 / §7.2.1 / §8.2.1 and of `templates/AMENDMENT_TEMPLATE.md`:

> ## N. Transaction: `LoanBrokerSet` (modified)
>
> ### N.1. Fields
>
> No changes.
>
> ### N.2. Failure Conditions
>
> #### N.2.1. Protocol-Level Failures
>
> 1. If `LoanBrokerID` is not specified (creating a new `LoanBroker`) and `Vault(VaultID).VaultKind` is not `ClosedEnded`, return `tecNO_PERMISSION`.
>
> ### N.3. State Changes
>
> No changes.
>
> ### N.4. Invariants
>
> - No `LoanBroker` is created against a `Vault` whose `VaultKind` is not `ClosedEnded`.

…plus a `LoanBrokerSet` row in §2.1. I would leave the phase columns of that row to you: what I measured is the vault-kind axis, not the phase axis — I did not test broker creation in each phase of a closed-ended vault, so I would not want to assert those four cells.

Three details worth capturing in whatever wording you land on, because they are each things a reader would otherwise get wrong:

- The constraint binds at broker creation, not at vault creation. `VaultCreate` is deliberately unrestricted, so an open-ended vault is still a legal object; it simply cannot host a broker.
- Per XRPLF/xrpl-dev-portal#3923's `loanbrokerset.md`, it binds only brokers created **after** the amendment — a broker already attached to an open-ended vault keeps originating loans. That carve-out is not derivable from black-box probing; I only have it because that PR states it.
- `VaultKind` is immutable, and `VaultSet` does not admit `VaultKind`, `SubscriptionDate` or `RedemptionDate` at all — rippled rejects the blob at deserialization, before preflight, with `invalidTransaction: Field 'VaultKind' found in disallowed location` (five field variants tested; the `{Data}`-only control succeeded, `284A6C26CD5ED2B23A32663D6201F9416131074F125DEF3F29D6E61A20A3EB67`).

That last one is what makes the missing line expensive rather than merely inconvenient. A developer working from the published documents builds an open-ended vault, issues its share MPT and takes deposits into it, and only then finds there is no conversion and no upgrade path: the vault, the issuance and every LP position have to be torn down and rebuilt.

---

## 2. §2.4's investment-period bounds do not match what Devnet accepts

§2.4 defines `MIN_INVESTMENT_PERIOD` as `60` seconds and `MAX_INVESTMENT_PERIOD` as `946080000` seconds.

On Devnet the accepted window for `RedemptionDate − SubscriptionDate` starts at **180**, not 60. I bracketed the lower bound on the wire: 179 → `temMALFORMED`, 180 → `tesSUCCESS` (`0C6127F4E9042C5EB1DD85A7274FC0748F19D9D1839256459ED5D206D9A14D06`).

I did **not** bracket the upper bound on the wire, so that half is second-hand: `xrpl-py` 5.2.0b0 enforces the window as `[180, 946708560)` — it raises

```
XRPLModelException {"redemption_date": "redemption_date - subscription_date must be within [180, 946708560) seconds."}
```

and its `MIN_INVESTMENT_PERIOD` / `MAX_INVESTMENT_PERIOD` docstrings cite rippled's `kMinInvestmentPeriod`. XRPLF/xrpl-dev-portal#3923's `vaultcreate.md` documents the same `[180, 946708560)` window.

So both constants in the draft differ from the ones being enforced and documented elsewhere. The upper-bound gap is 628,560 s, which is exactly `30 × (31556952 − 31536000)` — 30 mean Gregorian years against 30 × 365 days — so the two values may simply have been derived from different year lengths. (For what it is worth, XLS-66's interest arithmetic implies a 31,536,000-second year: a 10,000,000-drop loan at `InterestRate: 100000`, `PaymentInterval: 28251` produced `PeriodicPayment 3339307.338128906896`, which the annuity formula reproduces to 10 significant figures only with a 31,536,000 s year — `8DE13240603C8787A739BC3EE47F0392937C37B942EAEB3A91D7DF47038F63D5`. If both constants are deliberate then the family of documents is using two different year lengths, which is worth saying out loud somewhere.)

I have no view on which side should move. As the draft stands, anyone who builds client-side validation from §2.4 will accept a 60-second investment period and then take a `temMALFORMED` from the server, which is a confusing place to learn the real bound.

---

## 3. §7.2.1 condition 3 and §7.4's second invariant are short by a buffer

§7.2.1 reads:

> 3. If `startDate + (paymentInterval × paymentTotal)` is not strictly before `RedemptionDate`, return `tecNO_PERMISSION`.

and §7.4 restates it: *"No closed-ended `LoanSet` succeeds unless the loan's final scheduled payment is strictly before `RedemptionDate`."*

The implementation requires a margin beyond that. I ran 20 `LoanSet` submissions across two fresh closed-ended vaults on 3.4.0-rc5, varying `PaymentInterval` against a fixed `RedemptionDate` and reading the true slack `k = RedemptionDate − (StartDate + PaymentInterval × PaymentTotal)` back off each validated result rather than predicting it:

- **Rejected** with `tecNO_PERMISSION` at k = 47, 51, 53, 56, 57, 59, 62 and 68 s.
- **Accepted** at k = 66, 72, 80, 83 and 198 s.

k = 57 and k = 59 are strictly before `RedemptionDate` and are rejected (`2F9B898DE63BDDA3C4B57AAE97EC31217A8DC09223BED9D1386265D606250521`, `66A3CC2C3331E9CBFCEF0E63BC314F1B2FFFCBECA17A95133776AA43FCDBD618`), so the rule as written is not the rule being applied. A buffer of roughly 60 s exists.

I stop short of asserting the constant is exactly 60. The transactor evaluates against the parent ledger's close time while my `StartDate` proxy is the applying ledger's, and Devnet's `close_time_resolution` is 10 s — the same order as the effect, which is why one probe at k = 68 was rejected while one at k = 66 succeeded (`87692E38C46EA2D16CD2EB8723DFCC895B5EBC47BA7396E263320A4A5F6FC99A`). So: approximately 60 s from my data, and the exact value is whoever owns `LoanSet.cpp`'s to state.

XRPLF/xrpl-dev-portal#3923 already writes it the second way, on `loanset.md`: *"only if the loan's final scheduled payment is at least 60 seconds before the vault enters its Redemption phase"*, with a matching `tecNO_PERMISSION` row and the observation that the maximum term of new loans shrinks as a vault approaches its `RedemptionDate`.

Suggested: name the buffer as a protocol constant in §2.4 alongside the investment-period bounds, and change both §7.2.1 condition 3 and §7.4's second invariant from "strictly before `RedemptionDate`" to "at least that constant before `RedemptionDate`". It is a small change now and a behavioural surprise later: the failure mode is an unexplained `tecNO_PERMISSION` on a loan the spec says is legal, which took me some hours to attribute correctly.

---

Happy to run further probes on Devnet to settle note 2 or note 3, and to supply the full transaction set behind any of these.

Found while building on the Lending Protocol for the De Vinci Blockchain XRPL Lending Protocol Hackathon (12–13 September 2026).
