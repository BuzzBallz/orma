# Orma

A lending vault on XRPL Devnet took 51 XRP, lent 10, and the borrower stopped paying. The manager wrote the
loan down, the unit fell from 1.000000 to 0.803922, and the transaction metadata that every indexer diffs
came back with `PreviousFields: {}`, an empty change set. Orma is a credit measurement, publication and
enforcement layer for XLS-65 vaults and XLS-66 lending that reads solvency from ledger state instead of from
metadata diffs, publishes the result as a native XLS-47 Oracle object and as a pointer inside the share
token's own metadata, and lets an independent third party gate deposits on it through XLS-70 credentials.

**The asymmetry.** The party who decides *when* a vault recognises a loss is the same party who decides *in
what order* those losses are realised. The `LoanBroker` owner is necessarily the vault owner, by protocol.
Both decisions move money from investors to them, and neither is visible with the standard tools. Orma
measures both, publishes them, and enforces on them. One asymmetry, two levers, then enforcement.

---

## Compliance

| | |
|---|---|
| Track | **2**, closed-ended vault, Lending Protocol V1.1 |
| Flavour | **Loaded**: XLS-65 and XLS-66, plus XLS-47 Price Oracle, XLS-70 Credentials, XLS-80 Permissioned Domains, XLS-85 Token Escrow and XLS-33 MPT shares |
| Network | XRPL **Devnet**, `wss://s.devnet.rippletest.net:51233`, `network_id` **2** |
| Explorer, faucet | https://devnet.xrpl.org · https://faucet.devnet.rippletest.net/accounts |
| `rippled` | **3.4.0-rc5** |
| Libraries | `xrpl` **5.2.0** with `ripple-binary-codec` **2.11.0**, `decimal.js` **10.6.0**; frontend `xrpl-connect` **0.8.2**, React 19, Vite |
| Runtime | Node **24.13.0** |
| Team | **BuzzBallz** |

The brief pins `xrpl.js@5.2.0-beta.0`. Stable `5.2.0` was published on 11 September 2026 at 22:20 UTC, before
the event opened, and supersedes it, so the project pins the stable release.

Devnet is not a convenience. The lending amendments are not on Mainnet, so Devnet is the only network where
XLS-65 and XLS-66 exist. XLS-47, the publication rail, *is* live on Mainnet today; the measurement and the
gate are not deployable until the lending amendments ship.

---

## Transactions used

