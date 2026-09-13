## Issue Description

**This is not a bug report, and I am not asking for a change to the metadata format.** The behaviour below is
correct and it is documented. I am reporting it because the documented rule and the pages a lending developer
actually reads are far apart, and the one case where that gap bites is the most significant credit event the
Lending Protocol has.

Searched first, as the template asks. Two existing issues cover this ground:

- **#6487** — "LoanManage - Vault Object PreviousFields empty (Version: 3.1.1)", opened 2026-03-05T21:18:08Z by
  @zgrguric, closed by its author 2026-03-05T21:21:25Z, three minutes later, with one comment: "Not a bug." It
  carries no label and no maintainer replied. Its reproduction link points at a Devnet transaction that no
  longer resolves. Same behaviour, same transaction type, same field. I am opening a new issue rather than
  commenting there because the ask has changed: #6487 asked for `PreviousFields` to be filled in, and what I
  am asking for is two documentation pages to be corrected.
- **#2199** — "PreviousFields missing TakerGets", opened 2017-08-08, closed 2017-12-01 with "Closing this given
  that this behavior is as intended." A sibling rule and a different transaction type, but an indexer author
  reaching the same wrong conclusion nine years earlier. No documentation changed either time.

**What happens.** A `LoanManage` with `tfLoanImpair` takes a Vault's `LossUnrealized` from absent to a non-zero
value. The Vault's `ModifiedNode` carries `"PreviousFields": {}` while `FinalFields.LossUnrealized` holds the
new amount. Under `LEVersion: 1` (cash basis) impairment touches nothing else on the Vault — `AssetsTotal` and
`AssetsAvailable` do not move — so the node reads, to anything diffing `PreviousFields` against `FinalFields`,
as *touched but unchanged*.

**Why, stated correctly.** `PreviousFields` records a previous value only for a field that existed on the
object before the transaction. `LossUnrealized` is not serialized on a healthy Vault at all, so there is no
previous value to record. It is **not** that a previous value equal to the type default gets dropped — the
same transaction disproves that, which is the useful part:

| Node in tx `075FE6D2…` | Field | Value before | In `PreviousFields`? |
|---|---|---|---|
| `Loan` `60C170A9…` | `Flags` | `0` — the type default, but present on the object | **Yes**, as `{"Flags": 0}` |
| `Vault` `864C5A2D…` | `LossUnrealized` | absent from the object | **No**, `PreviousFields` is `{}` |

Two fields, one transaction, and one of them is a zero that *is* recorded. The rule is presence, not value.

That a healthy Vault genuinely carries no `LossUnrealized` is checkable right now — Supporting Files has two
Devnet vault IDs that return a Vault object with no `LossUnrealized` key.

**The mirror case, also verified.** On `tfLoanUnimpair` the loss returns to zero and the field is *deleted*
from the Vault: tx `32454E10D0B2BAA13367AD7AC06EFC9B9E3A5D85C2C2F7BD740575BEB0B746CA`, ledger 5233122, has
`PreviousFields: {"LossUnrealized": "10000000"}` and a `FinalFields` with no `LossUnrealized` key at all. So a
reader that coalesces the absent field to `0` is right in both directions, and a reader that diffs metadata is
wrong in one of them.

### What it costs

Transaction `075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3`, validated in ledger 5262028,
Vault `864C5A2DDCED78C6198B0703169D533B747A56E5F9398D832033F79E37E8C835`, whose share issuance
`00000001445D6D0A3C01CD265D6D674FB2F9FF60D0E2A0A3` has `OutstandingAmount` `51000000`:

| | |
|---|---|
| Naive, `AssetsTotal / OutstandingAmount` | 51000000 / 51000000 = **1.000000** |
| Net of recognised loss, `(AssetsTotal − LossUnrealized) / OutstandingAmount` | (51000000 − 10000000) / 51000000 = **0.803922** |
| Divergence | **1961 bps** |

Every figure in that table comes from the one transaction and the one MPT issuance named above, and nothing
else.

### It is asymmetric, which is why it survives testing

| Event | `LossUnrealized` before | `PreviousFields` on the Vault | Visible to a diff? | Transaction |
|---|---|---|---|---|
| First impairment of a healthy vault | field absent | `{}` | **No** | `075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3` |
| `tfLoanUnimpair` | `"10000000"` | `{"LossUnrealized": "10000000"}` | Yes | `32454E10D0B2BAA13367AD7AC06EFC9B9E3A5D85C2C2F7BD740575BEB0B746CA` |
| Second impairment while one is outstanding | `"2000000"` | `{"LossUnrealized": "2000000"}`, final `"5000000"` | Yes | `968D2C735E3214B50073E0BCB6E682B4260CACFF3E3E2D54AA94E033FF09385F` |

