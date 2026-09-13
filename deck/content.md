# Orma — deck content

<!-- 10 slides, 4:00 total. Matches docs/45-RUNSHEET.md beat for beat, slide for slide. -->
<!-- Renderer: one slide per level-two heading. Nothing above the first one is rendered. -->

## S1 - Orma
<!-- time: 0:00 | duration: 30s | layout: cover -->

### on screen

### notes
The mark alone. Nothing to read, because for thirty seconds they are listening, not reading.

Yesterday morning, in your workshop, you explicitly said: // "The human or AI controlling the loan broker from the SAV needs to do a liquidity buffer and liquidity management in order to know when the depositors will want to withdraw, in case of specific events or crisis for instance, to be attractive on the market." // We spent the weekend building the instrument that makes that measurable, from a third party outside, directly on the ledger, for closed-ended vaults.

*Check the quote against what was actually said before you put it in quotation marks. They will compare it to their memory, and a paraphrase presented as a quotation costs credibility at the worst possible moment.*

*30s against a 15s budget. That is 12% of the talk on the opening. Deliberate if you take it from elsewhere; a problem if you do not.*

---

## S2 - Locked in, and unreadable
<!-- time: 0:30 | duration: 30s | artifact: lock -->

### on screen
- Risk does not disappear.
- It moves to **one immutable timestamp**.

### notes
Your tri-party slide says the intermediary absorbs first losses, and earns a spread for managing risk. // That design is good: closed-ended vaults block the exit race that made those failures worse on other chains. Withdrawals are refused for the whole Investment phase.

But risk does not disappear. It moves to one public, immutable timestamp.

During the lock-up the depositor watches the vault get worse, and cannot leave. Nobody prices that, simply because from outside nobody can read it.

*Both facts are measured, not asserted: VaultWithdraw returns tecTOO_SOON for the entire Investment phase regardless of liquidity, and RedemptionDate is immutable because VaultSet rejects it at deserialization. Keep the result code off the wall and in your pocket, for the questions.*

*Say "closed-ended vaults", not "XLS-66": the phase rules are XLS-65. And "the exit race that made those failures worse", not "the thing that killed Maple", because Maple died of credit losses on undercollateralised loans and of cover withdrawn ahead of the defaults, which no lock-up would have prevented.*


## S3 - Three pillars
<!-- time: 1:00 | duration: 25s | artifact: layers -->

### on screen
- Read it correctly.
- Publish it where anyone can disagree.
- Let it gate capital.

### notes
Nobody can read it from outside. So we read it. // A reader that sees what the vault's own reporting does not. // A score published as a native XRPL object, so anyone can disagree with us on the ledger. // And a grade that gates capital, through a Permissioned Domain.

One thing before the demo. The state is pre-baked: real Devnet transactions, from before this talk, every one of them with a hash on screen. Every number you see is read live, off the ledger, now.

*"Disagree with us on the ledger" is the strongest line in the deck. It is the whole argument for a native oracle object over an API: an API can only be trusted, an oracle object can be contested by a second publisher without asking us.*

*The live-deposit promise is made at minute one and has to be kept at minute three. The keys are in .demo-keys.json and the gate facility must still be in its Subscription phase. Check both before you walk up, or drop the sentence.*


## S4 — Meridian, and the loss nobody can see
<!-- time: 1:25 | duration: 55s | artifact: split -->

### on screen
- **Meridian Trade Finance I** · 51 in, 10 lent
- The borrower defaults. **The manager writes it down, on the ledger.**
- Every standard indexer still reads **1.000000**

### notes
*Slide for twelve seconds, then switch to the browser and stay there until S8. Two switches in the whole talk, not five.*

Meridian Trade Finance I. A trade finance facility: it funds invoices. Fifty-one units in, ten lent against one invoice. // The borrower stops paying, and the manager writes the loan down. On the ledger. Correctly. // **This is the honest manager.** Now watch what his investor's dashboard sees.

**Switch to the browser. Evidence tab. It all fits on one screen, and Record is open on arrival.**

Reported, one point zero zero. // Held, zero point eight zero. // **Nineteen hundred and sixty-one basis points apart**, on the same transaction, from the same record. // Put a hundred million through that facility and the gap is nineteen point six million that nobody's risk system has recorded.

**Point at the Change set column.**

And here is why. Three dashes. The change set is **empty** — `PreviousFields`, bottom left, is two braces. // `LossUnrealized` was zero before, and zero is the type default, so rippled leaves it out of the diff entirely. // Nothing in it says this vault moved.

So the manager who disclosed and the manager who hid it **look identical from outside**. That is what we set out to fix.

*Every cell in that column is an em-dash, because `previousFields` is `{}` and the column renders the change set, not the prior state. Do not say "the other two fields did not move": true of the ledger, not of what is on the wall. Say "the change set is empty".*

*The worked line under the formula is there so the two headline figures can be reproduced from the screen: (51.000000 - 10.000000) / 51.000000 = 0.803922. If someone asks where the denominator comes from, it is the share issuance, not the Vault.*

*The 51 and the 10 are XRP on Devnet. The hundred-million line is an explicit scaling, said as one. Never present a Devnet figure as a real balance sheet.*

*Meridian is graded AA with a 19.6% loss, and that is on screen behind you. It is correct — the score rewards recognising a loss — but `46-QA-CAVEATS.md` §7 is the answer if it is asked.*

---

## S5 — The order
<!-- time: 2:20 | duration: 40s -->

### on screen
- largest loss first: **0.50 XRP** of cover
- smallest first: **0.70 XRP**
- the difference, **0.20 XRP**, is investor money
- Calder, same tool: conduct **A**