Every transaction type the project submits, grouped by the standard it belongs to. Each one links to validated
Devnet transactions the project submitted during the event; the full record is under
[Verified on-chain transactions](#verified-on-chain-transactions).

### XLS-65, Single Asset Vault (amendment `SingleAssetVault`)

| Transaction | What Orma uses it for | Verified on Devnet |
|---|---|---|
| `VaultCreate` | Creates each demo facility. All four are closed-ended: `VaultKind=1` with `SubscriptionDate` and `RedemptionDate`, because `LoanBrokerSet` returns `tecNO_PERMISSION` otherwise, and `VaultKind` is immutable. | [Meridian](https://devnet.xrpl.org/transactions/D07C59257F0C568DAF401C4253E8609C206B900F838289E9B45B418F7DE4807C) · [Kestrel](https://devnet.xrpl.org/transactions/0AD99C9FC08A84FE743061488024FFFE7ED8ECBD034A73F007444523B283A258) · [Calder](https://devnet.xrpl.org/transactions/1819ECF651E1CFFA424E8F5890AF73FFCC61C552C22E580AE2DBE9CF9CDDC69E) · [Thorne](https://devnet.xrpl.org/transactions/3FC79BF77240B0D52148428DABEAC0A5F4971957ABEC1D429ABDF297470F2461) |
| `VaultDeposit` | Subscribes investor capital, and is the transaction the XLS-70 gate admits or refuses at Thorne. | [Meridian](https://devnet.xrpl.org/transactions/3ACF03E8E5E68CD30814694CC7CD5C4BBE67E2EA396EF61EA8C756063892AA8C) · [Thorne, admitted](https://devnet.xrpl.org/transactions/7FC5C01BD735E9A41A0AC6ACFA4B6994B1347A8FA06DAEF8012A62B0E1DF98AF) · [Thorne, refused `tecNO_AUTH`](https://devnet.xrpl.org/transactions/E7CF5DB29DFE652801F4936C11D50A493EB3C474D6EEDFE9FC24394E8DD26101) · [wrong phase `tecEXPIRED`](https://devnet.xrpl.org/transactions/7A10D8053FEE687A008F17E2AD98121EE08553CBDEAAE92DDEC3C2798A1CB15B) |
| `VaultWithdraw` | Redemption. Also the proof that revoking a credential closes entry without trapping the exit. | [Thorne, after revocation](https://devnet.xrpl.org/transactions/2E71A25973D55E26C8AECFDFDF1EF3BF0571B8FB4DD9D524B6A8C750994F39FE) · [Redemption](https://devnet.xrpl.org/transactions/D26222EC26111FFC4F77D3CCADE0FDD2E7C2B9710B9D3957CC4CB725EF58A734) · [wrong phase `tecTOO_SOON`](https://devnet.xrpl.org/transactions/CC104682C298DFB3619EE4C15F0112ACE2B6A95B4971CA0A0AC748F9B5B6617A) |

### XLS-66, Lending Protocol (amendments `LendingProtocol`, `LendingProtocolV1_1`)

| Transaction | What Orma uses it for | Verified on Devnet |
|---|---|---|
| `LoanBrokerSet` | Creates the `LoanBroker`. Its owner is necessarily the vault owner, which is the asymmetry the whole project measures. | [Meridian](https://devnet.xrpl.org/transactions/14CBC3F22EC25532DE74D3EB7758F7A1BB710B0F7ABA3C18C0A4DAC8EAE2785C) · [Kestrel](https://devnet.xrpl.org/transactions/E3D4366469498DDBFC60BC05AF582C18D829B27C52A7224CBE2A58A54B0896AF) · [open-ended vault `tecNO_PERMISSION`](https://devnet.xrpl.org/transactions/CE477E29A099A6BBC30EBA52F3E09AB2A450CDB05F338AE517EDAAC0584827AB) |
| `LoanBrokerCoverDeposit` | Posts the first-loss cover whose consumption the ordering lever moves. | [Meridian](https://devnet.xrpl.org/transactions/C9483EBB8CD46DA7C6AA9A3E465FC2213E252D8C953F7AF6C347B032D14BB958) · [Kestrel](https://devnet.xrpl.org/transactions/E979EB6D211701C6B8BD66F7D4F3AD1A98388029414BF17FF70D092B74D2B76A) · [Calder](https://devnet.xrpl.org/transactions/13ECAC8451FB861723953DFE8BA9EC8B642A14FA5255943E7C7B1349EB1DD562) |
| `LoanSet` | Originates each loan, counterparty-signed. Under cash-basis accounting (`LEVersion=1`) origination moves `DebtTotal`, not `AssetsTotal`. | [Meridian](https://devnet.xrpl.org/transactions/1523BD1B1548A01B46AAA88871EA965EE973BFA7016D7B8ACC950E463567AA4A) · [Kestrel, first](https://devnet.xrpl.org/transactions/525FC003CF1D4C99B82E876DE945000A681230D4312C03DE1120EA9F905118AB) · [Kestrel, second](https://devnet.xrpl.org/transactions/30B97AA397678AF36EDA7604582789C76F1F1B3B1083F453F95FB3107796A06B) · [wrong phase `tecTOO_SOON`](https://devnet.xrpl.org/transactions/E1121DED12D4A320FB58F77D02549429885D8A826B794F2B2539EC936BE39011) · [wrong phase `tecEXPIRED`](https://devnet.xrpl.org/transactions/8A09A988DD3C5433B30E92F5E7B42086D6B17CEB51C6C05572E7A74552B9DAE1) |
| `LoanManage` | Impairs (`Flags 0x20000`) and defaults (`Flags 0x10000`). These are the two levers. Only the broker owner may submit either. | [impair, Meridian](https://devnet.xrpl.org/transactions/075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3) · [impair, Calder](https://devnet.xrpl.org/transactions/BD18EFB94490CA540E7A9C249971740C1228D1FBC3ED97C9BA9F4908F52D5F4F) · [default, Kestrel, larger](https://devnet.xrpl.org/transactions/FB23EC5313F85FA157D56966E0B0B1665068905988D925C70BB0E7C35C3B221B) · [default, Kestrel, smaller](https://devnet.xrpl.org/transactions/DE49DF0D6136B96AD28B253CD32100E5715078FD2D0AE6D1DB747AFECB803D1F) |

### XLS-47, Price Oracles (amendment `PriceOracle`)

| Transaction | What Orma uses it for | Verified on Devnet |
|---|---|---|
| `OracleSet` | Publishes the six-dimension score, one `PriceData` entry per dimension: `NAV`, `HDL`, `LIQ`, `COV`, `CNC`, `DDL`. The base asset is derived from the vault id. | [first publication](https://devnet.xrpl.org/transactions/DC5754D2EE4A6A7AB9233EA3EE704A9C2FD97FA06C80EA364E5D4811CAD75255) |
| `OracleDelete` | Retires a document id. `OracleSet` is not a merge, so a stale document accumulates pairs until nothing can be published at all. | [recovery](https://devnet.xrpl.org/transactions/37A65CF8C94687C8B39EA66E92D777477F0088196153BEB82807CD58975F4347) |

### XLS-70, Credentials (amendment `Credentials`)

| Transaction | What Orma uses it for | Verified on Devnet |
|---|---|---|
| `CredentialCreate` | Issues the grade, credential type `ORMA-IG`. The subject's consent is not required to issue. | [issue](https://devnet.xrpl.org/transactions/619CC767741EFF1EA4DD8AD36F7CB400AE2175540CEC600751E565A73891B26B) |
| `CredentialAccept` | The subject accepts, which is what makes the credential usable inside a domain. | [accept](https://devnet.xrpl.org/transactions/41F98989B64BD7329118B29B5FCB3AD148DF5520171A3A94259AC4CB51C9ED07) |
| `CredentialDelete` | Revocation. Entry closes, the exit stays open. | [revoke](https://devnet.xrpl.org/transactions/E2D6F396F4A92DE4F36BDF6FD360EC8C849D4ED9DFDF8585998161098DE8C86D) |

### XLS-80, Permissioned Domains (amendment `PermissionedDomains`)

| Transaction | What Orma uses it for | Verified on Devnet |
|---|---|---|
| `PermissionedDomainSet` | An independent vault owner names Orma's issuer as an accepted credential. We signed nothing, and we cannot decline. | [Thorne domain](https://devnet.xrpl.org/transactions/4C425830675B021EB8A74904783D1DBDE516C74534C76E84A2899695DF3D87F9) |

### Supporting standards

| Transaction | Standard | What Orma uses it for | Verified on Devnet |
|---|---|---|---|
| `MPTokenAuthorize` | XLS-33 MPT (`MPTokensV1`) | Lets a second lender hold a vault's share token before it is pledged. | [second lender](https://devnet.xrpl.org/transactions/4D3A062391D872BD3581AA421A9B4DE68058E1CFCC0CA21A8FE61D480C7E3B93) |
| `EscrowCreate` | XLS-85 TokenEscrow (`TokenEscrow`) | Pledges vault shares on ledger to a second lender. That pledge is what Orma prices. | [pledge](https://devnet.xrpl.org/transactions/3322B9214FB87822BA5699423691DAED4A043121D1E17080673F6292E01C1536) |
| `DelegateSet` | XLS-75 Permission Delegation (`PermissionDelegationV1_1`) | Positive control for a finding: delegating `Payment` succeeds, while every lending permission is refused `temMALFORMED` before reaching a ledger. | [positive control](https://devnet.xrpl.org/transactions/547DA71992D469ACA345A0B3CEAD07864E2801919201B256EA606C3A7910AF17) |

---

## Verified on-chain transactions

Every hash below is a validated transaction on XRPL Devnet (`network_id` 2), submitted by this project
during the event and re-read from the ledger with `tx` and `account_tx` on 13 September 2026. The links
open the public explorer at https://devnet.xrpl.org. Devnet keeps roughly 29 days of history.

### Meridian Trade Finance I, the empty change set

The full closed-ended lifecycle: create, subscribe, attach the broker, post first-loss cover, originate in Investment, then the impairment whose metadata comes back with `PreviousFields: {}`.

| | Transaction | Result | Validated (UTC) | Explorer |
|---|---|---|---|---|
| 1 | `VaultCreate` | `tesSUCCESS` | 2026-09-12 21:05:02Z | [`D07C5925…E4807C`](https://devnet.xrpl.org/transactions/D07C59257F0C568DAF401C4253E8609C206B900F838289E9B45B418F7DE4807C) |
| 2 | `VaultDeposit` | `tesSUCCESS` | 2026-09-12 21:05:11Z | [`3ACF03E8…92AA8C`](https://devnet.xrpl.org/transactions/3ACF03E8E5E68CD30814694CC7CD5C4BBE67E2EA396EF61EA8C756063892AA8C) |
| 3 | `LoanBrokerSet` | `tesSUCCESS` | 2026-09-12 21:05:20Z | [`14CBC3F2…E2785C`](https://devnet.xrpl.org/transactions/14CBC3F22EC25532DE74D3EB7758F7A1BB710B0F7ABA3C18C0A4DAC8EAE2785C) |
| 4 | `LoanBrokerCoverDeposit` | `tesSUCCESS` | 2026-09-12 21:05:22Z | [`C9483EBB…4BB958`](https://devnet.xrpl.org/transactions/C9483EBB8CD46DA7C6AA9A3E465FC2213E252D8C953F7AF6C347B032D14BB958) |
| 5 | `LoanSet` | `tesSUCCESS` | 2026-09-12 21:05:32Z | [`1523BD1B…67AA4A`](https://devnet.xrpl.org/transactions/1523BD1B1548A01B46AAA88871EA965EE973BFA7016D7B8ACC950E463567AA4A) |
| 6 | `LoanManage`, impair | `tesSUCCESS` | 2026-09-12 21:07:52Z | [`075FE6D2…9229C3`](https://devnet.xrpl.org/transactions/075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3) |

### Kestrel Bridge Financing II, the ordering lever

Two loans originated, then both defaulted, the larger first. Cover consumed: 0.40 XRP on the first default and 0.10 XRP on the second.

| | Transaction | Result | Validated (UTC) | Explorer |
|---|---|---|---|---|
| 1 | `VaultCreate` | `tesSUCCESS` | 2026-09-12 21:08:12Z | [`0AD99C9F…83A258`](https://devnet.xrpl.org/transactions/0AD99C9FC08A84FE743061488024FFFE7ED8ECBD034A73F007444523B283A258) |
| 2 | `VaultDeposit` | `tesSUCCESS` | 2026-09-12 21:08:21Z | [`68D3787A…5B96DD`](https://devnet.xrpl.org/transactions/68D3787A20E1DB97EF6B55AAADBF4EF284727D159F7C65C09223FFD61A5B96DD) |
| 3 | `LoanBrokerSet` | `tesSUCCESS` | 2026-09-12 21:08:30Z | [`E3D43664…0896AF`](https://devnet.xrpl.org/transactions/E3D4366469498DDBFC60BC05AF582C18D829B27C52A7224CBE2A58A54B0896AF) |
| 4 | `LoanBrokerCoverDeposit` | `tesSUCCESS` | 2026-09-12 21:08:32Z | [`E979EB6D…D2B76A`](https://devnet.xrpl.org/transactions/E979EB6D211701C6B8BD66F7D4F3AD1A98388029414BF17FF70D092B74D2B76A) |
| 5 | `LoanSet` | `tesSUCCESS` | 2026-09-12 21:08:42Z | [`525FC003…5118AB`](https://devnet.xrpl.org/transactions/525FC003CF1D4C99B82E876DE945000A681230D4312C03DE1120EA9F905118AB) |
| 6 | `LoanSet` | `tesSUCCESS` | 2026-09-12 21:08:51Z | [`30B97AA3…96A06B`](https://devnet.xrpl.org/transactions/30B97AA397678AF36EDA7604582789C76F1F1B3B1083F453F95FB3107796A06B) |
| 7 | `LoanManage`, default | `tesSUCCESS` | 2026-09-12 21:11:02Z | [`FB23EC53…3B221B`](https://devnet.xrpl.org/transactions/FB23EC5313F85FA157D56966E0B0B1665068905988D925C70BB0E7C35C3B221B) |
| 8 | `LoanManage`, default | `tesSUCCESS` | 2026-09-12 21:11:10Z | [`DE49DF0D…803D1F`](https://devnet.xrpl.org/transactions/DE49DF0D6136B96AD28B253CD32100E5715078FD2D0AE6D1DB747AFECB803D1F) |

### Calder Structured Credit III, the token that prices itself

The `VaultCreate` here carries the share token's XLS-89 metadata and its valuation pointer.

| | Transaction | Result | Validated (UTC) | Explorer |
|---|---|---|---|---|
| 1 | `VaultCreate` | `tesSUCCESS` | 2026-09-12 21:11:31Z | [`1819ECF6…DDC69E`](https://devnet.xrpl.org/transactions/1819ECF651E1CFFA424E8F5890AF73FFCC61C552C22E580AE2DBE9CF9CDDC69E) |
| 2 | `VaultDeposit` | `tesSUCCESS` | 2026-09-12 21:11:41Z | [`49CE7BCB…01A9F8`](https://devnet.xrpl.org/transactions/49CE7BCBD34636EE1B6AACB62EB441C0FC6BC82862E7BA947D6290C31401A9F8) |
| 3 | `LoanBrokerSet` | `tesSUCCESS` | 2026-09-12 21:11:50Z | [`7C49B287…93A1BF`](https://devnet.xrpl.org/transactions/7C49B28754CB04FFE11214E7388AA7DE217E73AC550EA85F9C0221A1D193A1BF) |
| 4 | `LoanBrokerCoverDeposit` | `tesSUCCESS` | 2026-09-12 21:11:51Z | [`13ECAC84…1DD562`](https://devnet.xrpl.org/transactions/13ECAC8451FB861723953DFE8BA9EC8B642A14FA5255943E7C7B1349EB1DD562) |
| 5 | `LoanSet` | `tesSUCCESS` | 2026-09-12 21:12:01Z | [`16BC60F5…38291E`](https://devnet.xrpl.org/transactions/16BC60F5B9AA7D48E23E166F27CE681F96797C0639C6F996496EB50F1538291E) |
| 6 | `LoanManage`, impair | `tesSUCCESS` | 2026-09-12 21:14:22Z | [`BD18EFB9…2D5F4F`](https://devnet.xrpl.org/transactions/BD18EFB94490CA540E7A9C249971740C1228D1FBC3ED97C9BA9F4908F52D5F4F) |

### Thorne Senior Secured I, the gate

An unrelated vault owner names our credential issuer in their Permissioned Domain. The ledger then admits
the graded investor and refuses the ungraded one, and after revocation it refuses entry but still allows
the exit.

| | Step | Transaction | Result | Explorer |
|---|---|---|---|---|
| 1 | CredentialCreate | `CredentialCreate` | `tesSUCCESS` | [`619CC767…91B26B`](https://devnet.xrpl.org/transactions/619CC767741EFF1EA4DD8AD36F7CB400AE2175540CEC600751E565A73891B26B) |
| 2 | CredentialAccept (by the LP) | `CredentialAccept` | `tesSUCCESS` | [`41F98989…C9ED07`](https://devnet.xrpl.org/transactions/41F98989B64BD7329118B29B5FCB3AD148DF5520171A3A94259AC4CB51C9ED07) |
| 3 | PermissionedDomainSet | `PermissionedDomainSet` | `tesSUCCESS` | [`4C425830…3D87F9`](https://devnet.xrpl.org/transactions/4C425830675B021EB8A74904783D1DBDE516C74534C76E84A2899695DF3D87F9) |
| 4 | VaultCreate (private + domain) | `VaultCreate` | `tesSUCCESS` | [`3FC79BF7…0F2461`](https://devnet.xrpl.org/transactions/3FC79BF77240B0D52148428DABEAC0A5F4971957ABEC1D429ABDF297470F2461) |
| 5 | VaultDeposit — graded LP | `VaultDeposit` | `tesSUCCESS` | [`7FC5C01B…DF98AF`](https://devnet.xrpl.org/transactions/7FC5C01BD735E9A41A0AC6ACFA4B6994B1347A8FA06DAEF8012A62B0E1DF98AF) |
| 6 | VaultDeposit — ungraded LP | `VaultDeposit` | `tecNO_AUTH` | [`E7CF5DB2…D26101`](https://devnet.xrpl.org/transactions/E7CF5DB29DFE652801F4936C11D50A493EB3C474D6EEDFE9FC24394E8DD26101) |
| 7 | CredentialDelete (revoke) | `CredentialDelete` | `tesSUCCESS` | [`E2D6F396…E8C86D`](https://devnet.xrpl.org/transactions/E2D6F396F4A92DE4F36BDF6FD360EC8C849D4ED9DFDF8585998161098DE8C86D) |
| 8 | VaultDeposit after revocation | `VaultDeposit` | `tecNO_AUTH` | [`AA25246A…2ADDBF`](https://devnet.xrpl.org/transactions/AA25246AE452DF1719751E4F03BAD8B6C286250DE8FB65EC2B7FBBFE272ADDBF) |
| 9 | VaultWithdraw after revocation | `VaultWithdraw` | `tesSUCCESS` | [`2E71A259…4F39FE`](https://devnet.xrpl.org/transactions/2E71A25973D55E26C8AECFDFDF1EF3BF0571B8FB4DD9D524B6A8C750994F39FE) |

### Wrong-phase rejections, Track 2 minimum bar item 5

One closed-ended vault walked through Subscription, Investment and Redemption, with an open-ended vault
for the first three rows. Each rejected
`VaultDeposit`, `VaultWithdraw` and `LoanSet` sits next to a control that succeeds in the phase where the
same transaction is legal. The Investment-phase `LoanSet` returned `tecNO_PERMISSION` because its term
overran the redemption buffer; `feedback/appendix.pdf`, Appendix E, isolates that.

| Phase | Attempt | Expected | Result | Explorer |
|---|---|---|---|---|
| OpenEnded | VaultDeposit (control) | tesSUCCESS | `tesSUCCESS` | [`9D7E7CFE…597D21`](https://devnet.xrpl.org/transactions/9D7E7CFE00A554FA065C30A6147B7619C3627D93B497A1B62C4EC0E49C597D21) |
| OpenEnded | VaultWithdraw (control) | tesSUCCESS | `tesSUCCESS` | [`E394EA9B…F11E61`](https://devnet.xrpl.org/transactions/E394EA9BD518BEE31275EC9ECA8DD4D1DF5837EAD315BD0530F0A4936EF11E61) |
| OpenEnded | LoanBrokerSet on an OPEN vault | reject | `tecNO_PERMISSION` | [`CE477E29…4827AB`](https://devnet.xrpl.org/transactions/CE477E29A099A6BBC30EBA52F3E09AB2A450CDB05F338AE517EDAAC0584827AB) |
| Subscription | VaultDeposit (control) | tesSUCCESS | `tesSUCCESS` | [`202F9600…15F6C1`](https://devnet.xrpl.org/transactions/202F9600CC1D85266FFB27B70F26CE09AB0FE0423D4A8E77FA12F7F8D515F6C1) |
| Subscription | VaultWithdraw (control) | tesSUCCESS | `tesSUCCESS` | [`92558A56…DB3D0B`](https://devnet.xrpl.org/transactions/92558A56C122F770B8601217D905F47B2362D5CF253612136B13815CD7DB3D0B) |
| Subscription | LoanSet | reject | `tecTOO_SOON` | [`E1121DED…E39011`](https://devnet.xrpl.org/transactions/E1121DED12D4A320FB58F77D02549429885D8A826B794F2B2539EC936BE39011) |
| Investment | VaultDeposit at wrong phase | reject | `tecEXPIRED` | [`7A10D805…1CB15B`](https://devnet.xrpl.org/transactions/7A10D8053FEE687A008F17E2AD98121EE08553CBDEAAE92DDEC3C2798A1CB15B) |
| Investment | VaultWithdraw at wrong phase | reject | `tecTOO_SOON` | [`CC104682…B6617A`](https://devnet.xrpl.org/transactions/CC104682C298DFB3619EE4C15F0112ACE2B6A95B4971CA0A0AC748F9B5B6617A) |
| Investment | LoanSet | tesSUCCESS | `tecNO_PERMISSION` | [`A9260300…39F63E`](https://devnet.xrpl.org/transactions/A926030097C2AD2F8ED4D1D6899200B27D2C75DF200A5A2EBEA8EBF88339F63E) |
| Redemption | VaultDeposit at wrong phase | reject | `tecEXPIRED` | [`DEA67094…CAA670`](https://devnet.xrpl.org/transactions/DEA67094F92657625C795FD34B46DF751F2E54B3ECEA1B686777D5C141CAA670) |
| Redemption | VaultWithdraw (control) | tesSUCCESS | `tesSUCCESS` | [`D26222EC…58A734`](https://devnet.xrpl.org/transactions/D26222EC26111FFC4F77D3CCADE0FDD2E7C2B9710B9D3957CC4CB725EF58A734) |
| Redemption | LoanSet | reject | `tecEXPIRED` | [`8A09A988…B9DAE1`](https://devnet.xrpl.org/transactions/8A09A988DD3C5433B30E92F5E7B42086D6B17CEB51C6C05572E7A74552B9DAE1) |

### Publication, collateral and delegation

| What | Transaction | Result | Explorer |
|---|---|---|---|
| First publication of the six-dimension score | `OracleSet` | `tesSUCCESS` | [`DC5754D2…D75255`](https://devnet.xrpl.org/transactions/DC5754D2EE4A6A7AB9233EA3EE704A9C2FD97FA06C80EA364E5D4811CAD75255) |
| Recovery from a document id full of stale pairs | `OracleDelete` | `tesSUCCESS` | [`37A65CF8…5F4347`](https://devnet.xrpl.org/transactions/37A65CF8C94687C8B39EA66E92D777477F0088196153BEB82807CD58975F4347) |
| A second lender authorises the vault share token | `MPTokenAuthorize` | `tesSUCCESS` | [`4D3A0623…7E3B93`](https://devnet.xrpl.org/transactions/4D3A062391D872BD3581AA421A9B4DE68058E1CFCC0CA21A8FE61D480C7E3B93) |
| Vault shares pledged on ledger to that lender | `EscrowCreate` | `tesSUCCESS` | [`3322B921…1C1536`](https://devnet.xrpl.org/transactions/3322B9214FB87822BA5699423691DAED4A043121D1E17080673F6292E01C1536) |
| Delegation positive control: `Payment` delegates, the lending permissions return `temMALFORMED` and never reach a ledger | `DelegateSet` | `tesSUCCESS` | [`547DA719…10AF17`](https://devnet.xrpl.org/transactions/547DA71992D469ACA345A0B3CEAD07864E2801919201B256EA606C3A7910AF17) |

The live Oracle object for Kestrel is `C67EBC7A…80DCC1`, published by
[`rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B`](https://devnet.xrpl.org/accounts/rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B).
`devnet.xrpl.org` has no route for a bare ledger index, so fetch the object itself rather than
following a link to it:

```json
{ "command": "ledger_entry", "oracle": { "account": "rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B", "oracle_document_id": 3 } }
```

Two publishers disagree about Meridian on purpose, so `get_aggregate_price` has something to
aggregate: ours reads the vault object and reports `0.803922`, a second account diffs metadata
and reports `1.000000`, and rippled returns a median of `0.901961` across the two. The capture is
in [`demo/oracle-aggregate.json`](demo/oracle-aggregate.json) with the request to reproduce it.

---

## The four live Devnet facilities

Each was originated, serviced, impaired or defaulted on live Devnet, and its capture is committed. The
reader loads all four at startup.

### 1. Meridian Trade Finance I, the empty change set

```
vault   864C5A2DDCED78C6198B0703169D533B747A56E5F9398D832033F79E37E8C835
broker  41BD2EA81CD03ED9EAC612BFFC6179AC742120FC4A5E0DD1D3E4DCE7DB5B2F38
impair  075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3
file    demo/indexer-race.json
```

`LossUnrealized` moved from 0, and rippled omits from `PreviousFields` any field whose previous value was the
type default. Under cash-basis accounting nothing else on the Vault object changes. The metadata is
therefore emitted empty: an indexer that diffs it sees a node touched but unchanged. Naive NAV reads
`1.000000`. Net of the recognised loss it is `0.803922`. **1961 basis points apart, on the same transaction,
from the same ledger.**

### 2. Kestrel Bridge Financing II, the ordering lever

```
vault   24EAA01AD4CE70D8ABB4ACB4255DC4C216B8AF3B9E7315DB8052BFC1E5810089
broker  8DB104980C31CBE9F196508E7D748E8C31FB783CD4E0A3620AE0B476CBDEA3FA
file    demo/ordering-vault.json
```

Cover liquidated on a default is sized against the broker's **total** book, not against the loan that
defaulted, and the book is decremented as each default lands. So the order of declaration changes the total.
Two bad loans of 30 XRP and 10 XRP, declared largest first, consumed **0.50 XRP** of the manager's own
first-loss capital. Smallest first would have consumed **0.70 XRP**. Same losses, same rates, only the order.
The **0.20 XRP** difference is investor money, and the party who chose the order is the party it spared.

By the rearrangement inequality this is general, not an artefact of these two numbers: total cover consumed
is minimised by declaring the largest exposure first. Conduct grade **E**, findings
`ORDERING_SELF_SERVING` and `DEFAULT_WITHOUT_IMPAIRMENT`. The facility destroyed **79% of subscribed
capital**, which notches the composite from an AAA anchor down 14 steps to **B**.

### 3. Calder Structured Credit III, the token that prices itself

```
vault     5763707D11EA19D1B5FF04E4EBA4F9336057955CDE65B725D1FF3EF2A96CB0E5
broker    1C160EFFCA8208DFD8CE9B065A3C3C41CCA80758FBC3099BE27AACFBD1478173
shareMPT  000000014D667775372D5B78E07FFF294678C7F9CE82AFBC
impair    BD18EFB94490CA540E7A9C249971740C1228D1FBC3ED97C9BA9F4908F52D5F4F
file      demo/metadata-vault.json
```

The share token carries a valuation pointer in its own MPT metadata. An investor pledges units to a second
lender who holds a token and nothing else; that lender reads the token's metadata, follows the declared
`nav_url`, and prices the pledge in five steps, none of which involve a relationship with us. A pledge of
1,000,000 units prices at **1.000000 XRP** naively and **0.803922 XRP** on what the instrument points to.
**0.196078 XRP of overstatement kept out of the second lender's book.** A haircut absorbs volatility; it does
not absorb a misstatement. This manager impaired the loan and has written nothing off, which the
conduct assessment scores **A** against Kestrel's E.

### 4. Thorne Senior Secured I, enforcement

```
vault   4A5A8E3716D52E334AEB077ADB09456EF4A941CC26021A8EAD37F95B00190DF5
domain  FFBEC89D98B4E7CF52F4F254235086514A90CED0EC531941BDF747AF40C5A2FB
issuer  rKQjjU5KFs9RAZCDvYVjcaoVK5gGsCJgkP, credential type ORMA-IG
file    demo/gate-vault.json
```

An unrelated vault owner named our credential issuer in their `PermissionedDomain` and bound the domain to
their vault. Two investors, same second: the graded one deposited, the ungraded one was refused **by the
ledger**, not by us. When the credential is revoked, `VaultDeposit` is refused and `VaultWithdraw` still
succeeds. A rater who could trap capital would be a worse problem than the one we solve.

---

## Running it

Node 24.13.0 (Node 20 or later works). The reader needs outbound access to Devnet and no keys: every
facility it serves is public ledger state.

```bash
npm ci               # the committed lockfile, exactly: xrpl 5.2.0, ripple-binary-codec 2.11.0, decimal.js 10.6.0
node src/index.mjs   # or: npm start
```

Use `npm ci`, not `npm install`. The lockfile is the toolchain we verified against live Devnet, and
re-resolving it can move `ripple-binary-codec`, the package that serializes closed-ended vaults.

The reader auto-discovers the baked facilities: it reads every `demo/*.json`, takes the `vaultId` and
`label` from each, and serves all four without a single hex id being typed. Explicit
`--vault <64-hex>[:label]` arguments, or `VAULTS=<id>,<id>`, override the discovery. The API listens on
`http://localhost:8787` and the reader re-reads full vault state every 4 seconds.

```bash
cd app && pnpm install && pnpm dev
```

The frontend comes up on `http://localhost:5173` and talks to port 8787.

Optional and off by default: set `PUBLISH_SEED=s...` to publish the score to the ledger as XLS-47 Oracle
objects. Reading correctly is the product; publishing is distribution, and a missing seed must never stop
the reader from starting.

Each `check:*` script proves one claim:

```bash
npm run check:ordering   # the cover-ordering arithmetic, offline, against the figures measured on Devnet
npm run check:history    # broker history reconstruction, live; funds fresh Devnet accounts from the faucet
npm run check:oracle     # XLS-47 publication round trip, live; funds a fresh publisher from the faucet
```

The HTTP API is documented in `documentation/pages/http-api.mdx`:

```
GET  /api/health
GET  /api/vaults
GET  /api/vaults/:vaultId
GET  /api/vaults/:vaultId/nav
GET  /api/vaults/:vaultId/collateral
GET  /api/vaults/:vaultId/broker-history
GET  /api/vaults/:vaultId/gate
GET  /api/mpt/:mptIssuanceId/nav          # CORS-open: called by a party with no relationship to us
GET  /api/mpt/:mptIssuanceId/resolve      # CORS-open
```

### Deploying

The backend is a long-running process, a 4-second reader over a WebSocket, so it runs as a container. The
frontend is static and runs on Vercel.

**Backend.** `Dockerfile`, `render.yaml` and `railway.json` are at the root; no CLI is needed for either
platform. On **Render**: New, then Blueprint, then this repository. It reads `render.yaml`, builds the image,
injects `PORT`, health-checks `/api/health`, and asks only for the two values marked `sync: false`. On
**Railway**: create a service from this repository and generate a public domain for it. Any other Docker
host works the same way:

```bash
docker build -t orma-api . && docker run -p 8787:8787 orma-api
```

| Variable | Required | What it does |
|---|---|---|
| `PORT` | set by the platform | The port the API listens on, 8787 by default. |
| `XRPL_WS` | no | Devnet WebSocket, `wss://s.devnet.rippletest.net:51233` by default. |
| `PUBLISH_SEED` | no | Publishes the score as XLS-47 Oracle objects from that account. Set it on **one** running instance only: two processes publishing from the same account race each other for sequence numbers. Without it, every figure is still served and the oracle field reads `null`. |
| `DEMO_KEY` | no | Opens the operator routes to requests carrying a matching `x-demo-key`. Without it they answer loopback only, which in a container means nobody. |
| `VAULTS` | no | Comma-separated vault ids, overriding the facilities discovered in `demo/`. |

**Frontend.** Import the repository into Vercel with **Root Directory `app`**; `app/vercel.json` already
sets the Vite build and the single-page rewrite.

| Variable | Value |
|---|---|
| `VITE_API_BASE` | The backend's public URL. It must be `https://`: an https page cannot call http. |
| `VITE_XRPL_NETWORK` | `devnet` |
| `VITE_DOCS_URL` | Optional. Defaults to https://ormaprotocol.mintlify.site/. |

`VITE_` variables are inlined into the bundle at build time, so changing one needs a redeploy, and no
secret may ever be one.

---

## Repository map

### `src/`, the backend

Plain ESM `.mjs` with JSDoc typedefs, no build step.

| File | What it does |
|---|---|
| `index.mjs` | Entrypoint. Facility discovery, reader, API, optional oracle publishing. |
| `poll.mjs` | The 4-second reader. Re-reads the `Vault` SLE every tick and never diffs `PreviousFields`. |
| `score.mjs` | The five measured factors and the ordinal notching. No weights anywhere: a weighted average lets a strong factor pay for a broken one. |
| `history.mjs` | Broker history reconstruction and the cover-ordering mathematics. |
| `nav.mjs`, `collateral.mjs` | NAV both ways, and pledge valuation against escrowed shares. |
| `metadata.mjs` | Reads and writes the share token's valuation pointer. |
| `oracle.mjs` | The XLS-47 publisher and the four invariants that corrupt data silently rather than erroring. |
| `credentials.mjs` | XLS-70 issuance and acceptance, and the XLS-80 domain. |
| `api.mjs` | The frozen HTTP contract. |
| `num.mjs` | `decimal.js` at precision 40. No `Number()` and no `parseFloat` ever touches a monetary value. |
| `demo/` | The bakers that create each facility on Devnet, plus the phase matrix and the collateral scenario. |
| `dev/` | `check-*` scripts, each proving one claim against live Devnet. |

### `app/`, the frontend

React 19, Vite, Tailwind, TypeScript. Screens: Portfolio, Facility, Evidence, PledgeResolution, EntryGate,
Methodology, Event. It polls the backend and renders the same numbers the API serves, with the notch trace
that produced each grade.

### `demo/`

The four captured facilities, one JSON file each, with vault ids, transaction hashes, the readings and the
verdict, plus `delegation.json`, the delegation probe and its positive control. These are committed artefacts: the Evidence screen renders from them and needs no API.

### `contrib/`

`contrib/tutorial-fix/` is our code contribution upstream: a Devnet-proven fix for the official XRPL lending
tutorial. `lendingSetup.js` creates an open-ended vault, `submitAndWait` does not throw on a `tec`, and
`.find()` over the metadata returns `undefined`, so the script dies at `Setting up tutorial: 5/7` with a
`TypeError` rather than a result code. All six *Use the Lending Protocol* tutorials run it first, so all six
are currently un-followable. The directory holds the diff, the ready-to-paste PR body, a full run log, the
before and after scripts, and the upstream sources it was taken from.

### `paper/`

`orma-paper.pdf` is the technical paper, fourteen pages, compiled from `orma-paper.tex`. It states the
arithmetic the protocol runs on so a reader can check it rather than read JavaScript: the two net asset
value readings and why the naive one is not merely lazy, the cover liquidation formula and its three
non-obvious properties, and the ordering result as a theorem with its proof. Every measured figure in it
was read from live Devnet during the event, and every claim carries a transaction hash.

### `documentation/`

The protocol documentation, ten pages of Mintlify MDX plus its configuration. It is published at
https://ormaprotocol.mintlify.site/. `build.mjs` renders the same source into a static site and
`deploy.sh` publishes that to GitHub Pages, so the pages survive the loss of the Mintlify account.

### `deck/`

`content.md` is the ten-slide presentation, timed to four minutes, and `build.mjs` turns it into a
self-contained deck that opens in a browser and prints to PDF. No slide toolchain to install.

### `FEEDBACK.pdf` and `feedback/`

`FEEDBACK.pdf` is the developer feedback report: **three pages**, written from the build, signed. It is
short on purpose, because it is read by someone who did not ask for it.

Its evidence is `feedback/appendix.pdf`, the full 40-finding register — 33 pages, every claim carrying a
transaction hash, repro steps and tracker status.

`feedback/` holds what both are made of. `feedback.html` is the report, `register.md` is the register, and
`build.mjs` renders each into its own PDF with headless Chrome, refusing to stay quiet if the report ever
grows past three pages:

```bash
node feedback/build.mjs
```

---

## Developer feedback

**40 findings: 7 P0, 19 P1, 14 P2.** Three more were withdrawn after cross-checking, and are listed as
withdrawn rather than deleted. Every finding carries a component, a severity, a status against the live
trackers, and a Devnet repro.

The three that cost us the most:

1. **The metadata hides the one credit event that matters.** The first impairment of a healthy vault emits
   `PreviousFields: {}` while `FinalFields` carries a non-zero `LossUnrealized`. This was raised before us
   as `rippled#6487` by the operator of an XRPL explorer, and closed by its reporter the same day as
   not-a-bug. That was half right: it is correct metadata, and it is still a silent wrong answer for every consumer downstream.
2. **The documented first hour cannot complete.** The fix, verified green on rc5, is in `contrib/tutorial-fix`.
3. **A broker's action history cannot be reconstructed by filtering.** `LoanManage` carries no
   `LoanBrokerID`, and an impairment does not touch the `LoanBroker` object at all, so a filter over
   `account_tx` silently drops every impairment. `Loan.FinalFields.LoanBrokerID` in the same metadata closes
   the join. Before that fix, every default looked unsignalled, and the conduct rule written to reward
   disclosure was penalising it. That one shipped a wrong answer inside our own code before we caught it.

The register is `feedback/appendix.pdf`. The contribution is `contrib/tutorial-fix/`.

---

## Team

**Alexandre Lemiere**, backend, protocol, research.
**Andrea Gonzalez**, frontend.

Team BuzzBallz. De Vinci Blockchain XRPL Lending Protocol Hackathon, Paris, 12 and 13 September 2026.
