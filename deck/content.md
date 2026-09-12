# Orma — deck content

<!-- 10 slides, 4:00 total. Matches docs/45-RUNSHEET.md beat for beat, slide for slide. -->
<!-- Renderer: one slide per `## S` heading. Nothing above the first `## S1` is a slide. -->
<!-- Design: almost no text on screen, big numbers, one idea per slide. The speaker carries the argument. -->
<!-- Team BuzzBallz. Alexandre Lemiere (backend, protocol, research), Andrea Gonzalez (frontend). -->

---

## S1 — The empty object
<!-- time: 0:00 | duration: 15s -->

### on screen
- `"PreviousFields": {}`
- this is everything the indexer was told

### notes
Live on the Verification tab, the `{}` block filling the panel.

A lending vault takes fifty-one XRP. It lends ten. The borrower stops paying and the manager writes the loan down. // The fund is now worth eighty cents on the unit. // **This is everything an indexer watching that ledger was told.**

*Beat. Let them read the braces.*

---

## S2 — One party, two levers
<!-- time: 0:15 | duration: 25s -->

### on screen
- LoanBroker owner = vault owner
- two levers: **when**, and **in what order**

### notes
Two lines, nothing else.

The loan broker owner **is** the vault owner. Same account, by protocol. // They hold two levers. // **When** to recognise a loss: until they do, the reported value reads clean. // And **in what order** to realise them: cover is sized against the broker's *total* book, so each default shrinks the base for the next. // Both move money toward the manager. Neither is visible with the standard tools.

---

## S3 — What Orma is
<!-- time: 0:40 | duration: 12s -->

### on screen
- measure → publish → enforce
- Meridian · Kestrel · Calder · Thorne
- four facilities, live on Devnet

### notes
Orma measures both, publishes them as a ledger object and inside the share token, and lets a third party gate capital on the result. // All of it on Devnet, built today.

---

## S4 — Two readers, one transaction
<!-- time: 0:52 | duration: 35s -->

### on screen
- diffs metadata: **1.000000**
- re-reads the object: **0.803922**
- 1,961 bp apart, same transaction
- `LossUnrealized` 0 → 10,000,000, omitted

### notes
Stay on Verification. The scroll is already set.

Left: a reader that diffs transaction metadata. The standard way. // Right: ours. It re-reads the object. // **One point zero zero.** Against **zero point eight zero**. // Nineteen per cent apart, on the same transaction, from the same ledger.

**Scroll down one screen** to the before/after table.

And here is why. `LossUnrealized` was zero, and zero is the type default, so rippled omits it from the change set. // The other two fields genuinely did not move. // The one that did is the one that is invisible.

*This is the moment they remember. Do not rush the table.*

---

## S5 — The order
<!-- time: 1:27 | duration: 40s -->

### on screen
- largest loss first: **0.50 XRP** of cover
- smallest first: **0.70 XRP**
- the difference, **0.20 XRP**, is investor money
- Calder, same tool: conduct **A**

### notes
Facility picker → **Kestrel Bridge Financing II** → scroll to Exhibit 3.

Two bad loans, thirty XRP and ten. This manager declared the big one first. // That consumed **zero point five** of their own first-loss capital. // Small one first would have consumed **zero point seven**. // Same losses, same rates, only the order. // The **zero point two** is investor money, and the party who chose the order is the party it spared.

Facility picker → **Calder Structured Credit III**.

Same tool, same screen, a different manager. // Conduct **A**. They flagged the loss before they took it. // **That** is what a new investor wants to see before they subscribe.

*Say "default sequencing and cover sizing" and nothing wider. Do not extend "unilateral control" to impairment re-pricing. `41-SECURITY-DISCLOSURE.md` §9.*

---

## S6 — The token prices itself
<!-- time: 2:07 | duration: 30s -->

### on screen
- five steps, none of them ours
- priced naively: **1.000000**
- priced on the pointer: **0.803922**
- **0.196078 XRP** kept off the second lender's book

### notes
Stay on Calder. Scroll to Exhibit 5.

An investor pledges their units to a second lender. That lender holds a token and nothing else. // They read the token's own metadata, follow the pointer it declares, and price the pledge. Five steps, none of which involve us. // Priced naively: **one point zero zero**. Priced on what the instrument points to: **zero point eight zero**. // **Zero point one nine of overstatement, kept out of the second lender's book.**

*`[+]` at 5:00 only: on Kestrel that same exhibit stops at step two: no metadata, nothing readable. That is every vault today.*

---

## S7 — The gate
<!-- time: 2:37 | duration: 20s -->

### on screen
- graded LP: `tesSUCCESS`
- ungraded LP: `tecNO_AUTH`
- refused by the ledger, not by us

### notes
Facility picker → **Thorne Senior Secured I** → Exhibit 6.

Measuring is advice. This is enforcement. // An independent vault owner named our issuer in their domain. We signed nothing, and we cannot decline. // Two investors, same second: one admitted, the other refused **by the ledger**, not by us.

*`[+]` at 5:00 only: and when we revoke, entry closes and the exit stays open. A rater who could trap capital would be a worse problem than the one we solve.*

---

## S8 — Developer experience
<!-- time: 2:57 | duration: 50s -->

### on screen
- **QR code to `FEEDBACK.md`, top right**
- **X1** the empty change set
- **D2** the documented first hour cannot complete
- **M5** a broker's history cannot be reconstructed
- severity strip: 40 findings, **7 / 19 / 14** (P0 / P1 / P2)

### notes
Three lines with their finding ids, a QR code to `FEEDBACK.md`, and the 40-mark severity strip.

Forty findings, filed as we hit them. Our top three. // **One.** The empty change set you saw in the first demo. One paragraph on the metadata page fixes it, and it was reported before us by the author of an XRPL explorer, who closed it himself as not-a-bug. He was half right. // **Two.** The documented first hour cannot complete. We shipped the fix. // **Three.** A broker's history cannot be reconstructed by filtering: `LoanManage` names no broker and an impairment does not touch the broker object, so every impairment vanishes and the consumer cannot tell. That one shipped a wrong answer in our own code before we caught it. // That code is the report.

*This is the highest-scoring slide in the deck. If you are over time, cut a demo beat, never this one.*

---

## S9 — What we gave back
<!-- time: 3:47 | duration: 8s -->

### on screen
- one pull request: the tutorial, green on rc5 in 79.6 s
- four upstream threads, not duplicates
- 40 findings, every one evidenced

### notes
One pull request: the tutorial, green on rc5. // Reproductions onto four existing threads, not duplicates. // Forty findings, every one evidenced. // All filed before this pitch.

*Say the count the 11:00 filing block actually filed, not the planned one. `docs/31-TASKS-FEEDBACK.md` F11: an honest four beats an inflated five, in front of the people who own the repositories.*

---

## S10 — Close
<!-- time: 3:55 | duration: 5s -->

### on screen
- **Orma**
- **github.com/frytegg/xrpl-vault-fragility-oracle**
- Track 2 · Loaded · Devnet · rippled 3.4.0-rc5 · xrpl 5.2.0 · Node 24.13.0
- DevEx: `tender-gopher-21` · `<second pseudonym: read from Andrea's .xrpl-devex/identity.json>`

### notes
The repo URL, big. The compliance block under it.

Orma. The repo is on the slide. // Thank you.

*Stop. Do not summarise. Take the questions.*