Test the reversal, or test a second impairment, and the metadata looks right. The only case that breaks is the
transition from healthy to distressed.

### What I am actually asking for

The general rule is already documented, and I would rather quote it than pretend otherwise.
`XRPLF/xrpl-dev-portal`, `docs/references/protocol/transactions/metadata.md`, the "ModifiedNode Fields" table,
`PreviousFields` row:

> The previous values for all fields of the object that were changed as a result of this transaction. If the
> transaction _only added_ fields to the object, this field is an empty object.

That sentence is correct and it covers this case exactly. Three concrete page-level gaps remain, all of them in
`xrpl-dev-portal` rather than here:

1. `docs/references/protocol/ledger-data/ledger-entry-types/vault.md` lists `LossUnrealized` with **Required =
   Yes**, and its example JSON shows `"LossUnrealized": "0"`. On Devnet a healthy Vault has no `LossUnrealized`
   field. A developer who reads that page writes `vault.LossUnrealized` and gets `undefined`, not `"0"`.
2. `docs/references/protocol/transactions/types/loanmanage.md` does not contain the string `LossUnrealized`
   anywhere. It documents the flag as "Indicates the the loan should be impaired" without saying that
   `tfLoanImpair` writes `LossUnrealized` on the Vault, or that on a cash-basis vault this is the only Vault
   field it changes.
3. Neither page links to the `PreviousFields` sentence above, and that sentence states the rule without stating
   the inference a developer draws from it — that an empty `PreviousFields` is not evidence of no change.

I am happy to open that documentation PR on `xrpl-dev-portal` myself, adding wording to the existing rows
rather than replacing them. I am filing here because this is where the behaviour lives and where #6487 was
filed and left unanswered; close or transfer this as you prefer.

If a code-side change were ever considered, the cheapest useful one is for `LoanManage` to record the loss
delta in its own transaction metadata so the credit event is legible without re-reading state. That is a format
change and I am not proposing it as the remedy.

## Steps to Reproduce

Against XRPL Devnet, `wss://s.devnet.rippletest.net:51233` / `https://s.devnet.rippletest.net:51234`:

1. `VaultCreate` a closed-ended XRP vault — `VaultKind: 1` with `SubscriptionDate` and `RedemptionDate`, or
   `LoanBrokerSet` returns `tecNO_PERMISSION` — deposit, then `LoanBrokerSet` a broker on it.
2. Read the Vault with `ledger_entry` before impairing anything. It has no `LossUnrealized` field.
3. `LoanSet` a loan and let it go past due; a loan may only be impaired once it is already past due.
4. As the LoanBroker owner, submit `LoanManage` with `Flags: 131072` (`tfLoanImpair`).
5. Fetch the transaction with the `tx` method and read the Vault's `ModifiedNode`.

Or skip all of that and fetch the transaction I already have, which is still validated on Devnet. The exact
commands are under Supporting Files.

## Expected Result

I expected the Vault `ModifiedNode` to give me something to diff against, because that is how most of the
ledger behaves and because the lending reference pages gave me no reason to think otherwise. The outcome I want
is not different metadata. It is that the `Vault` and `LoanManage` reference pages say what `tfLoanImpair`
writes, and that an empty `PreviousFields` stops being read as "nothing changed".

## Actual Result

`PreviousFields` is present and empty on the Vault node, and it is the daemon's own output rather than a client
rendering. From a raw JSON-RPC `tx` call, with no client library in the path:

```json
{
  "ModifiedNode": {
    "FinalFields": {
      "Account": "rfN71PmswUhMAyxWi4jX9KYQnLvr1x5i51",
      "Asset": { "currency": "XRP" },
      "AssetsAvailable": "41000000",
      "AssetsTotal": "51000000",
      "Flags": 0,
      "LEVersion": 1,
      "LossUnrealized": "10000000",
      "Owner": "rH7LXexgwZVNcH2ARsi22FjNqHJFFjhevA",
      "OwnerNode": "0",
      "RedemptionDate": 842627125,
      "Sequence": 5261976,
      "ShareMPTID": "00000001445D6D0A3C01CD265D6D674FB2F9FF60D0E2A0A3",
      "SubscriptionDate": 842562325,
      "VaultKind": 1,
      "WithdrawalPolicy": 1
    },
    "LedgerEntryType": "Vault",
    "LedgerIndex": "864C5A2DDCED78C6198B0703169D533B747A56E5F9398D832033F79E37E8C835",
    "PreviousFields": {},
    "PreviousTxnID": "1523BD1B1548A01B46AAA88871EA965EE973BFA7016D7B8ACC950E463567AA4A",
    "PreviousTxnLgrSeq": 5261989
  }
}
```

