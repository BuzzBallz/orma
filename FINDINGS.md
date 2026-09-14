# Developer-experience findings

40 findings from building Orma on the XRPL Lending Protocol (XLS-65 and XLS-66) during the De Vinci Blockchain XRPL Lending Protocol Hackathon, 12–13 September 2026: **7 P0, 19 P1 and 14 P2**, plus three withdrawn after re-verification and listed anyway. Every claim carries a transaction hash, a file and line, a verbatim error string or a registry timestamp; every hash is on XRPL Devnet.

- [`feedback/register.md`](feedback/register.md): the full register, with evidence, the severity rubric, upstream issue and pull request numbers, and the withdrawn findings
- [`FEEDBACK.pdf`](FEEDBACK.pdf): the three-page report written from the register
- [`feedback/appendix.pdf`](feedback/appendix.pdf): the register as a PDF
- [`documentation/pages/findings.mdx`](documentation/pages/findings.mdx): seven findings explained in depth
- [`contrib/filings/`](contrib/filings/README.md): what was filed upstream, and the one item deliberately not filed

## Index

Copied from [§3 of the register](feedback/register.md#3-index-of-findings), which remains the source of truth. Statuses are as of 2026-09-12; §13 of the register lists what moved.

| ID | Sev | Status | Component | Finding |
|---|---|---|---|---|
| **D1** | **P0** | **Specified but unmerged / partially tracked** | XLS-65, XLS-66, docs | `LendingProtocolV1_1` ships behaviour whose specification has been an open PR for 53–80 days, and one rule that no *standard* states |
| **X1** | **P0** | **Previously raised, closed untriaged** (`rippled#6487`) | rippled metadata | The first impairment of a healthy vault emits `PreviousFields: {}` and is invisible to every metadata-diffing indexer |
| D2 | P0 | NEW | xrpl-dev-portal | The lending tutorial chain does not complete, and dies as a `TypeError` instead of reporting a result code |
| L1 | P0 | Fixed during our window | `ripple-binary-codec` ≤2.10.0 | `npm install xrpl` could not serialize a close-ended `VaultCreate`; `validate()` and `autofill()` both passed it |
| L2 | P0 | NEW | xrpl-py (all versions) | No published version can sign a `LoanSet` counterparty signature; the `0x43505400` prefix does not exist in the package |
| L3 | P0 | NEW | xrpl-py 5.1.0 | `pip install xrpl-py` cannot construct a close-ended `VaultCreate` |
| M1 | P0 | NEW (related: `XRPL-Standards#611`) | rippled API | No state proof on any read API, so nothing off-ledger can verify a fact about XRPL ledger state |
| L4 | P1 | NEW | xrpl.js, all versions | `LoanSet` missing from `txToFlag`; the error names `tfInnerBatchTxn` as the only valid flag; and object-form `Flags` never reach the signer |
| L5 | P1 | Already reported (`xrpl-py#1016`) | xrpl-py | Dict-form `Flags` fail open to `0`, including the library's own documented spelling, on a lending transaction |
| L6 | P1 | NEW | both libraries | The typed `ledger_entry` request model cannot select a `Loan` or a `LoanBroker` |
| L7 | P1 | NEW | xrpl.js 5.2.0 | `VaultInfoResponse` omits the four fields that define a close-ended vault |
| U1 | P1 | NEW | rippled | `tecNO_PERMISSION` means four different things on the lending path |
| U2 | P1 | NEW | rippled | `tecINSUFFICIENT_FUNDS` cannot distinguish "you do not own that" from "the vault has no cash"; no partial fill |
| U3 | P1 | Partially tracked (`XRPL-Standards#625`) | XLS-66 | Seven rate fields are in 1e-5 units; the only written-down source is a constant inside `node_modules` |
| U4 | P1 | NEW (the layer contradiction); `Scale` range already reported as `xrpl.js#3435` | rippled + xrpl.js | Fields that may not be set to their default value, in a client that requires them |
| U5 | P1 | Already reported (`xrpl-dev-portal#3612`), with a new ask | rippled API | Absent means zero across every read surface, with no normalising option |
| M2 | P1 | NEW | rippled API | No native read of what a vault share is worth, and one valuation rule no external reader can reproduce |
| M3 | P1 | NEW | rippled / Clio | No enumeration and no event stream for vaults, brokers or loans |
| D3 | P1 | Partially tracked (`xrpl-dev-portal#3923`) | XLS-65, docs | Three `tec` outcomes that gate the lifecycle are absent from XLS-65, and the docs fix for them is unmerged |
| D4 | P1 | NEW | xrpl-dev-portal | The faucets list still advertises a Lending Devnet whose hostnames do not resolve |
| D5 | P1 | NEW | XLS-65 §3.9.1 | `vault_info`'s documented request parameter name is wrong |
| D6 | P1 | NEW | XLS-65 §4.2 | `vault_list` is fully specified with three worked examples and unimplemented on both rippled and Clio |
| D7 | P1 | NEW | xrpl-dev-portal | The canonical ledger-entry short-names table omits `Vault`, `Loan` and `LoanBroker` |
| **D9** | **P1** | **NEW — settled by experiment** (was P2) | `XRPL-Standards#587` §7 | The draft and the implementation disagree about the loan-maturity buffer, and the draft is the one that is wrong |
| L8 | P2 | Already reported (`xrpl-py#978`) | xrpl-py | `get_amount_value()` returns `float` in a library whose Number fields carry 19 significant digits |
| L9 | P2 | Already reported (`xrpl.js#3154`) | xrpl.js | `DEFAULT` fields typed as required; a defaulted loan deletes four of them |
| L10 | P2 | NEW | xrpl.js 5.2.0 | `Loan.OverpaymentFee` typed as a string in the ledger model; the wire type is `UInt32` |
| L11 | P2 | Specified but unmerged (`xrpl.js#3229`, `#2683`, `#2597`, `xrpl-py#899`) | both libraries | No custom-definitions API on the high-level client, which is what you need precisely when the release lags the network |
| L12 | P2 | NEW | xrpl.js 5.2.0 | The library writes to the console on the success path, and the vendor's own tutorial monkey-patches it away |
| L13 | P2 | Specified but unmerged (`xrpl.js#3430`) | xrpl.js | `VaultCreate` autofill charges the owner reserve and bypasses `maxFeeXRP` |
| U6 | P2 | NEW | xrpl.js | A `tem`/`tel` rejection throws an error carrying no structured result; three failure layers surface three different ways |
| U7 | P2 | NEW | xrpl.js | Client-side validators disagree with the server and cannot be bypassed through the supported API |
| U8 | P2 | NEW | rippled | The protocol's minimum feedback loop is about three minutes and there is no way to shorten it on a test network |
| U9 | P2 | NEW | docs | Phase gates evaluate against ledger `close_time`, which lags wall clock; nothing says so |
| U10 | P2 | NEW; the `VaultID` sub-case is `XRPL-Standards#497` + `rippled#6528` | XLS-66 / xrpl.js | One transaction, three field-shape conventions, and two write-once fields behind an undifferentiated error |
| M4 | P2 | Partially tracked (`XRPL-Standards#623`, closed unmerged) | XLS-66, rippled API | XLS-66's two statements of the cover-liquidation formula disagree, and no read API previews it |
| D8 | P2 | NEW | XLS-66 §3.11.1 | `LoanPay` is given transaction type 83; it is 84 |
| D10 | P2 | Partially tracked (`XRPL-Standards#616`, `#555`) | XLS-65, XLS-66 | Twelve Invariants sections, plus XLS-65's Rationale and Security Considerations, are `TBD` |
| **D11** | **P1** | **NEW** | XLS-65, XLS-66, docs | Both standards state the arithmetic completely and evaluate none of it. No number appears anywhere, and a rule nobody has evaluated reads as a rule with no consequences |
| **M5** | **P1** | **NEW — found while building** | rippled | A LoanBroker's action history cannot be reconstructed by filtering: `LoanManage` names no broker and an impairment does not touch the broker object, so impairments vanish and the consumer cannot tell |
| W1–W3 | — | **Withdrawn** | — | See §10 |