### notes
**Facility tab** first, then the picker → **Kestrel Bridge Financing II** → scroll to Exhibit 3. Picking from the Evidence tab used to leave you on Evidence; it now moves you, but change tab yourself so the movement is the one you rehearsed.

Two bad loans, thirty XRP and ten. This manager declared the big one first. // That consumed **zero point five** of their own first-loss capital. // Small one first would have consumed **zero point seven**. // Same losses, same rates, only the order. // The **zero point two** is investor money, and the party who chose the order is the party it spared.

Facility picker → **Calder Structured Credit III**.

Same tool, same exhibit, a different manager. // Conduct **A**: no loss written off at all, and the one distressed exposure flagged and left flagged. // **That** is what a new investor wants to see before they subscribe.

*Say "default sequencing and cover sizing" and nothing wider. Do not extend "unilateral control" to impairment re-pricing. `41-SECURITY-DISCLOSURE.md` §9.*

---

## S6 — The token prices itself
<!-- time: 3:00 | duration: 30s -->

### on screen
- five steps, no relationship needed
- priced naively: **1.000000**
- priced on the pointer: **0.803922**
- **0.196078 XRP** kept off the second lender's book

### notes
Stay on Calder. Scroll to Exhibit 5.

An investor pledges their units to a second lender. That lender holds a token and nothing else. // They read the token's own metadata, follow the pointer it declares, and price the pledge. Five steps, and not one of them needs a relationship with the facility. // Priced naively: **one point zero zero**. Priced on what the instrument points to: **zero point eight zero**. // **Zero point one nine of overstatement, kept out of the second lender's book.**

*The pointer on the wall is our own endpoint on this laptop, and steps four and five say so in green. Volunteer it before it is asked: "in production that URL is whatever the issuer wrote into the token. The point is the lender learns where to look from the token, not from us."*

*`[+]` at 5:00 only: on Kestrel that same exhibit stops at step two: no metadata, nothing readable. That is every vault today.*

---

## S7 — The score, where we cannot take it back
<!-- time: 3:30 | duration: 30s | artifact: token -->

### on screen
- an **XLS-47 PriceOracle**, keyed to the vault id
- six dimensions, read back off the object
- us: **0.803922** · a second reader: **1.000000**
- median, computed by **rippled**: **0.901961**

### notes
Stay on the facility. Scroll to Exhibit 7.

Everything so far was our reading, and you have been asked to believe it. // This is that reading written to the ledger as a Price Oracle, keyed to the vault id, six dimensions in one object. // The values on the left are read **back** off the object, raw hex and all, so you can open it in an explorer and check the encoding without us.

**Point at the contest table.**

And here is why it is an oracle and not an API. // A second publisher posted their own reading of the same vault: **one point zero zero**, the naive number. They did not ask us. We cannot touch their document. // **rippled** computed the median across both. Not us. // If we are wrong, the spread is on the ledger and anyone can see it.

*Two publishers, size 2, standard deviation 0.1386. The second reading is a throwaway Devnet account publishing the naive figure deliberately, and say so if asked: the point is not that someone disagrees, it is that they can, without our permission.*

*An API can only be trusted. This can be contested. That single sentence is the whole argument for the third pillar, and it is the one to keep if the beat runs long.*

---

## S8 — The gate
<!-- time: 4:00 | duration: 20s -->

### on screen
- graded LP: `tesSUCCESS`
- ungraded LP: `tecNO_AUTH`
- refused by the ledger, not by us

### notes
Picker → **Thorne Senior Secured I** → scroll to Exhibit 6, it sits above Key Indicators. The chain is nine rows with a hash on each.

Measuring is advice. This is enforcement. // An independent vault owner named our issuer in their domain. We signed nothing, and we cannot decline. // Two investors, same second: one admitted, the other refused **by the ledger**, not by us.

*`[+]` at 5:00 only: and when we revoke, entry closes and the exit stays open. A rater who could trap capital would be a worse problem than the one we solve.*

---

## S9 — Developer experience, and what we gave back
<!-- time: 4:20 | duration: 48s | artifact: report -->

### on screen
- **QR code to `FEEDBACK.md`, top right**
- **X1** the empty change set
- **D2** the documented first hour cannot complete
- **M5** a broker's history cannot be reconstructed
- 40 findings · **7 / 19 / 14** · filed, not saved for the pitch

### notes
Forty findings, filed as we hit them. Our top three. // **One.** The empty change set you saw in the first demo. One paragraph on the metadata page fixes it, and it was reported before us by the author of an XRPL explorer, who closed it himself as not-a-bug. He was half right. // **Two.** The documented first hour cannot complete. We shipped the fix. // **Three.** A broker's history cannot be reconstructed by filtering: `LoanManage` names no broker and an impairment does not touch the broker object, so every impairment vanishes and the consumer cannot tell. That one shipped a wrong answer in our own code before we caught it. // That code is the report.

One pull request, reproductions onto existing threads rather than duplicates, and every finding evidenced. All filed before this pitch.

*This is the highest-scoring slide in the deck. If you are over time, cut a demo beat, never this one.*

*Say the count the 11:00 filing block actually reached, not the planned one. An honest four beats an inflated five, in front of the people who own the repositories.*

---

## S10 — Close
<!-- time: 5:08 | duration: 5s -->

### on screen
- **Orma**
- **github.com/frytegg/orma**
- Track 2 · Loaded · Devnet · rippled 3.4.0-rc5 · xrpl 5.2.0 · Node 24.13.0
- DevEx: `tender-gopher-21` · `<second pseudonym: read from Andrea's .xrpl-devex/identity.json>`

### notes
The repo URL, big. The compliance block under it.

Orma. The repo is on the slide. // Thank you.

*Stop. Do not summarise. Take the questions.*
