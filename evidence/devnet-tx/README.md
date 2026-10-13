# Devnet transaction captures

Devnet prunes old ledgers. On 2026-10-13 the public server reported `complete_ledgers` 5193077-6086200,
and the transactions the top-level README cites sit in ledgers 5255252-5273819, close to that floor. Once
they fall below it, the public server stops returning them. This directory keeps a copy of every one, and
of the whole history the API's two history routes read.

50 transactions, captured from the Devnet JSON-RPC endpoint (`https://s.devnet.rippletest.net:51234`,
rippled 3.4.1) on 2026-10-13: the 46 the README links, and four more that complete the account histories
below (the `Payment` that funded each facility's owner).

- `<hash>.json`: the `tx` response in API v1 JSON, with `meta`.
- `<hash>.bin.json`: the same transaction requested with `binary: true`, as `tx_blob` and `meta_blob`.
- `_manifest.json`: the server, its ledger range at capture time, the eight README hashes that are not
  transactions (vault, broker and domain ids, which `tx` answers with `txnNotFound`), and `coverage`.

## Coverage: what the history routes fall back on

`/nav-history` reads `account_tx` on a vault's pseudo-account, and `/broker-history` on the account that owns
the vault and its loan brokers. The facilities' histories sit in ledgers 5261976-5262163. Devnet does not
prune a ledger at a time: rippled's `online_delete` drops everything below a server's previous rotation
point at once, and the servers behind the public endpoint rotate on their own schedules (on 13 October
their oldest ledgers were 5042942, 5171980 and 5193077, and the last held for five hours of watching). So on each
server the event's history will go in one piece, at a rotation no client can see coming. `coverage` in
`_manifest.json` declares, for each of the
four facilities in `demo/` and for each of those two accounts, the ledger range `account_tx` searched
(`ledgerMin`-`ledgerMax`) and every hash it returned: 28 distinct transactions, all captured here. It was
written by

```bash
node src/dev/capture-history.mjs             # --dry-run: read and check, write nothing
```

which is live and read-only. A later run only extends a declaration: it refuses a listing that starts
after the declared range ends or misses a declared transaction inside its own range, and it refuses to
write a declaration that no longer holds the transaction creating its vault or broker. Run after Devnet
has pruned the event, it therefore cannot replace the coverage with what is left.

`src/archive.mjs` serves only what `coverage` declares. On every successful read, a history route merges the
live transactions with the archived ones for the same account, by hash, the live copy winning; an archived
transaction the live read no longer returns is marked `"source": "archive"`. Each response states the window
it covers and whether that window reaches from the object's creation to its last change. Pruning is partial
and silent, so the merge runs on every read, not only when the live read comes back empty.

The archived transactions are captured, not verified: what `check:evidence` binds to its hash is the
transaction, not the metadata the NAV points are read from (see below). The archive loads each transaction
only if it hashes to its id, and serves the metadata as the server returned it on 2026-10-13.

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
around it (`ctid`, `date`, `hash`, `inLedger`, `ledger_index`, `status`, `validated`, and on a `Payment`
the `DeliverMax` copy of `Amount`, which must equal it), to re-encode to exactly `tx_blob`, and the JSON
`meta` to re-encode to exactly `meta_blob`; decodes both blobs and compares them with the JSON key for key,
since the encoder skips keys it does not know; checks that the two responses agree on `ledger_index` and
`date` and that `ctid` names the same ledger, transaction index and Devnet; requires every
`devnet.xrpl.org/transactions/<hash>` link in README.md to have a capture here; and requires every
transaction `coverage` declares to have one, inside the ledger range declared for it.

`check:evidence:self-test` plants defects in a temporary copy and requires the check to fail each one: a
flipped `tx_blob` nibble, the Vault `PreviousFields` of the impairment transaction forged to
`{"LossUnrealized":"0"}` in the JSON alone and in `meta_blob` alone, an unknown key inside an affected node,
a changed oracle price, a changed `ledger_index`, a missing capture, a `DeliverMax` that no longer equals
`Amount`, and a missing capture that only `coverage` declares. Its last case writes the same Vault
forgery into both copies and requires the check to pass: that is the limit stated above, kept as a case so
the limit stays measured.

Ledger objects (vaults, loan brokers, oracles, permissioned domains) are state, not history, so pruning
does not remove them; they still verify live with `ledger_entry`.
