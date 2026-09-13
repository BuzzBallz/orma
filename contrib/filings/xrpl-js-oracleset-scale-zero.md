`xrpl.js` 5.2.0 (stable, 2026-09-11), XRPL Devnet, rippled 3.4.0-rc4 / 3.4.0-rc5, `network_id` 2.

## Summary

`validateOracleSet` requires `AssetPrice` and `Scale` to be present together or absent together. rippled
declares `sfScale` as `SoeDefault` and refuses a serialized transaction that sets it explicitly to its
default. The two rules leave no way to publish a price at `Scale: 0` through `Wallet.sign()` /
`client.submitAndWait()`:

| What you send | Where it stops |
|---|---|
| `AssetPrice` **and** `Scale: 0` | `Wallet.sign()` passes validation; rippled rejects the blob at local check |
| `AssetPrice`, `Scale` omitted | `Wallet.sign()` throws a `ValidationError` before anything is submitted |

`Wallet.sign()` calls `validate(tx)` unconditionally (`packages/xrpl/src/Wallet/index.ts`, in `sign()`),
so the second row cannot be opted out of on the supported path.

## Reproduction

```js
import { Client } from 'xrpl' // 5.2.0

const client = new Client('wss://s.devnet.rippletest.net:51233')
await client.connect()
const { wallet } = await client.fundWallet()

const base = {
  TransactionType: 'OracleSet',
  Account: wallet.classicAddress,
  OracleDocumentId: 1,
  Provider: Buffer.from('example').toString('hex').toUpperCase(),
  AssetClass: Buffer.from('currency').toString('hex').toUpperCase(),
  LastUpdateTime: Math.floor(Date.now() / 1000),
}

// (a) explicit Scale: 0 — passes the client, rejected by the server
await client.submitAndWait({
  ...base,
  PriceDataSeries: [{ PriceData: { BaseAsset: 'XRP', QuoteAsset: 'USD', AssetPrice: '2710', Scale: 0 } }],
}, { wallet })
// submit response:
//   error:   "invalidTransaction"
//   message: "Field 'Scale' may not be explicitly set to default."

// (b) Scale omitted — never reaches the server
await client.submitAndWait({
  ...base,
  PriceDataSeries: [{ PriceData: { BaseAsset: 'XRP', QuoteAsset: 'USD', AssetPrice: '2710' } }],
}, { wallet })
// ValidationError: OracleSet: PriceDataSeries must have both `AssetPrice` and `Scale` if any are present
```

Both error strings above are copied verbatim from the captures, not paraphrased. Path (a) is rejected
before consensus and therefore has no transaction hash; path (b) never leaves the process.

## The two rules

**Client** — `packages/xrpl/src/models/transactions/oracleSet.ts`, lines 143-151 on
[`af60309`](https://github.com/XRPLF/xrpl.js/blob/af603090aea2cd959741372683e80e2206f24ff9/packages/xrpl/src/models/transactions/oracleSet.ts#L143-L151):

```ts
// Either AssetPrice and Scale are both present or both excluded
if (
  (priceDataInner.AssetPrice == null) !==
  (priceDataInner.Scale == null)
) {
  throw new ValidationError(
    'OracleSet: PriceDataSeries must have both `AssetPrice` and `Scale` if any are present',
  )
}
```

**Server** — `src/libxrpl/protocol/InnerObjectFormats.cpp`, lines 124-131 on
[`9403736`](https://github.com/XRPLF/rippled/blob/94037361992ad75b32a6b2659b655ab96b7cb7c2/src/libxrpl/protocol/InnerObjectFormats.cpp#L124-L131):

```cpp
add(sfPriceData.jsonName,
    sfPriceData.getCode(),
    {
        {sfBaseAsset, SoeRequired},
        {sfQuoteAsset, SoeRequired},
        {sfAssetPrice, SoeOptional},
        {sfScale, SoeDefault},
    });
```

`SoeDefault` is what produces `Field 'Scale' may not be explicitly set to default.` This is deliberate on
the rippled side and I am not asking for it to change.

## Which rule the spec intends

XLS-0047-PriceOracles, `README.md` line 158, in the `OracleSet` transaction section:

> `Scale` is the price's scaling factor, with a valid range of values {1-20}. The `Scale` field should be
> omitted when the `Scale` value is 0. An omitted `Scale` field implies a value of 0.

So omitting `Scale` is the specified way to express 0, which is exactly what the client validator rejects.
(Line 57 of the same document, describing the stored ledger field rather than the transaction, reads
"Valid Scale range is {0-20}". The {1-20} above is specific to what a transaction may carry.)

## Devnet confirmation that omission is the correct wire form

Omitting `Scale` entirely and submitting on the raw-signing path described below (the only way to get
such a transaction past `validate()`):

- `tesSUCCESS`, `B4E1E333773BA46CADBF60B39BF6142546A426F054C57611B6F6A8B53728C738`
- the resulting `Oracle` object reads back through `ledger_entry` with **no `Scale` key at all**, which is
  the `SoeDefault` omission rule applied on the way out as well

Captured on Devnet, rippled 3.4.0-rc4, `network_id` 2, as part of a run that also pinned the accepted range
at the server: `Scale: 20` → `tesSUCCESS`
`E95ABBCE6E6E3F720A14253BDBE17BF535A5210CAE8CC6A3E852B4E5D3EDCB80`; `Scale: 21` → `temMALFORMED`
(`F3B128AAC2F05252D0F7CD4DAC8205055AE984E531062E4AC7CB257B0A544E89`).

## Workaround we shipped

Bypass `Wallet.sign()` for this one transaction and sign the blob directly, which skips `validate()`:

```js
import { encodeForSigning, encode } from 'ripple-binary-codec'
import { sign as kpSign } from 'ripple-keypairs'

tx.SigningPubKey = wallet.publicKey
tx.TxnSignature = kpSign(encodeForSigning(tx), wallet.privateKey)
await client.request({ command: 'submit', tx_blob: encode(tx) })
```

It works, but it gives up every other check `validate()` performs, and it has to be maintained separately
from the library's signing path. A publisher whose price is a small integer — a ratio, a count, a score in
whole units — hits this on its first transaction.

## Ask

Allow `AssetPrice` without `Scale`, treating an absent `Scale` as 0, so that the validator matches XLS-47
and the serializer. The narrow change is to keep rejecting `Scale` without `AssetPrice` (which is still
meaningless) and drop the other half of the XOR at lines 143-151.

If the stricter pairing is wanted for some reason I have not found, then rejecting an explicit `Scale: 0`
client-side with a message that names the omission rule would at least turn a server-side
`invalidTransaction` into something actionable.

## Relation to #3435

Adjacent but distinct. #3435 is about `SCALE_MAX = 10`
([line 17](https://github.com/XRPLF/xrpl.js/blob/af603090aea2cd959741372683e80e2206f24ff9/packages/xrpl/src/models/transactions/oracleSet.ts#L17),
enforced at lines 183-186) blocking the valid range 11-20. This issue is about the bottom of the range
rather than the top, and it is enforced by a different check in the same function. Fixing one does not fix
the other. Our Devnet hashes for the 11-20 boundary belong on #3435 rather than here, and have been posted there.

## Environment

- `xrpl` 5.2.0 (also observed on 5.1.0)
- XRPL Devnet, `wss://s.devnet.rippletest.net:51233`, `network_id` 2
- rippled 3.4.0-rc4 and 3.4.0-rc5
- Captured 2026-09-12 and 2026-09-13

Found while building a vault-solvency oracle on Devnet for the De Vinci Blockchain XRPL Lending Protocol
Hackathon (12-13 September 2026).
