Re-confirmed on Devnet against `rippled 3.4.0-rc5`, in case a live bracket is useful for closing this out.

The ledger accepts `Scale: 20` and rejects `21`, so rippled's bound is 20 and `SCALE_MAX = 10` in
`oracleSet.js` is the side that is wrong:

| `Scale` | Result | Transaction |
|---|---|---|
| 20 | `tesSUCCESS` | `E95ABBCE6E6E3F720A14253BDBE17BF535A5210CAE8CC6A3E852B4E5D3EDCB80` |
| 21 | `temMALFORMED` | rejected at submission, so no ledger slot and no hash |

Both were submitted with the client validator bypassed, since `validate()` refuses anything above 10
before the request is built.

Found while publishing a six-dimension vault-solvency score as an `OracleSet` series; we clamp to 10 to
stay inside the validator, which costs precision on the one dimension that needs it.
