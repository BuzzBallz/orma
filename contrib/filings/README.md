# Upstream filings

## Filed

| What | Where | When |
|---|---|---|
| Issue: impairing a healthy vault emits an empty `PreviousFields` | [XRPLF/rippled#8222](https://github.com/XRPLF/rippled/issues/8222) | 2026-09-13 |
| Courtesy comment crediting the prior report | [XRPLF/rippled#6487](https://github.com/XRPLF/rippled/issues/6487#issuecomment-5655575723) | 2026-09-13 |

Evidence was re-verified against live Devnet immediately before filing: both cited transactions
still validate, vault `864C5A2D` still carries `LossUnrealized`, vault `4A5A8E37` still has no such
field, and the network is still on 3.4.0-rc5.

## Not filed yet

## PR: the lending tutorial setup script

**Verdict:** `do-not-file`

The defect is still real, but the PR as drafted is now largely a duplicate of an open maintainer PR, and its body contains a claim that is demonstrably false as of this morning.

TECHNICAL FINDING: STILL VALID.
- `_code-samples/lending-protocol/js/lendingSetup.js` still exists at that exact path on `master` (default branch) and on `release-3.4.0`.
- Its blob is `fdb5a89cc20b8b2932bec5d0141859744ac77e6c`, byte-identical to the pin in PR.md (`fdb5a89`) and to both local copies (`contrib/tutorial-fix/upstream/lendingSetup.js` and `scripts/lendingSetup.BEFORE.js` both hash to `fdb5a89cc20b...`). `package.json` blob `b709e194662c5986da3d4c0095aff15655f65b14` also matches the pinned `b709e19`. The file has not been touched since commit `a83e6e3a1` on 2026-02-25. The diff applies cleanly and every cited line number is correct.
- Every cross-repo citation in PR.md verifies: XRPLF/rippled#8076 is MERGED (2026-08-26) with merge commit `421af6db796631da4ff8b78f5d3bafae0fd3ca32`, and the quoted `tecNO_PERMISSION` block sits at exactly L149-L161 of `LoanBrokerSet.cpp` at that SHA. XRPLF/xrpl-py#1034 is still OPEN, and xrpl-py's latest release is still v5.1.0.

THE BLOCKER: XRPLF/xrpl-dev-portal#3923 now fixes this.
PR #3923 ("Migrate LendingProtocolV1_1 docs from opensource", author `oeggert`, base `release-3.4.0`, head `lending-1.1-updates`) was docs-only when the draft was written on 2026-09-12. Commit `aad9fc91c` "update lending protocol code samples", pushed 2026-09-13T01:47:53Z — roughly thirteen hours after the draft was finalised — added `_code-samples/lending-protocol/js/lendingSetup.js` (+32-6) and `_code-samples/lending-protocol/js/package.json` (+1-1) to it. A further commit `798ac47fc` landed at 03:14:43Z. The PR is open, unreviewed, and has no comments.

Overlap, fix by fix against the draft's own numbered list:
- Fix 1+2 (SubscriptionDate/RedemptionDate, `VaultKind: 1`): DUPLICATE. #3923 adds the identical three fields to the same `VaultCreate` call at the same location. Its derivation is arguably better than the draft's — it anchors to `latestLedger.result.ledger.close_time + 30` rather than computing from the local clock via a hardcoded `RIPPLE_EPOCH_OFFSET`, which is precisely the caution the draft itself raises in its own fix 4.
- Fix 4 (wait for the investment phase before `LoanSet`): DUPLICATE. #3923 adds both a countdown loop and a `close_time > subscriptionDate` poll before the `createLoan` calls — the same mechanism, with a progress indicator.
- Fix 5 (bump `xrpl`): DUPLICATE, and #3923 pins exact `"5.2.0"` rather than the draft's `"^5.2.0"`. A range would likely be asked to change in review anyway.
- Fix 3 (the `checkResult()` engine-result guard): NOT duplicated. This is the only surviving original contribution. #3923 fixes the cause of the crash but leaves the unchecked `.find(...).CreatedNode` indexing in place, so the next `tec` result still produces a `TypeError` rather than a result code.

Filing the PR as drafted would land a ~90%-duplicate change on the desk of the maintainer who wrote the thing it duplicates, carrying a sentence asserting that his PR "is docs-only and does not touch `_code-samples/`". That is the exact failure mode the brief warns about.

NO DUPLICATE ISSUE, but one adjacent one. No open or closed issue describes this failure; searches for lendingSetup, lending, LoanBroker, vault and CreatedNode return nothing on point. Issue #3789 ("Update code samples to remove transaction submission anti-patterns", open, by `mDuo13`, 2026-07-20) is the natural home for the surviving `checkResult` work: it is a maintainer-authored register of samples that mishandle submission results, it already lists near-identical cases (`nft-modular-tutorials/transfer-nfts.js` "correctly uses `submitAndWait` ... but looks for the `engine_result` field"), and `lendingSetup.js` is not yet on its list.

**Recommended form**

Do not open the PR. Retarget the work as two small, non-duplicative contributions. Both are the human's call to make; nothing has been created, commented on or pushed.

1. PRIMARY — comment on XRPLF/xrpl-dev-portal#3923 rather than competing with it.
   This is where the value is. #3923 is unreviewed and its code-sample commits are 24 hours old, so a substantive, evidence-backed comment now is timely and welcome rather than redundant. Lead by confirming his fix independently — the team reproduced the `tecNO_PERMISSION` failure and validated the same close-ended parameters end to end on Devnet, which is verification he has not got from anyone else. Then make the one point he has not covered: `lendingSetup.js` still indexes into `meta.AffectedNodes` without checking `meta.TransactionResult`, at the post-#3923 equivalents of L260 and L296, so the next `tec` on that path still surfaces as `TypeError: Cannot read properties of undefined (reading 'CreatedNode')` instead of a result code. Offer the `checkResult()` helper as a suggested addition to his branch. Supporting evidence to include, all from RUN-LOG.md / register.md and all re-verified against upstream today:
     - Run B from the draft, which isolates exactly this: with the result check applied but the vault still open-ended, the failure becomes `Error: LoanBrokerSet failed: tecNO_PERMISSION (tx F0500DF94B5529F1065316ABFA1D36665650E5A1FC13C2C6615CBC75633E372B)` instead of a crash. That is a clean before/after for the one change he is missing.
     - The instrumented chain: VaultCreate `tesSUCCESS` (`ED8C771D...`), LoanBrokerSet `tecNO_PERMISSION` (`1785DA80...`), LoanBrokerSet AffectedNodes `["ModifiedNode:AccountRoot"]` — fee only, no LoanBroker created.
   Keep it short and drop everything that duplicates his diff. Do not restate the VaultKind/SubscriptionDate/RedemptionDate fix, the investment-phase wait, or the xrpl bump as proposals — acknowledge them as already handled.

2. SECONDARY — comment on XRPLF/xrpl-dev-portal#3789 (mDuo13's anti-pattern register).
   Add `_code-samples/lending-protocol/js/lendingSetup.js` to his table as a new instance, described in his own terms: uses `submitAndWait` correctly but never reads `meta.TransactionResult`, then indexes into `AffectedNodes` on the assumption of success, so a `tec` becomes a `TypeError`. Note the same shape recurs in `_code-samples/lending-protocol/py/lending_setup.py`. This is a genuinely new entry on a list a maintainer is actively curating, it costs him nothing to accept, and it is the durable record if #3923 merges without the guard.

3. ONLY IF #3923 MERGES WITHOUT THE GUARD — then, and only then, a tiny PR.
   Scope it to the `checkResult()` helper and its five call sites, nothing else. Base it on whatever branch #3923 landed on (`release-3.4.0` today, master once it flows through). Wrap the long lines to 80 columns. Pre-empt the `.claude/rules/code-guide.md` "prefer built-in helpers" line by noting that xrpl.js exposes no result-asserting helper, which is why the sample needs three lines of its own.

CORRECTIONS TO PR.md IF ANY OF IT IS REUSED VERBATIM: see corrections_needed. The Python scope note, the rippled #8076 citation, the LoanBrokerSet.cpp permalink and line range, and the xrpl-py #1034 blocker are all accurate and can be reused as-is.

---

## Issue/PR: the eleventh failure condition in XLS-66

**Verdict:** `file-with-changes`

The gap is real and verified on today's `master`: XLS-66 §3.3.3.2 enumerates exactly ten protocol-level failure conditions for `LoanBrokerSet` and the closed-ended requirement is not among them. The whole file mentions `VaultKind`, `SubscriptionDate`, `RedemptionDate`, `LEVersion`, "closed-ended" and `LendingProtocolV1_1` **zero times each**, so it is not merely missing from the list — the amendment does not exist in the published XLS-66 at all. No issue or PR anywhere in XRPLF/XRPL-Standards raises this gap.

But the filing form in docs/31-TASKS-FEEDBACK.md task F4 — a competing PR against `master` that inserts a new condition 3 and renumbers 3→4 … 10→11 — must not be opened as drafted. Three independent reasons, each verified against live diffs:

1. **The list is being renumbered by two other open PRs right now.** #497 (Tapanito, updated 2026-09-11) deletes old condition 8 and renumbers 9→8, 10→9, leaving §3.3.3.2 with **nine** conditions. #484 (Tapanito, updated 2026-09-09) moves the whole section to **§3.3.4.2**, adds a create-branch condition 6, and restarts numbering per block (create 1–6, modify 1–6, precision 1). The F4 diff conflicts textually with both and its "there is an eleventh" framing is stale the moment either merges. This is precisely the "cites a line number that has moved" failure the brief warns about.

2. **The parent README is the wrong host for amendment-gated behaviour under this repo's current house style.** `fixCleanup3_4_0` is specified in `XLS-0066-lending-protocol/66.2/README.md` (already merged on master), which patches parent checks by reference — "a new overdue-only impair check is added as parent check 9". #582 follows the same pattern with a new `66.1/README.md` for `LendingProtocolV1_1`. An inline `**LendingProtocolV1_1:**` bullet in the parent README has nothing to hang on, because the parent README's §2.7 Amendments does not list `LendingProtocolV1_1` at all.

3. **#587 already has the right structural slot.** It is not a vault-only document: it contains `## 7. Transaction: LoanSet (modified)` and `## 8. Transaction: LoanAccept (modified)`, with real protocol-level failure conditions in each. Its §2.1 Permission Matrix lists eight transactors — `VaultDeposit`, `VaultWithdraw`, `VaultClawback`, `LoanSet`, `LoanAccept`, `LoanPay`, `LoanManage`, `LoanDelete` — and `LoanBrokerSet` is the **only lending transactor absent from it**. That omission is the cleanest possible hook for the finding, and a `Transaction: LoanBrokerSet (modified)` section there needs no renumbering of XLS-66 at all, so it collides with neither #497 nor #484.

So: file the substance, change the vehicle. One comment on #587, one short cross-reference comment on #582. No new PR, no new issue.

**Recommended form**

**Post one substantive comment on PR #587, and one two-line cross-reference comment on PR #582. Do not open the F4 PR. Do not open an issue.**

**Why #587 and not a PR against `master`:** #587 is the document that both #582's line 124 and the whole review thread treat as the home of closed-ended semantics, and the deferral in #582 makes it *formally* the place this rule is promised to live. It is not a vault-only spec — §7 and §8 already specify modified failure conditions for `LoanSet` and `LoanAccept`, so a `Transaction: LoanBrokerSet (modified)` section is a structural fit, not an intrusion. Putting it there requires **no renumbering of XLS-66 §3.3.3.2**, so it cannot conflict with #497 or #484, both of which are rewriting that list this week. And #587 is under live maintainer review with an approval already recorded, so the comment reaches a1q123456, Tapanito and gregtatcam — the three people who can act — rather than sitting in a competing PR queue behind two of Tapanito's own.

**Why not an issue:** an issue would be filed against a spec that two open PRs are actively restructuring, and it would have to be re-litigated once #497 or #484 lands. A comment on the PR that owns the missing rule is actionable today and self-obsoletes correctly.

**Why not a comment on #582 alone:** #582 explicitly scopes this rule out. A comment there cannot ask it back in; it can only point at the dangling deferral. Hence the short cross-reference.

---

**Comment to post on #587 (rewritten; supersedes the F5 draft for #587):**

> Built on the closed-ended vault + lending chain on Devnet this week (rippled 3.4.0-rc4/rc5, `network_id` 2, `LendingProtocolV1_1` enabled). The phase model in this draft matches the wire behaviour I measured. Two notes, one gap and one numeric discrepancy.
>
> **1. `LoanBrokerSet` is the only lending transactor missing from §2.1, and it is the one with a closed-ended restriction.**
>
> Under `LendingProtocolV1_1` a `LoanBroker` can only be attached to a **closed-ended** vault. `LoanBrokerSet` against an open-ended vault returns `tecNO_PERMISSION` even when the submitter is the vault owner. Proved by exhaustion — same accounts, same field set, only the vault kind varying:
>
> | Submitter | Vault kind | Result | Hash |
> |---|---|---|---|
> | non-owner | open-ended | `tecNO_PERMISSION` | `A260515DE5C615E1A1A2E299D98FA6D652ADD75F3A2C105B7497965323FBF226` |
> | non-owner | closed-ended | `tecNO_PERMISSION` | `FCF6DC50385AC1D143EC25BB5204B040A607E64EA9BCCE7D78D4F2BC5E77E70B` |
> | **vault owner** | **open-ended** | **`tecNO_PERMISSION`** | `86AC8182A100EEDA32495706C06CDAC6D522B0E0772F5F65696064B6F3C0E5ED` |
> | **vault owner** | **closed-ended** | **`tesSUCCESS`** | `CFC576DF9DCF7DB12059C559F93BE6F6094011820796859A1E814586C0E4AD5F` |
>
> Row 3 isolates the vault-kind requirement from the documented owner requirement. Reproduced on four separate vaults, including with the transaction stripped to `Account` + `VaultID` (`F4A97E9BD627DB7397AD33866C2830D286195863CDAF9EDBBC4DBE4CC696417B`) to rule out every optional field, and re-proved on 3.4.0-rc5 (`9049D56423AB5E61B0D1FF157666DA6CD9DF0D504333B988EF27753597BB22D5`).
>
> The rule is enforced in merged code — `LoanBrokerSet.cpp` preclaim, create-new branch, from XRPLF/rippled#8076:
>
> ```cpp
> // LP V1.1: only closed-ended vaults may host a loan broker. The
> // lending protocol relies on the closed-ended Subscription /
> // Investment / Redemption phase structure; attaching a broker to
> // an open-ended vault has no well-defined lifecycle. VaultCreate
> // stays unrestricted so existing open-ended flows keep working;
> // the constraint is enforced here, at the point where the vault
> // is first bound to the lending protocol.
> if (ctx.view.rules().enabled(featureLendingProtocolV1_1) &&
>     getVaultKind(sleVault) != VaultKind::ClosedEnded)
> {
>     JLOG(ctx.j.warn()) << "LoanBroker requires a closed-ended Vault.";
>     return tecNO_PERMISSION;
> }
> ```
>
> It is specified nowhere. Published XLS-66 §3.3.3.2 lists ten protocol-level failure conditions for `LoanBrokerSet` and this is not among them; #582 scopes it out explicitly at its §2.7 — *"the closed-ended requirement on `LoanBrokerSet` [is] specified in PR #587, not in this patch"* — and this draft contains the string `LoanBrokerSet` zero times. So the two in-flight PRs defer to each other and neither states it.
>
> This draft already carries §7 `LoanSet (modified)` and §8 `LoanAccept (modified)`, so it seems like the natural home. Suggested, as a new section alongside those, and as a row in the §2.1 matrix:
>
> > **Transaction: `LoanBrokerSet` (modified)** — Protocol-Level Failures: if `LoanBrokerID` is absent (creating a new `LoanBroker`) and `Vault(VaultID).VaultKind` is not `ClosedEnded`, return `tecNO_PERMISSION`.
>
> Two nuances worth capturing in the wording. `VaultCreate` is deliberately unrestricted, so the constraint binds only at broker creation; and per XRPLF/xrpl-dev-portal#3923 it binds only brokers created *after* the amendment, so a broker already attached to an open-ended vault keeps originating loans. Also, `VaultKind` is immutable and `VaultSet` rejects it at deserialization before preflight (`invalidTransaction: Field 'VaultKind' found in disallowed location`), so a developer who guesses wrong has no upgrade path — the vault, its share MPT and every LP position have to be torn down. That is what makes the missing line expensive rather than merely inconvenient.
>
> **2. §2.4's investment-period bounds do not match the implementation.**
>
> §2.4 gives `MIN_INVESTMENT_PERIOD` = 60 s and `MAX_INVESTMENT_PERIOD` = 946080000 s. On Devnet I measured the accepted window for `RedemptionDate − SubscriptionDate` as exactly **[180, 946708560)** seconds: 179 → `temMALFORMED`, 180 → `tesSUCCESS` (`0C6127F4E9042C5EB1DD85A7274FC0748F19D9D1839256459ED5D206D9A14D06`). `xrpl-py` 5.2.0b0 independently encodes the same window — it raises `{"redemption_date": "redemption_date - subscription_date must be within [180, 946708560) seconds."}` and its `MIN_INVESTMENT_PERIOD` / `MAX_INVESTMENT_PERIOD` docstrings cite rippled's `kMinInvestmentPeriod`. Both bounds in the draft look off by a factor of 3 and by 628,560 s respectively.
>
> **3. A question, not a claim.** §7.2.1 condition 3 requires `startDate + (paymentInterval × paymentTotal)` strictly before `RedemptionDate`. `LoanSet.cpp` appears to apply an additional 60 s `kLoanRedemptionBuffer`, which would make a loan maturing 1–59 s before `RedemptionDate` legal by this draft and rejected by the implementation. I did not bracket that window, so treat it as a question rather than a finding.
>
> Found while building on the Lending Protocol for the De Vinci Blockchain XRPL Lending Protocol Hackathon (12–13 September 2026).

**Comment to post on #582 (add to the existing F5 cash-basis comment, or post separately):**

> Small cross-reference on §2.7: the line *"the closed-ended requirement on `LoanBrokerSet` [is] specified in [PR #587], not in this patch"* currently points at a document that contains the string `LoanBrokerSet` zero times — #587 specifies `VaultDeposit`, `VaultWithdraw`, `LoanSet` and `LoanAccept`, but not broker creation. I've raised it on #587 with the Devnet evidence. Flagging here only so the deferral doesn't get merged pointing at a gap.

**Ordering:** post the #582 cash-basis comment first (F5 item 2, unchanged — I verified its premise holds and #582 is still open and untouched in §3.3.3.2), then the #587 comment, then the #582 cross-reference. Budget is F-2's 20 minutes; dropping the F4 PR frees the other 20.

### Ready: comment on `XRPLF/XRPL-Standards` — about 10 min

**Title:** Comment on PR #587 (Closed-ended Vault): the missing LoanBrokerSet restriction, the §2.4 investment-period constants, and the §7.2.1 maturity buffer

**Body:** `contrib/filings/spec-11th.md`

**Before you run it**

- DROP task F4. Do not fork, do not branch, do not open a PR against master XLS-66 §3.3.3.2 — #497 rewrites that list to nine conditions and #484 renumbers the section to §3.3.4.2, so the F4 diff would conflict with two open PRs by the section's own maintainer. Nothing needs to be forked, branched or applied for this filing; it is a comment.
- Fix feedback/register.md line ~205 before the appendix ships. It says PR #587 'is a complete, correct specification of the phase model, the MIN_INVESTMENT_PERIOD bounds, and the LoanSet phase gate. It matches everything we observed on the wire.' Note 2 of this comment says the opposite about the bounds (#587 §2.4 says 60 / 946080000; the wire and xrpl-py say 180 / 946708560, register lines 1151 and 1174), and note 3 says the opposite about §7 (register D9, line ~1763). Shipping both unchanged is a self-contradiction a maintainer-juror can find in one grep.
- Post the F5 cash-basis comment on #582 first (unchanged from docs/31-TASKS-FEEDBACK.md F5; its premise re-verified — #582 is still OPEN, last updated 2026-09-11T21:07:45Z, and still does not touch §3.3.3.2).
- Then post this comment on #587.
- Then post the cross-reference on #582, written to C:/Users/Utilisateur/Documents/Coding/XRPL_Hackathon_2026/contrib/filings/582-crossref-loanbrokerset.md — either as its own comment (gh pr comment 582 --repo XRPLF/XRPL-Standards --body-file "C:/Users/Utilisateur/Documents/Coding/XRPL_Hackathon_2026/contrib/filings/582-crossref-loanbrokerset.md") or appended to the cash-basis comment. It must go after this one so 'I have raised it on #587' is true when it lands.
- The F5 comment on #625 (CoverRateMinimum units) is unaffected and can go at any time; #625 touches only the §3.3.1 fields table.
- Optional, 2 minutes: skim XRPLF/XRPL-Standards#634 'XLS-66: specify the counterparty signing prefixes' (hliosone, +11/−0 on XLS-0066-lending-protocol/README.md, updated 2026-09-13T09:46:56Z — today). It does not touch anything in this comment, but another team is filing XLS-66 corrections right now and it may collide with register findings on counterparty signing prefixes.

```bash
gh pr comment 587 --repo XRPLF/XRPL-Standards --body-file "C:/Users/Utilisateur/Documents/Coding/XRPL_Hackathon_2026/contrib/filings/587-loanbrokerset-closed-ended.md"
```

**Risk:** If the 60 s / 946080000 s constants in §2.4 are the intended values and rippled's 180 s floor is the side that is wrong, note 2 reads as a correction aimed at the wrong document — though it is written as a disagreement between draft and server rather than as a claim about which is right, and the hashes and the `xrpl-py` error string stand either way.

---

## Comment: reopening rippled#6487 with the arithmetic

**Verdict:** `file-with-changes`

The behaviour is real, unfixed, and reproduces six months later — but two things in the plan are wrong and both would be visible to the maintainers judging this event. First, the vehicle: #6487 was closed by its own author 3 minutes 17 seconds after it was opened, with no label, no maintainer participation and no cross-reference. A comment there enters no triage queue and notifies essentially one person who has not been active in XRPLF since March 2026. Second, and more serious, the central ask — "document it, one paragraph, this costs nothing" — is already in the docs. XRPLF/xrpl-dev-portal docs/references/protocol/transactions/metadata.md has stated the rule for years in the ModifiedNode field table. Filing "this is undocumented" at maintainers who wrote that sentence is the exact failure mode the brief warns about. The finding survives, but as a discoverability-and-accuracy finding against specific pages, not as a missing-paragraph finding, and the stated mechanism ("PreviousFields omits any field whose previous value equalled the type default") is falsified by the team's own capture and by rippled's source.

**Recommended form**

Do not make a comment on #6487 the deliverable. Split into two filings plus one courtesy line.

PRIMARY — a NEW issue on XRPLF/rippled, not a comment. Reasons, all verified: #6487 is closed with state_reason "completed" and carries no label, so it is in no triage view; its timeline shows zero cross-references in six months, so nobody is watching it; the repository has moved from #6487 to #8178 in that period, roughly 1,700 items, so a comment on a dead March thread is invisible; and the ask has changed — #6487 asked for a rippled behaviour change ("PreviousFields should be filled in metadata"), whereas the surviving ask is mostly documentation. Open the new issue with a first line that links #6487 explicitly ("Previously reported as #6487 and self-closed by the reporter within three minutes; no maintainer triaged it. Re-opening the ground with impact data and a narrower ask."). That link makes GitHub post a cross-reference event on #6487 automatically, which pulls zgrguric and any watcher in for free — continuity without depending on a dead thread for reach.

Follow the repo's bug template (.github/ISSUE_TEMPLATE/bug_report.md): sections Issue Description / Steps to Reproduce / Expected Result / Actual Result / Environment / Supporting Files, and the title convention "[short description] (Version: [xrpld version])". Note the daemon is now called xrpld in this repo (renamed across docs in June 2026, commit b0048e84); the planned title and body both say "rippled". Suggested title: "Lending: impairing a healthy vault produces a Vault ModifiedNode with no field-level previous values (Version: 3.4.0-rc5)". Frame it as observability, and state up front that you understand it is working as designed and are not asking for a metadata-format change as the primary remedy — that is what defuses a second "Not a bug".

SECONDARY, and probably the higher-value of the two — an issue or PR on XRPLF/xrpl-dev-portal. Because the general rule is already documented, the ask must be narrowed to three concrete, checkable page defects rather than "add a paragraph": (a) docs/references/protocol/ledger-data/ledger-entry-types/vault.md marks `LossUnrealized` Required = Yes and its example JSON shows `"LossUnrealized": "0"`, but the field is absent from a healthy Vault on the ledger — corroborated independently by the 3.1.1 metadata pasted in rippled#6500, where the Vault FinalFields carry no LossUnrealized; (b) docs/references/protocol/transactions/types/loanmanage.md never mentions that tfLoanImpair writes LossUnrealized on the Vault, or that this is the only change it makes — the word LossUnrealized does not appear on the page; (c) neither page links to metadata.md's existing PreviousFields sentence, and that sentence states the rule without stating the inference developers actually draw from it. Offer the wording as an addition to the existing row, not as a replacement, and quote the existing sentence back so it is obvious you read it. The team already has a tutorial PR in flight, so a docs PR is cheap; #2587 is the precedent that this shape of change gets merged.

COURTESY — one short comment on #6487 pointing at the new issue, addressed to zgrguric, saying you hit the same thing on 3.4.0-rc5 and that his instinct was right that it is not a bug, and that the new issue asks for documentation rather than a behaviour change. Two sentences. It costs nothing, it is good manners toward a fellow indexer author who is also an XRPLF contributor, and it is the only thing in this plan that should actually land on a closed issue.

Value ranking if time runs out: the dev-portal filing first (concrete, verifiable, mergeable, and the vault.md Required = Yes discrepancy is a genuinely new finding neither #6487 nor #2199 had), the rippled issue second, the courtesy comment last.

### Ready: issue on `XRPLF/rippled` — about 10 min

**Title:** Lending: impairing a healthy vault emits an empty PreviousFields on the Vault node (Version: 3.4.0-rc5)

**Body:** `contrib/filings/rippled-6487.md`

**Before you run it**

- No fork, branch or patch is needed. XRPLF/rippled is public, gh is already authenticated as frytegg, and contrib/tutorial-fix/tutorial-fix.diff is unrelated to this filing.
- Re-run the two Supporting Files commands for tx 075FE6D2... and for vault 4A5A8E37... immediately before filing. I verified both at 2026-09-13 and they returned validated:true and a Vault with no LossUnrealized key, but a Devnet reset invalidates the whole body. If either returns txnNotFound or entryNotFound, do not file until the captures are redone.
- Correct the mechanism sentence in four places before or immediately after filing, because the issue now states the corrected rule and a maintainer following the project's public repo must not find it contradicted: feedback/register.md section 5 'Why' ('rippled omits from PreviousFields any field whose previous value equalled the type default'), docs/31-TASKS-FEEDBACK.md F6a '## Why', src/demo/capture-impair.mjs:11-12, and src/xrpl.mjs:6-7. The correct rule is presence, not value: a field absent from the object before the transaction has no previous value to record, which is why the same transaction records the Loan's previous Flags of 0.
- Also fix CLAUDE.md section 4, which states the same wrong mechanism ('PreviousFields omits any field whose previous value was 0').
- Delete the unverified sentence 'The same rule also hides the first non-zero DebtTotal, the first CoverAvailable, the first AssetsTotal' from feedback/register.md section 5 and from the F6a draft. rippled#6500's 3.1.1 metadata shows AssetsTotal present in a Vault's PreviousFields, so the claim is wrong as written. It is already absent from the filing.
- Remove the narration of zgrguric's state of mind from feedback/register.md section 5 ('filed it away as his own misunderstanding', 'He was half right'). He is an active XRPLF contributor, the new issue's reference to #6487 will post a cross-reference event that notifies him, and the register is a public deliverable.
- Decide separately on the two companion filings, neither of which this command covers: the xrpl-dev-portal PR for the three page defects (read https://xrpl.org/resources/contribute-documentation/ first; that repo has no issue template and its CONTRIBUTING.md is a one-line redirect), and the two-sentence courtesy comment on #6487 pointing at the new issue. File the new issue first so the courtesy comment has a URL to point at.

```bash
gh issue create --repo XRPLF/rippled --title "Lending: impairing a healthy vault emits an empty PreviousFields on the Vault node (Version: 3.4.0-rc5)" --body-file "C:/Users/Utilisateur/Documents/Coding/XRPL_Hackathon_2026/contrib/filings/rippled-vault-previousfields.md"
```

**Risk:** If Devnet resets between now and filing, every transaction hash and vault ID in the body goes dead and the issue reads exactly like #6487 did — an unreproducible report with a broken link — which is the one failure mode a maintainer on the jury would remember.

---

## Issues: the SDK and docs findings worth filing

**Verdict:** `file-with-changes`

Verified all three candidates read-only against live XRPLF repositories (no writes of any kind were made). The batch as framed does not survive: of the three, one is an exact duplicate of an open issue, one is factually wrong in two places and would be filed against behaviour a maintainer already declared expected, and one is not a library finding at all and is already being fixed in an open PR. Two genuinely new, unfiled, source-verified library-level defects surfaced during verification and are worth filing in their place.

CANDIDATE 1 — xrpl.js caps oracle Scale at 0-10 while the protocol allows 20. VERDICT: DO-NOT-FILE as an issue; comment on XRPLF/xrpl.js#3435 instead.
Owner: XRPLF/xrpl.js. Still live, not fixed: packages/xrpl/src/models/transactions/oracleSet.ts on `main` still has `const SCALE_MAX = 10` (line 17), enforced at lines 183-186. rippled develop has `constexpr std::size_t kMaxPriceScale = 20` (include/xrpl/protocol/Protocol.h:440), so the mismatch is real. But XRPLF/xrpl.js#3435 "OracleSet validation rejects valid Scale values 11-20 (SCALE_MAX should be 20, not 10)" is OPEN since 2026-08-12, unlabelled, with zero comments, and its body already cites XLS-47, rippled's kMaxPriceScale, mainnet oracles with Scale 15/16, and the same 11/20/21 boundary the team reproduced. A new issue is a pure duplicate. The register already reached this conclusion and it is correct.

Two things did come out of verifying it that ARE fileable:

1a. FILE — XRPLF/xrpl-dev-portal: the docs are the root cause of #3435 and nobody has filed it.
Two pages on `master` state the wrong range: docs/references/protocol/transactions/types/oracleset.md, PriceData field table, "Valid scale ranges are 0-10"; and docs/references/protocol/ledger-data/ledger-entry-types/oracle.md line 61, same sentence. Both contradict XLS-0047-PriceOracles/README.md ("Valid `Scale` range is {0-20}", and separately "{1-20}" in the transaction section) and rippled's kMaxPriceScale = 20. Searched xrpl-dev-portal issues for oracle and for scale: nothing filed, no open PR touching it. This is a one-line fix on the repository that plausibly seeded the wrong constant in xrpl.js, it is not in feedback/register.md, and it pairs cleanly with a cross-link comment on #3435.

1b. FILE — XRPLF/xrpl.js: the U4 "layer contradiction" (Scale 0 is unreachable through the client). This is distinct from #3435 and unfiled.
Verified both ends in source. rippled declares the inner-object field as `{sfScale, SoeDefault}` (src/libxrpl/protocol/InnerObjectFormats.cpp:130), which is why an explicit `Scale: 0` is rejected at local check with `Field 'Scale' may not be explicitly set to default.` — the team's captured error string. XLS-47 agrees and states the intended encoding: "The `Scale` field should be omitted when the `Scale` value is 0. An omitted `Scale` field implies a value of 0." But xrpl.js oracleSet.ts lines 143-149 throw `OracleSet: PriceDataSeries must have both AssetPrice and Scale if any are present`, so the spec-mandated encoding of Scale 0 cannot be sent through validate()/Wallet.sign/submitAndWait. Searched xrpl.js issues for OracleSet, Scale, AssetPrice: only #3435 (range) and #2911 (AssetPrice string type, closed 2025-03-19, unrelated). Nothing covers this.

CANDIDATE 2 — OracleSet retains omitted PriceData pairs, a reused document id fills with stale pairs until tecARRAY_TOO_LARGE, and only delete-and-recreate recovers. VERDICT: DO-NOT-FILE. This is the single riskiest item in the set.
Two load-bearing claims in the team's material are false against the live repositories.
(a) "Undocumented." It is documented in full. docs/references/protocol/transactions/types/oracleset.md carries an explicit outcome matrix, including verbatim rows "Existing pair excluded from the transaction | The existing asset pair remains in the oracle entry, but its `AssetPrice` and `Scale` are cleared to signal the price is outdated" and "Existing pair, excluding `AssetPrice` | The asset pair is deleted from the oracle entry", plus `tecARRAY_TOO_LARGE` and `tecTOKEN_PAIR_NOT_FOUND` in its Error Cases table. XLS-47 states both rules too (README.md lines 182-183).
(b) "There is no operation that removes a single pair; OracleDelete then a fresh OracleSet is the only way back." False. rippled develop, src/libxrpl/tx/transactors/oracle/OracleSet.cpp, doApply: an entry present in the transaction carrying BaseAsset/QuoteAsset and no AssetPrice hits `pairs.erase(key)` (the branch guarded by `if (!entry.isFieldPresent(sfAssetPrice))`), deleting that pair; preclaim collects those into `pairsDel` and returns `tecTOKEN_PAIR_NOT_FOUND` if the pair is not on the object. Per-pair deletion is a first-class, specified, documented operation.
Additionally, XRPLF/rippled#4919 "Update oracle issue: Updating just one PriceDataSeries leads to deleting all other entries in the PriceDataSeries but only deletes them halfway" (open since 2024-02-14) is the same finding, and gregtatcam — the Price Oracle author — answered it publicly the same day: "This is expected behavior... the entries that have not been included in the last OracleSet have their prices missing to indicate that they are out of date."
Filing this would be a duplicate of an issue the feature's own author has already dispositioned, with a body a maintainer can disprove from their own reference page in under a minute, in front of a jury that includes those maintainers. Exactly the failure mode the brief warns about.

CANDIDATE 3 — XLS-70 credential rules do not compose with XLS-65 phase rules; a gate tested outside the subscription window returns a correct but misleading code. VERDICT: DO-NOT-FILE as an issue; comment on XRPLF/xrpl-dev-portal#3923.
The observation is true and I anchored it in source: in src/libxrpl/tx/transactors/vault/VaultDeposit.cpp, `VaultDeposit::preclaim` runs the phase check returning `tecEXPIRED` immediately after the vault lookup (the `featureLendingProtocolV1_1` block, lines ~110-119), roughly sixty lines before `checkVaultDomain(...)` which produces `tecNO_AUTH` (lines ~177-183). So the phase rule provably preempts the credential rule and the credential is never consulted outside Subscription.
But this is not a library finding — it is rippled behaviour that is correct, and the gap is documentation. And the documentation gap is already being closed: XRPLF/xrpl-dev-portal PR #3923 "Migrate LendingProtocolV1_1 docs from opensource" is OPEN, targets release-3.4.0, was updated 2026-09-13, and its vaultdeposit.md diff adds precisely `| tecEXPIRED | The vault is closed-ended and in its _Investment_ or _Redemption_ phase. |`. Opening an issue against a maintainer's in-flight PR is the wrong move.
Evidence strength is also the weakest of the three. This finding lives in .xrpl-devex/reports/session-analysis-20260913-0245.md, NOT in feedback/register.md, and the specific sequence (a credential test masked by tecEXPIRED/tecTOO_SOON) carries no transaction hashes. The register's D3 has hashes for tecEXPIRED, but for VaultCreate, not for the gate-masking case. There is one genuinely new sentence here — that the ordering makes a private vault's gate untestable outside Subscription — and a comment on #3923 is the right size for it.

**Recommended form**

File exactly two issues, and post three comments instead of the three issues the candidates proposed.

FILE 1 — XRPLF/xrpl-dev-portal, issue.
Title: `Oracle reference pages state the Scale range as 0-10; XLS-47 and rippled both allow 0-20`
Body should contain, in this order: the two exact locations (docs/references/protocol/transactions/types/oracleset.md, PriceData field table, "Valid scale ranges are 0-10"; and docs/references/protocol/ledger-data/ledger-entry-types/oracle.md line 61, same sentence); the two authorities that contradict them (XLS-0047-PriceOracles/README.md "Valid `Scale` range is {0-20}", and rippled include/xrpl/protocol/Protocol.h `constexpr std::size_t kMaxPriceScale = 20`, with OracleSet.cpp preclaim rejecting only `entry[~sfScale] > kMaxPriceScale`); the Devnet confirmation (Scale 20 -> tesSUCCESS E95ABBCE6E6E3F720A14253BDBE17BF535A5210CAE8CC6A3E852B4E5D3EDCB80; Scale 21 -> temMALFORMED; rippled 3.4.0-rc4, network_id 2); and the note that XRPLF/xrpl.js#3435 reports the same wrong bound baked into a client validator, so fixing the pages likely removes the source of that class of bug. Ask for the one-word change on both pages. No issue template exists on this repo; free-form is fine, and CONTRIBUTING.md only points at xrpl.org/resources/contribute-documentation. This is small enough that a PR would be welcomed over an issue if there is time — but an issue is the safe, in-scope move given the no-write constraint on this session.

FILE 2 — XRPLF/xrpl.js, issue.
Title: `Scale 0 cannot be expressed: validate() requires AssetPrice and Scale together, but rippled rejects an explicit Scale: 0`
Body: the client rule (packages/xrpl/src/models/transactions/oracleSet.ts lines 143-149, `OracleSet: PriceDataSeries must have both `AssetPrice` and `Scale` if any are present`); the server rule (rippled declares `{sfScale, SoeDefault}` in src/libxrpl/protocol/InnerObjectFormats.cpp, so an explicit default is refused at local check — quote the captured string verbatim: error `invalidTransaction`, message `Field 'Scale' may not be explicitly set to default.`); the spec that says which of the two is intended (XLS-47: "The `Scale` field should be omitted when the `Scale` value is 0. An omitted `Scale` field implies a value of 0."); and the net effect — through Wallet.sign / submitAndWait there is no way to publish a price at Scale 0, and the workaround is raw signing via encodeForSigning + ripple-keypairs, which the team had to write. Confirm the Devnet evidence that omitting Scale succeeds: tesSUCCESS B4E1E333773BA46CADBF60B39BF6142546A426F054C57611B6F6A8B53728C738, object reads back with no Scale key. Ask: allow AssetPrice without Scale (treat absent as 0), matching the spec. Note it is adjacent to but distinct from #3435 and link it. Include the "found while building on Devnet for the De Vinci Blockchain XRPL Lending Protocol Hackathon (12-13 September 2026)" footer the team uses on its other filings.

COMMENT 1 — XRPLF/xrpl.js#3435. Confirm the bound on rippled 3.4.0-rc4 with both hashes, and cross-link FILE 1 as the likely origin of the constant. Two short paragraphs, no restatement of the issue body.

COMMENT 2 — XRPLF/xrpl-dev-portal#3923. Thank them for the tecEXPIRED row on vaultdeposit.md, confirm it against rc5 on Devnet, and add the one sentence the row does not carry: in VaultDeposit::preclaim the phase check runs before checkVaultDomain, so on a private vault outside Subscription a deposit returns tecEXPIRED and the credential is never evaluated — a developer testing a Permissioned Domain gate at the wrong moment gets a correct code about a rule they were not testing. Offer it as an optional half-sentence on that row. This is the whole of candidate 3, correctly sized.

COMMENT 3 — nothing on rippled#4919. Deliberately. There is no new information to add and the author has already dispositioned it.

Keep F6a (rippled PreviousFields) and F6b (xrpl-py counterparty prefix) from docs/31-TASKS-FEEDBACK.md as planned — those are the strong filings in this block and nothing in this verification touches them. Budget: FILE 1 ~8 min, FILE 2 ~10 min, the two comments ~5 min together.

### Ready: issue on `XRPLF/xrpl.js` — about 10 min

**Title:** Scale 0 cannot be expressed: validate() requires AssetPrice and Scale together, but rippled rejects an explicit Scale: 0

**Body:** `contrib/filings/library-issues.md`

**Before you run it**

- None on GitHub: XRPLF/xrpl.js has has_issues=true, is not archived, and has no .github/ISSUE_TEMPLATE directory, so a free-form issue is accepted. No fork, branch or diff is needed.
- gh is already authenticated as frytegg with 'repo' scope; the issue will be opened under that account. Confirm that is the intended author before running.
- The body file is written and complete at C:/Users/Utilisateur/Documents/Coding/XRPL_Hackathon_2026/contrib/filings/xrpl-js-oracleset-scale-zero.md — run the command verbatim, do not retype the title.
- Post the #3435 comment (Devnet hashes for the 11-20 boundary) either just before or just after this issue. The body's closing section says those hashes are going there; if the comment is never posted, that sentence is wrong.
- Before running: feedback/register.md line ~1062 currently claims the #3435 hashes have already been added to the issue. They have not. Fix that sentence so the register and the filing agree.
- Not blocking this command, but must happen before the 12:30 freeze: pull the 'OracleSet has no way to remove a pair' and 'this behaviour is undocumented' claims from FEEDBACK.md, the deck, reference/probes/p5-oracle-rail/REPORT.md line 161, feedback/register.md line 2121 (Appendix C, C5), and .xrpl-devex/reports/session-analysis-20260913-0245.md friction point 1. rippled's OracleSet.cpp deletes a pair listed without AssetPrice, and xrpl.org documents the whole outcome matrix, so a maintainer on the jury can falsify those claims from memory. This issue deliberately makes none of them.

```bash
gh issue create --repo XRPLF/xrpl.js --title "Scale 0 cannot be expressed: validate() requires AssetPrice and Scale together, but rippled rejects an explicit Scale: 0" --body-file "C:/Users/Utilisateur/Documents/Coding/XRPL_Hackathon_2026/contrib/filings/xrpl-js-oracleset-scale-zero.md"
```

**Risk:** If a maintainer replies that the pairing check is intentional because `Scale` without `AssetPrice` is meaningless, the team looks like it only read half the XOR — the body pre-empts that by conceding that half explicitly and asking only for the `AssetPrice`-without-`Scale` direction, so the remaining exposure is narrow: the claim that `Wallet.sign()` always calls `validate()` and that raw signing is therefore mandatory, which was verified against the installed 5.2.0 build (`Wallet/index.js:132`) and against upstream `main` at `af60309`.

---
