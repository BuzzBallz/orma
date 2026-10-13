# Devnet transaction captures

Devnet prunes old ledgers. On 2026-10-13 the public server reported `complete_ledgers` 5193077-6086200,
and the transactions the top-level README cites sit in ledgers 5255252-5273819, close to that floor. Once
they fall below it, the public server stops returning them. This directory keeps a copy of every one.

For each of the 46 transaction hashes linked from the README, captured from the Devnet JSON-RPC endpoint
(`https://s.devnet.rippletest.net:51234`, rippled 3.4.1) on 2026-10-13:

- `<hash>.json`: the `tx` response in API v1 JSON, with `meta`.
- `<hash>.bin.json`: the same transaction requested with `binary: true`, as `tx_blob` and `meta_blob`.
- `_manifest.json`: the server, its ledger range at capture time, and the eight README hashes that are not
  transactions (vault, broker and domain ids, which `tx` answers with `txnNotFound`).

What can be checked offline, and what cannot. The transaction id is the hash of the signed blob, so a
`tx_blob` that hashes back to its id is the signed transaction with that id. The metadata (`meta_blob`,
which carries the result and the `PreviousFields` the findings rest on) and the `validated` flag are as the
server returned them; proving them offline would need the ledger header and its transaction tree hash.
What the check below does guarantee is that the JSON and binary copies of the metadata are the same
metadata, so neither can be edited alone.

```bash
npm run check:evidence
npm run check:evidence:self-test
```

Both run offline. For every capture, `check:evidence` recomputes the hash from `tx_blob` and requires it to
equal the file name and the stored hash; requires the JSON transaction, less the fields the server adds
around it (`ctid`, `date`, `hash`, `inLedger`, `ledger_index`, `status`, `validated`), to re-encode to
exactly `tx_blob`, and the JSON `meta` to re-encode to exactly `meta_blob`; decodes both blobs and compares
them with the JSON key for key, since the encoder skips keys it does not know; checks that the two
responses agree on `ledger_index` and `date` and that `ctid` names the same ledger, transaction index and
Devnet; and requires every `devnet.xrpl.org/transactions/<hash>` link in README.md to have a capture here.

`check:evidence:self-test` plants defects in a temporary copy and requires the check to fail each one: a
flipped `tx_blob` nibble, the Vault `PreviousFields` of the impairment transaction forged to
`{"LossUnrealized":"0"}` in the JSON alone and in `meta_blob` alone, an unknown key inside an affected node,
a changed oracle price, a changed `ledger_index`, and a missing capture. Its last case writes the same Vault
forgery into both copies and requires the check to pass: that is the limit stated above, kept as a case so
the limit stays measured.

Ledger objects (vaults, loan brokers, oracles, permissioned domains) are state, not history, so pruning
does not remove them; they still verify live with `ledger_entry`.