The empty object is in the serialized metadata, not added by JSON rendering. Requesting the same transaction
with `"binary": true` returns a 658-byte metadata blob in which the bytes between the Vault node's
`LedgerIndex` and its `FinalFields` are `E6 E1` — the `sfPreviousFields` field header followed immediately by
the object-end marker:

```
... F79E37E8C835 E6E1 E722 ...
    ^LedgerIndex ^^^^ ^FinalFields
```

Decoding that blob and re-encoding it round-trips byte-identical. Dropping the empty `PreviousFields` and
re-encoding produces a blob two bytes shorter that does not match. So the empty object is what the network
agreed on, which also makes the documented phrase "this field is an empty object" literally accurate — worth
knowing before anyone rewrites that sentence.

Also observed, same shape, different vaults and different days:

- `8B9657E31D9130FE557682FE33E779789243EACEB0E0D97D83F5D6A3F477A1D5`, ledger 5233080, Vault
  `6717B5115871C2C1A5552C62B68F52A55C9C58086BD1FDC78D7DCE43ACDD773C` — `PreviousFields: {}`, `FinalFields`
  `AssetsTotal` `51000000`, `LossUnrealized` `10000000`.
- `BF3C131BFCDB0BA867DDA4A3AC2F99360A7E4D7AA196F35BEB0906CA4FF9A94C`, ledger 5247782, Vault
  `7C8030131A30658257F33CB9FB9BDF34A7ED7C4C77A4D1D4855D1A92699C07C0` — `PreviousFields: {}`, `FinalFields`
  `AssetsTotal` `40000000`, `LossUnrealized` `10000000`. A different vault, so the NAV arithmetic above does
  not apply to this one.

## Environment

- XRPL Devnet, `wss://s.devnet.rippletest.net:51233`, JSON-RPC `https://s.devnet.rippletest.net:51234`.
- `server_info` on 2026-09-13 returned `build_version` **`3.4.0-rc5`**, `network_id` **2**, `server_state`
  `full`. I did not build the daemon; this is the public Devnet cluster.
- Transactions captured 2026-09-12, re-fetched and re-verified 2026-09-13.
- Client side: `xrpl` (JS) 5.2.0 for submission. All metadata quoted above was re-fetched with `curl` against
  the JSON-RPC endpoint so that no client library sits in the evidence path.

## Supporting Files

Every command below is read-only and reproduces the evidence with no setup.

The impairment, with metadata:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"method":"tx","params":[{"transaction":"075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3"}]}' \
  https://s.devnet.rippletest.net:51234/
```

The same transaction as a binary metadata blob, for the `E6E1` check:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"method":"tx","params":[{"transaction":"075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3","binary":true}]}' \
  https://s.devnet.rippletest.net:51234/
```

Two vaults that have never been impaired, both returning a Vault object with no `LossUnrealized` key — the
evidence for documentation gap 1 above:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"method":"ledger_entry","params":[{"vault":"4A5A8E3716D52E334AEB077ADB09456EF4A941CC26021A8EAD37F95B00190DF5","ledger_index":"validated"}]}' \
  https://s.devnet.rippletest.net:51234/

curl -s -H 'Content-Type: application/json' \
  -d '{"method":"ledger_entry","params":[{"vault":"24EAA01AD4CE70D8ABB4ACB4255DC4C216B8AF3B9E7315DB8052BFC1E5810089","ledger_index":"validated"}]}' \
  https://s.devnet.rippletest.net:51234/
```

The share issuance behind the NAV arithmetic, `OutstandingAmount` `51000000`:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"method":"ledger_entry","params":[{"mpt_issuance":"00000001445D6D0A3C01CD265D6D674FB2F9FF60D0E2A0A3","ledger_index":"validated"}]}' \
  https://s.devnet.rippletest.net:51234/
```

The un-impairment and the second impairment, for the asymmetry table:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"method":"tx","params":[{"transaction":"32454E10D0B2BAA13367AD7AC06EFC9B9E3A5D85C2C2F7BD740575BEB0B746CA"}]}' \
  https://s.devnet.rippletest.net:51234/

curl -s -H 'Content-Type: application/json' \
  -d '{"method":"tx","params":[{"transaction":"968D2C735E3214B50073E0BCB6E682B4260CACFF3E3E2D54AA94E033FF09385F"}]}' \
  https://s.devnet.rippletest.net:51234/
```

If Devnet is reset before anyone looks at this, the vault IDs go away but the shape does not: steps 1 to 5
above reproduce it from scratch in a few minutes.

---

Found while building an indexer that tracks vault solvency on Devnet. The workaround is three lines — never
diff `PreviousFields`, re-read the Vault object after every `LoanManage`, coalesce an absent `LossUnrealized`
to `"0"`, and parse the decimal strings at full precision. Working out that it was necessary took a day, and
from the timestamps on #6487 it looks like it took @zgrguric one too.
