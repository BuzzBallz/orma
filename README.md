# Orma

## Built in New York

At the XRPL hackathon in New York, on 24–25 October 2026, we built **Orma Desk**. It sits on the information
layer this README describes further down: the vault reader, the withdrawal value and the XLS-47 publisher,
built in Paris in September 2026.

A closed-ended XLS-65 vault refuses every withdrawal until its redemption date (`VaultWithdraw` returns
`tecTOO_SOON`). A holder who needs XRP before then has to sell the shares or borrow against them, and either
way someone must price a share the vault will not yet redeem. The price everyone reads, `AssetsTotal /
shares`, ignores the losses the vault has already recognised. At ledger 6387294, a share of the Harbor-1
vault, which redeems on 10 November 2026, read 1.000000 that way and was worth 0.800000.

Orma Desk is a credit desk that lends XRP against such shares, and it values them at one price only: their
withdrawal value, the XLS-65 withdraw rate `(AssetsTotal − LossUnrealized) / shares`, read at a validated
ledger. The borrower pledges the shares through an XLS-85 escrow into a 2-of-3 account. Its three keys belong
to the borrower, the desk and the Orma agent, a program that co-signs only what a published rule allows, and
any two of them move the shares. The desk refuses the loan with `409 BREACHED` when the risk officer's
mandate does not hold: its limits on loan-to-value, loan size, loss in a default and lock-up. It runs against
XRPL Devnet, the network where the lending amendments are live, at
[ormaprotocol.com/desk](https://ormaprotocol.com/desk).

Where the event's work starts, and how to check that without trusting us: [HACKATHON.md](HACKATHON.md). The
diff is [`nyc-start...main`](https://github.com/BuzzBallz/orma/compare/nyc-start...main), or
`git log --oneline nyc-start..main` in a clone. Each build step is one commit and one tag, from
`step-01-contract` on.

| Part | What it does | Offline check |
|---|---|---|
| Risk ticket, `orma.ticket/1` | For a share and a mandate: the withdrawal value beside the value read by all, the loss if each late loan defaults alone, the lock-up, the largest loan the mandate allows, and the verdict. Every figure names its formula and the ledger index and hash of each input, so anyone can recompute it. | `node src/dev/check-ticket.mjs` |
| Desk signer | Countersigns a `LoanSet` only after reading again, at the ledger it signs at, the escrow the loan's memo names, the 2-of-3 account and the ticket. Each decision goes into a hash-chained log. | `node src/dev/check-desk.mjs` |
| Change engine, `orma.change/1` | Before a transaction is signed, every field it will change, including the ones its metadata leaves out of `PreviousFields`, each with the rippled 3.4.1 file and line that sets it; after validation, MATCH or MISMATCH per field. | `node src/dev/check-change.mjs` |
| Release rule and auditor | The public rule that sends pledged shares to the desk after a default or back to the borrower after repayment, the guard on what the Orma agent co-signs, and a read-only auditor of the desk's log and collateral accounts. | `node src/desk/audit.mjs --self-test` |
| Role engine, desk screens, Feed, Universe | Named actions previewed by `simulate` and submitted through one queue per signing account; credit events derived from two full reads of a vault; every vault on file or seen in the transaction stream, read at one ledger. | `npm test` |

### The event's transactions on Devnet

Each link below is a validated Devnet transaction of the event, captured as JSON and as binary in
[`evidence/devnet-tx/`](evidence/devnet-tx/). Devnet nodes prune their history, so a node may no longer serve
a past ledger: the proof is the hash and its capture, not a fresh read.

The three Harbor vaults are fictional credit facilities. Their own loans, L1 and L2, are what produce their
losses. The desk lends against Harbor shares out of the `desk` vault, and in the chain test out of `spare`.

| Vault | Created | Loans L1 and L2 | L1 impaired | Manager's statement |
|---|---|---|---|---|
| Harbor-1 | [FBD87DF2…](https://devnet.xrpl.org/transactions/FBD87DF24EAC9B6537A09FA27D9CBD1E735C7C505066DB4C47E29D9551BA13F4) | [E4FEEA2E…](https://devnet.xrpl.org/transactions/E4FEEA2E814178F7D2A53CFEBBDAE569874C0CB8885B45837800BAAF7C66FA28) · [3420270B…](https://devnet.xrpl.org/transactions/3420270B93FA047C39580B71A882766797B23C06A4C6AB0AF7691B0EDB2C5182) | [D38861C6…](https://devnet.xrpl.org/transactions/D38861C64E4228444AA04EEEAC5F2972E29FF378000446CCE0A5AA5C6C56A51F) | [FF81A871…](https://devnet.xrpl.org/transactions/FF81A871D4437C40CE554BE3C293D480E514BDB14B3D993E3CFB26D953A85A79) |
| Harbor-2 | [B752D9AB…](https://devnet.xrpl.org/transactions/B752D9AB2A79990ED0404610A16CDC5585654D5A01FF297C87CEA9BCF97E675A) | [8FC8CB2A…](https://devnet.xrpl.org/transactions/8FC8CB2AB566D06128E0B105C0113C351C05FA8360D4B2CEBE11EF0DCBC54B07) · [C07E8885…](https://devnet.xrpl.org/transactions/C07E8885EEAC4BC1CA76BDCEAA5C72449C4ECA86F391543302E178753FC6DECA) | [F72442F6…](https://devnet.xrpl.org/transactions/F72442F6B625C0A45D55B35B269D9EDC17478D5E7A6E1B248E0D94F1A5D43843) | [3DC3B33F…](https://devnet.xrpl.org/transactions/3DC3B33F68689D913D3F166FF6FC97A594F73C0990EF255E59077C4F7B3A06E6) |
| Harbor-3 | [B471BFC2…](https://devnet.xrpl.org/transactions/B471BFC2E3AC5997C2679EBE725CB9A8BA678DE0749539FFE97C89E456E0F086) | [B2F2A187…](https://devnet.xrpl.org/transactions/B2F2A1871976A922C72764ED6296B09C81E666C259F15E1F26443B1D97A9834B) · [6EA40580…](https://devnet.xrpl.org/transactions/6EA40580AB4C5C6CB02232916DBDEA08F9F7B5668C5E7ADE7F57D46A6D03BC97) | [D155ED6C…](https://devnet.xrpl.org/transactions/D155ED6C45C9BC14588D960F1F373857822B388244357F7A5E8B93B948906B2C) | [5CBB6ED4…](https://devnet.xrpl.org/transactions/5CBB6ED468907DF3D802EB5A22AC90EE95FFB3A00EF903A30A560639AF43F28D) |
| desk, the vault the desk lends from | [07D7FF14…](https://devnet.xrpl.org/transactions/07D7FF14A713A8D2657528F641CC71C871D2F3ACE4E771444FC2CF038962F2D2) | | | |
| spare, its second lending vault | [954DA2B3…](https://devnet.xrpl.org/transactions/954DA2B3BBE1572EA37E0529EBC7D44BDFD7CEC1A5DBF6B50FFA8B4F17000791) | | | |

The first impairment of each Harbor vault sets `Vault.LossUnrealized`, a field the vault did not carry
before. Its metadata leaves that field out of `PreviousFields`, so an indexer that diffs metadata never sees
the loss appear. `node src/dev/check-change.mjs` replays Harbor-1's from the captured transaction.

- The chain test on `spare`: the borrower's
  [escrow of 5,000,000 Harbor-1 share units](https://devnet.xrpl.org/transactions/9690077B02B4F8951182106AB315B9B51A92F31659466883DBD493D8510E22DD)
  into a 2-of-3 account, the
  [LoanSet countersigned by the desk](https://devnet.xrpl.org/transactions/8A8F8176C6DB9FC3E511D72144A4351C37084DBB99D069027510ED3FDC7648E1)
  whose memo names that escrow, and a
  [Payment of shares out of a 2-of-3 test account](https://devnet.xrpl.org/transactions/D3E98D23A112CCCC9E922D03625C41B8456984A1CB12696D9689F3074F09D4EC),
  signed by the desk and the agent, two of its three keys.
- The mandate `desk-1`,
  [anchored by the risk officer](https://devnet.xrpl.org/transactions/E63C8AB9D41042B315AE41F45CF2B624592CDC190C66E87D17C8275A2A0A92ED)
  with its hash in the memo.
- [Harbor-1's XLS-47 publication](https://devnet.xrpl.org/transactions/DE7AF2C4F11D3250A2AD66A85E65EE179A6B29277609EA76AE3E09F9AE135262)
  by the publisher account `r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL`, at 20:07:30 UTC on 24 October.

The L2 loans default at the two demo slots on 25 October; the hashes of those defaults are added here after
each slot.

### What must never happen, and how anyone can check it

Each local command below runs from a fresh clone after `npm ci`, with no `.demo/` and no access to our
server; we ran each one that way on 24 October 2026. Two checks read production instead: the health URL of
I4, and the auditor below the table.

| | Rule | Check |
|---|---|---|
| I1 | A pledge is valued only at its withdrawal value, read at a validated ledger: every input of every figure carries that ledger's index and hash. | `node src/dev/check-ticket.mjs` |
| I2 | The desk countersigns a `LoanSet` only if, at the ledger it signs at, the escrow its memo names exists, belongs to the borrower, holds the ticket's shares and pays into a conforming 2-of-3 account, and the ticket recomputed there passes the mandate. | `node src/dev/check-desk.mjs` |
| I3a | No single party, the desk, the borrower or Orma, can move pledged shares. | `node src/dev/check-nyc-contracts.mjs`, and the REAL collateral line of the ticket screen, read at a ledger |
| I3b | The Orma agent co-signs only the release `Payment` its published rule names. | `node src/desk/audit.mjs --self-test` |
| I4 | One process publishes with the publisher's key: the API container on our server. | `node --env-file-if-exists=.env src/dev/with-api.mjs --self-test`; and our former host, https://orma-api.onrender.com/api/health, is suspended, so it must not answer `ok: true` |
| I5 | No `LoanPay` and no `tfLoanUnimpair` on a demo vault. | `git grep --untracked -qE "LoanPay\|tfLoanUnimpair\|VaultDeposit" -- src/roles`, which exits 1 |
| I6 | A manager's statement (`orma.stmt/1` in `Vault.Data`) is labelled DECLARED and enters no computed figure. | `node src/dev/check-ticket.mjs` |
| I7 | Orma recomputes the vault's withdrawal price as a second implementation, held to the vault-state invariants xrpld checks after every transaction (`VaultInvariant.cpp` 574-644). | `node src/dev/check-ticket.mjs` |

The auditor also reads production. `node src/desk/audit.mjs` takes the desk's decision log from the
production API and the ledger from Devnet, with no key. It exits 0 with no violation, 1 on a violation of I1
to I3 or I7, and 2 when a read is impossible.

What these rules do not cover: the borrower and the desk together can always move the pledged shares, a
consensual exit, and in this demo our team holds both roles. The agent's release command
(`node src/desk/audit.mjs --release`) is built and tested offline; no live release is run in the demo.

---

A lending vault on XRPL Devnet took 51 XRP, lent 10, and the borrower stopped paying. The manager wrote the
loan down, the unit fell from 1.000000 to 0.803922, and the transaction metadata that every indexer diffs
came back with `PreviousFields: {}`, an empty change set. Orma is a credit measurement, publication and
enforcement layer for XLS-65 vaults and XLS-66 lending that reads solvency from ledger state instead of from
metadata diffs, publishes the result as a native XLS-47 Oracle object and as a pointer inside the share
token's own metadata, and lets an independent third party gate deposits on it through XLS-70 credentials.

**1st place of 14 projects**, De Vinci Blockchain XRPL Lending Protocol Hackathon, Paris, 12-13 September 2026 ([ESILV](https://www.esilv.fr/xrpl-hackathon-devinci-blockchain-remporte-deux-places-sur-le-podium/)).\
**Upstream:** three notes on the closed-ended vault draft ([XRPL-Standards#587](https://github.com/XRPLF/XRPL-Standards/pull/587#issuecomment-5655843515)), addressed by its author ([reply](https://github.com/XRPLF/XRPL-Standards/pull/587#issuecomment-5665157387)) and merged on 15 September; the `PreviousFields` issue, moved by a RippleX maintainer to the documentation tracker, where it is open ([xrpl-dev-portal#3926](https://github.com/XRPLF/xrpl-dev-portal/issues/3926)).\
**Live:** [app](https://ormaprotocol.com) · [API, Meridian `/nav`](https://claude-vps.tailf3fd40.ts.net/orma/api/vaults/864C5A2DDCED78C6198B0703169D533B747A56E5F9398D832033F79E37E8C835/nav) (until the facilities load it answers `503 WARMING_UP`; retry) · [docs](https://buzzballz.github.io/orma/) · [paper](paper/orma-paper.pdf)\
Built by Alexandre Lemiere ([@frytegg](https://github.com/frytegg)) and Andrea Gonzalez ([@andreagnzz](https://github.com/andreagnzz)).

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
| `rippled` | **3.4.0-rc5** during the event; Devnet has run **3.4.1** since |
| Libraries | `xrpl` **5.3.0** with `ripple-binary-codec` **2.11.0**, `decimal.js` **10.6.0**; frontend React 19, Vite |
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
| `VaultCreate` | Creates each demo facility. All four are closed-ended: `VaultKind=1` with `SubscriptionDate` and `RedemptionDate`, because `LoanBrokerSet` returns `tecNO_PERMISSION` otherwise, and `VaultKind` is immutable. | [Meridian](https://devnet.xrpl.org/transactions/D07C59257F0C568DAF401C4253E8609C206B900F838289E9B45B418F7DE4807C) · [Kestrel](https://devnet.xrpl.org/transactions/0AD99C9FC08A84FE743061488024FFFE7ED8ECBD034A73F007444523B283A258) · [Halden](https://devnet.xrpl.org/transactions/1A226B33CD370E82683A39F58FF8465A16FD1DED99C87EC65B00E8BA2B7B4CF5) · [Thorne](https://devnet.xrpl.org/transactions/3FC79BF77240B0D52148428DABEAC0A5F4971957ABEC1D429ABDF297470F2461) |
| `VaultDeposit` | Subscribes investor capital, and is the transaction the XLS-70 gate admits or refuses at Thorne. | [Meridian](https://devnet.xrpl.org/transactions/3ACF03E8E5E68CD30814694CC7CD5C4BBE67E2EA396EF61EA8C756063892AA8C) · [Thorne, admitted](https://devnet.xrpl.org/transactions/7FC5C01BD735E9A41A0AC6ACFA4B6994B1347A8FA06DAEF8012A62B0E1DF98AF) · [Thorne, refused `tecNO_AUTH`](https://devnet.xrpl.org/transactions/E7CF5DB29DFE652801F4936C11D50A493EB3C474D6EEDFE9FC24394E8DD26101) · [wrong phase `tecEXPIRED`](https://devnet.xrpl.org/transactions/7A10D8053FEE687A008F17E2AD98121EE08553CBDEAAE92DDEC3C2798A1CB15B) |
| `VaultWithdraw` | Redemption. Also the proof that revoking a credential closes entry without trapping the exit. | [Thorne, after revocation](https://devnet.xrpl.org/transactions/2E71A25973D55E26C8AECFDFDF1EF3BF0571B8FB4DD9D524B6A8C750994F39FE) · [Redemption](https://devnet.xrpl.org/transactions/D26222EC26111FFC4F77D3CCADE0FDD2E7C2B9710B9D3957CC4CB725EF58A734) · [wrong phase `tecTOO_SOON`](https://devnet.xrpl.org/transactions/CC104682C298DFB3619EE4C15F0112ACE2B6A95B4971CA0A0AC748F9B5B6617A) |

### XLS-66, Lending Protocol (amendments `LendingProtocol`, `LendingProtocolV1_1`)

| Transaction | What Orma uses it for | Verified on Devnet |
|---|---|---|
| `LoanBrokerSet` | Creates the `LoanBroker`. Its owner is necessarily the vault owner, which is the asymmetry the whole project measures. | [Meridian](https://devnet.xrpl.org/transactions/14CBC3F22EC25532DE74D3EB7758F7A1BB710B0F7ABA3C18C0A4DAC8EAE2785C) · [Kestrel](https://devnet.xrpl.org/transactions/E3D4366469498DDBFC60BC05AF582C18D829B27C52A7224CBE2A58A54B0896AF) · [open-ended vault `tecNO_PERMISSION`](https://devnet.xrpl.org/transactions/CE477E29A099A6BBC30EBA52F3E09AB2A450CDB05F338AE517EDAAC0584827AB) |
| `LoanBrokerCoverDeposit` | Posts the first-loss cover whose consumption the ordering lever moves. | [Meridian](https://devnet.xrpl.org/transactions/C9483EBB8CD46DA7C6AA9A3E465FC2213E252D8C953F7AF6C347B032D14BB958) · [Kestrel](https://devnet.xrpl.org/transactions/E979EB6D211701C6B8BD66F7D4F3AD1A98388029414BF17FF70D092B74D2B76A) · [Halden](https://devnet.xrpl.org/transactions/A075625DAA314EEC6D8B1C032753E15CAF9A7F45364F1D27F60B5296F257D309) |
| `LoanSet` | Originates each loan, counterparty-signed. Under cash-basis accounting (`LEVersion=1`) origination moves `DebtTotal`, not `AssetsTotal`. | [Meridian](https://devnet.xrpl.org/transactions/1523BD1B1548A01B46AAA88871EA965EE973BFA7016D7B8ACC950E463567AA4A) · [Kestrel, first](https://devnet.xrpl.org/transactions/525FC003CF1D4C99B82E876DE945000A681230D4312C03DE1120EA9F905118AB) · [Kestrel, second](https://devnet.xrpl.org/transactions/30B97AA397678AF36EDA7604582789C76F1F1B3B1083F453F95FB3107796A06B) · [wrong phase `tecTOO_SOON`](https://devnet.xrpl.org/transactions/E1121DED12D4A320FB58F77D02549429885D8A826B794F2B2539EC936BE39011) · [wrong phase `tecEXPIRED`](https://devnet.xrpl.org/transactions/8A09A988DD3C5433B30E92F5E7B42086D6B17CEB51C6C05572E7A74552B9DAE1) |
| `LoanManage` | Impairs (`Flags 0x20000`) and defaults (`Flags 0x10000`). These are the two levers. Only the broker owner may submit either. | [impair, Meridian](https://devnet.xrpl.org/transactions/075FE6D2E0F29919AF477A2A8F581A680805A006138BB967D8434611E49229C3) · [impair, Halden](https://devnet.xrpl.org/transactions/EC385DAF2DF412F86F06648B7855AEFDB1A1B8596048DA33C33B0A09FB2D08E5) · [default, Kestrel, larger](https://devnet.xrpl.org/transactions/FB23EC5313F85FA157D56966E0B0B1665068905988D925C70BB0E7C35C3B221B) · [default, Kestrel, smaller](https://devnet.xrpl.org/transactions/DE49DF0D6136B96AD28B253CD32100E5715078FD2D0AE6D1DB747AFECB803D1F) |

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
| `PermissionedDomainSet` | A separate vault-owner account (for the demo, a Devnet wallet our setup script created) names Orma's issuer as an accepted credential. Our issuer signs nothing and cannot decline. | [Thorne domain](https://devnet.xrpl.org/transactions/4C425830675B021EB8A74904783D1DBDE516C74534C76E84A2899695DF3D87F9) |

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
open the public explorer at https://devnet.xrpl.org. Devnet prunes old ledgers, so those links will stop
resolving. The raw transactions behind every hash in this README are committed under
[`evidence/devnet-tx/`](evidence/devnet-tx/README.md), captured on 13 October 2026. Each signed transaction
blob hashes back to its id, and its metadata is the server's copy as served, not hash-bound offline;
`npm run check:evidence` checks both against the JSON. The same directory holds every transaction the
API's two history routes read for the four facilities, which they merge in as Devnet prunes them. The
vault, oracle and domain objects are ledger state, not history, and still verify live with `ledger_entry`.

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

### Halden Structured Credit IV, the token that prices itself

The `VaultCreate` here carries the share token's XLS-89 metadata and its valuation pointer. These six were
submitted on 19 October 2026, after the event.

| | Transaction | Result | Validated (UTC) | Explorer |
|---|---|---|---|---|
| 1 | `VaultCreate` | `tesSUCCESS` | 2026-10-19 21:29:01Z | [`1A226B33…7B4CF5`](https://devnet.xrpl.org/transactions/1A226B33CD370E82683A39F58FF8465A16FD1DED99C87EC65B00E8BA2B7B4CF5) |
| 2 | `VaultDeposit` | `tesSUCCESS` | 2026-10-19 21:29:10Z | [`22233F6B…2F17A2`](https://devnet.xrpl.org/transactions/22233F6BBEAC488A871ABBC35410F55D81A72D964E3FA4A4C970A9D7C22F17A2) |
| 3 | `LoanBrokerSet` | `tesSUCCESS` | 2026-10-19 21:29:12Z | [`904C06FD…582AD0`](https://devnet.xrpl.org/transactions/904C06FDF6E60F881C74AE5F996AA7458C8DBAFCBBD41D9E83A9EF49FC582AD0) |
| 4 | `LoanBrokerCoverDeposit` | `tesSUCCESS` | 2026-10-19 21:29:21Z | [`A075625D…57D309`](https://devnet.xrpl.org/transactions/A075625DAA314EEC6D8B1C032753E15CAF9A7F45364F1D27F60B5296F257D309) |
| 5 | `LoanSet` | `tesSUCCESS` | 2026-10-19 21:29:31Z | [`D8301546…7CD10F`](https://devnet.xrpl.org/transactions/D8301546882B271F9B2200771ABD6E3320EC4233026983B4BF5B1FAFA87CD10F) |
| 6 | `LoanManage`, impair | `tesSUCCESS` | 2026-10-19 21:31:52Z | [`EC385DAF…2D08E5`](https://devnet.xrpl.org/transactions/EC385DAF2DF412F86F06648B7855AEFDB1A1B8596048DA33C33B0A09FB2D08E5) |

### Thorne Senior Secured I, the gate

A vault owner names our credential issuer in their Permissioned Domain (in the demo, a separate account our setup script created). The ledger then admits
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

The reader publishes each facility's XLS-47 document under `oracleDocId(VaultID)`: the first four bytes of
`sha256(VaultID)`, read as a big-endian `UInt32` (`src/oracle.mjs`). The id is a function of the vault alone,
so a restart, a retired vault or a second process never moves a document to another vault, and the publisher
refuses to publish a second vault under an id already held rather than overwrite its scores. Identify a vault
by `BaseAsset`, the first 20 bytes of its vault id. The documents the reader writes:

| `oracle_document_id` | Facility | Vault id |
|---|---|---|
| 3238869064 | Thorne Senior Secured I | `4A5A8E37…` |
| 275365832 | Meridian Trade Finance I | `864C5A2D…` |
| 4197695612 | Kestrel Bridge Financing II | `24EAA01A…` |
| 3412668304 | Halden Structured Credit IV | `DAB9E1EE…` |
| 2611978006 | Harbor-1 | `E216E96D…` |
| 1197106457 | Harbor-2 | `1F50CE2B…` |
| 3647726209 | Harbor-3 | `0BAC80C3…` |
| 587307429 | desk | `3422A5AD…` |
| 2761675937 | spare | `88849E4F…` |

Calder is retired: it is not read and has no document under the current publisher. Three accounts hold
Orma's objects:

| Publisher | What its objects are |
|---|---|
| [`r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL`](https://devnet.xrpl.org/accounts/r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL) | The current publisher, `Provider` `Orma`, since 24 October 2026. Its `Domain` is `ormaprotocol.com`, which lists it in `/.well-known/xrp-ledger.toml`. It republishes when a vault's NAV or grade changes, and on a 60-second heartbeat. |
| [`rPuYT6SZopnZopp4fmvkfd5eeXQTsozz6H`](https://devnet.xrpl.org/accounts/rPuYT6SZopnZopp4fmvkfd5eeXQTsozz6H) | The deployed reader's publisher until 24 October 2026, under the project's former name, with document ids 1 to 5. Its objects are no longer updated: `OracleSet` refuses a `Provider` changed on an existing Oracle, so the new name needed a new account. |
| [`rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B`](https://devnet.xrpl.org/accounts/rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B) | Written during the Paris event and frozen since, `LastUpdateTime` 2026-09-13 between 14:20 and 14:21 UTC, with document ids 1 to 4, numbered by the publisher of that time. |

`devnet.xrpl.org` has no route for a bare ledger index, so fetch the object itself rather than
following a link to it. Halden, from the current publisher:

```bash
curl -s https://s.devnet.rippletest.net:51234 -H 'Content-Type: application/json' -d '{"method":"ledger_entry","params":[{"oracle":{"account":"r91JiCEYCm4CzTF8G5eks1FpzVJxa5FtdL","oracle_document_id":3412668304},"ledger_index":"validated"}]}'
```

Every `PriceData` entry carries `BaseAsset` `DAB9E1EE3D8899C2112FCFC90F40D7C93B74B06C`, the first 20 bytes
of Halden's vault id, and `NAV` reads `c4452` hex at `Scale` 6, which is 0.803922.

During the event we set two publishers against each other on Meridian, so `get_aggregate_price` had
something to aggregate. The event-time publisher, `rpVg1ufqoVwHCN814QBqvibYPftMYc2u3B` (document 2),
reads the vault object and reports `0.803922`. A third account, `raiwYKSDdrhiediLdgJyGEzP1estXcmVcM`
(document 1), is a throwaway Devnet faucet account we created to stand in for a naive indexer: it published,
once, the `1.000000` that a metadata-diffing indexer computes, taken from `demo/indexer-race.json`. It is ours, not an independent publisher. rippled returned a median of
`0.901961` across the two. The capture is in [`demo/oracle-aggregate.json`](demo/oracle-aggregate.json)
with the request to reproduce it.

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

A healthy Vault does not carry `LossUnrealized` at all: rippled declares the field `SoeDefault` (optional,
and never stored at its default), so it is left off the object while it is 0. `PreviousFields` records a
previous value only for a field that was there before, so the first impairment, which creates the field, has
nothing to record. Under cash-basis accounting nothing else on the Vault object changes. The metadata is
therefore emitted empty: an indexer that diffs it sees a node touched but unchanged. The rule is presence,
not value: the same transaction records the Loan's previous `Flags` of 0, because `Flags` is a required field
and is always on the object. Naive NAV reads `1.000000`. Net of the recognised loss it is `0.803922`.
**1961 basis points apart, on the same transaction, from the same ledger.** (Restated on 13 October 2026; see
[Since the event](#since-the-event).)

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

### 3. Halden Structured Credit IV, the token that prices itself

```
vault     DAB9E1EE3D8899C2112FCFC90F40D7C93B74B06CD4E67EF368080D15A602B245
broker    3A87743DC5EEEBD4A527543D73E5CBDCB7B0201113084A47E1C4FE5D0B480AF6
shareMPT  000000015281B163EE111C4DA95B27EE9D82D7ADE53A9797
impair    EC385DAF2DF412F86F06648B7855AEFDB1A1B8596048DA33C33B0A09FB2D08E5
file      demo/showcase-vault.json
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

A separate vault owner, an account our setup script created for the demo, named our credential issuer in their `PermissionedDomain` and bound the domain to
their vault. Two investors, same second: the graded one deposited, the ungraded one was refused **by the
ledger**, not by us. When the credential is revoked, `VaultDeposit` is refused and `VaultWithdraw` still
succeeds. A rater who could trap capital would be a worse problem than the one we solve.

---

## Running it

Node 24.13.0 (Node 20.19 or later works). The reader needs outbound access to Devnet and no keys: every
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
npm run check:api        # HEAD answers like GET, and "warming up" until a vault is first read, offline
npm run check:navhistory # the NAV series, read from each transaction's own metadata, offline
npm run check:archive    # both history routes as Devnet prunes the event, on the committed archive, offline
```

The HTTP API is documented in `documentation/pages/http-api.mdx`:

```
GET  /api/health
GET  /api/methodology
GET  /api/vaults
GET  /api/vaults/:vaultId
GET  /api/vaults/:vaultId/nav
GET  /api/vaults/:vaultId/nav-history
GET  /api/vaults/:vaultId/collateral
GET  /api/vaults/:vaultId/broker-history
GET  /api/vaults/:vaultId/gate
GET  /api/mpt/:mptIssuanceId/nav          # CORS-open: called by a party with no relationship to us
GET  /api/mpt/:mptIssuanceId/resolve      # CORS-open
GET  /api/indexer-race                    # captures from the event
GET  /api/oracle-aggregate
GET  /api/demo/state
GET  /api/openapi.json                    # OpenAPI 3.1; src/mcp.mjs serves the same readings as MCP tools
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
| `VITE_DOCS_URL` | Optional. Defaults to https://buzzballz.github.io/orma/. |

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

React 19, Vite, Tailwind, TypeScript. Screens: Portfolio, Facility, FacilityExhibits, Evidence, OracleObject,
PledgeResolution, EntryGate, Methodology, Event. It polls the backend and renders the same numbers the API serves, with the notch trace
that produced each grade.

### `demo/`

The four captured facilities, one JSON file each, with vault ids, transaction hashes, the readings and the
verdict, plus `delegation.json`, the delegation probe and its positive control. These are committed artefacts: the Evidence screen renders from them and needs no API.

### `contrib/`

`contrib/tutorial-fix/` is a Devnet-proven fix for the official XRPL lending tutorial, written during the
event. On 12 September `lendingSetup.js` created an open-ended vault, `submitAndWait` did not throw on a `tec`,
and `.find()` over the metadata returned `undefined`, so the script died at `Setting up tutorial: 5/7` with a
`TypeError` rather than a result code, and all six *Use the Lending Protocol* tutorials ran it first. We did
not file it: [xrpl-dev-portal#3923](https://github.com/XRPLF/xrpl-dev-portal/pull/3923), merged on
16 September 2026, carries four of its five changes. What remains is the engine-result guard. The directory
holds the diff, the PR body we did not send, a full run log, the before and after scripts, and the upstream
sources it was taken from.

`contrib/filings/` records what was filed upstream and what was not, and why.

### `paper/`

`orma-paper.pdf` is the technical paper, fourteen pages, compiled from `orma-paper.tex`. It states the
arithmetic the protocol runs on so a reader can check it rather than read JavaScript: the two net asset
value readings and why the naive one is not merely lazy, the cover liquidation formula and its three
non-obvious properties, and the ordering result as a theorem with its proof. Every measured figure in it
was read from live Devnet during the event, and every claim carries a transaction hash. The exception is
the oldest ledger one Devnet server reported on 13 October 2026, given in one of the paper's two dated
corrections of that day.

### `documentation/`

The protocol documentation, ten pages of Mintlify MDX plus its configuration. `build.mjs` renders the
same source into a static site and `deploy.sh` publishes it to GitHub Pages, at
https://buzzballz.github.io/orma/, so the pages do not depend on the Mintlify account
(https://ormaprotocol.mintlify.site/).

### `deck/`

`content.md` is the ten-slide presentation, timed to four minutes, and `build.mjs` turns it into a
self-contained deck that opens in a browser and prints to PDF. No slide toolchain to install.

### `FEEDBACK.pdf` and `feedback/`

`FEEDBACK.pdf` is the developer feedback report: **three pages**, written from the build, signed. It is
short on purpose, because it is read by someone who did not ask for it. It was corrected on 13 October
2026, with a dated line under the signature: the `PreviousFields` rule is worded by presence, not value
([xrpl-dev-portal#3926](https://github.com/XRPLF/xrpl-dev-portal/issues/3926)), the prior report on
`rippled#6487` is no longer called our strongest evidence, and the filings it called ready are listed as
filed ([`contrib/filings/`](contrib/filings/README.md)). The report as submitted is attached to the
[`hackathon-submission`](https://github.com/BuzzBallz/orma/releases/tag/hackathon-submission) release.

Its evidence is `feedback/appendix.pdf`, the full 40-finding register — 34 pages, every claim carrying a
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
   `PreviousFields: {}` while `FinalFields` carries a non-zero `LossUnrealized`: the field was not on the
   object before, so there is no previous value to record. It was raised before us as
   [`rippled#6487`](https://github.com/XRPLF/rippled/issues/6487) by the operator of an XRPL explorer, and
   closed by its reporter as not a bug; we left a [comment crediting it](https://github.com/XRPLF/rippled/issues/6487#issuecomment-5655575723).
   The metadata follows rippled's rules, and a consumer that diffs it still gets the wrong answer. The
   follow-up we filed as `rippled#8222` was moved by a RippleX maintainer to the documentation tracker as
   [xrpl-dev-portal#3926](https://github.com/XRPLF/xrpl-dev-portal/issues/3926), *Add clarification to docs
   on PreviousFields metadata rules*.
2. **The documented first hour could not complete.** Our fix, verified green on rc5, is in
   `contrib/tutorial-fix`; [xrpl-dev-portal#3923](https://github.com/XRPLF/xrpl-dev-portal/pull/3923), merged
   on 16 September 2026, carries four of its five changes, and the engine-result guard is what remains.
3. **A broker's action history cannot be reconstructed by filtering.** `LoanManage` carries no
   `LoanBrokerID`, and an impairment does not touch the `LoanBroker` object at all, so a filter over
   `account_tx` silently drops every impairment. `Loan.FinalFields.LoanBrokerID` in the same metadata closes
   the join. Before that fix, every default looked unsignalled, and the conduct rule written to reward
   disclosure was penalising it. That one shipped a wrong answer inside our own code before we caught it.

The register is `feedback/appendix.pdf`. Upstream, three notes on the closed-ended vault draft
([XRPL-Standards#587](https://github.com/XRPLF/XRPL-Standards/pull/587#issuecomment-5655843515)) were addressed by its author
([reply](https://github.com/XRPLF/XRPL-Standards/pull/587#issuecomment-5665157387)) and merged on 15 September, and the
`PreviousFields` issue is open as a documentation task
([xrpl-dev-portal#3926](https://github.com/XRPLF/xrpl-dev-portal/issues/3926)). `contrib/tutorial-fix/` is
the tutorial fix we did not file, and `contrib/filings/` records the rest.

---

## Since the event

Up to 1 October 2026, 139 of the 141 commits on `main` were dated 12 and 13 September 2026. What happened
after:

- **14 September 2026.** `FINDINGS.md`, an index of the 40 findings, with statuses as of that day (Andrea).
- **14 September 2026.** A RippleX maintainer moved our `PreviousFields` issue, `rippled#8222`, to
  [xrpl-dev-portal#3926](https://github.com/XRPLF/xrpl-dev-portal/issues/3926) as a documentation task.
- **15 September 2026.** The closed-ended vault draft,
  [XRPL-Standards#587](https://github.com/XRPLF/XRPL-Standards/pull/587), merged with our three notes addressed.
- **From 23 September 2026.** A UI redesign (Andrea), merged into `main` on 13 October 2026. It is what
  https://ormaprotocol.com serves.
- **1 October 2026.** A NAV-history route, `GET /api/vaults/:vaultId/nav-history`, a vault's NAV at every
  transaction that modified it, on `main` (Andrea). The deployed API serves it since 13 October 2026.
- **13 October 2026.** Corrections to this README and the docs: the `PreviousFields` mechanism restated
  (presence, not value), the Kestrel oracle query fixed (document 4, deployed publisher), the oracle document
  ids described as assigned in publish order, the upstream statuses updated, and the raw transactions behind
  every hash captured under [`evidence/devnet-tx/`](evidence/devnet-tx/README.md). The paper and the
  register (`feedback/register.md`, `feedback/appendix.pdf`) carry dated correction notes on the
  `PreviousFields` mechanism and on Devnet's history window, which they had given as roughly 29 days, and the
  source comments in `src/` were restated to match. Also corrected: the Meridian contest (the second
  publisher was a second account of ours, not an independent one), the credential gate (its vault owner was
  an account our setup script created), the pre-commit hook (local during the event, not in this
  repository), the quickstart's first step (`tools/verify-toolchain.mjs` is not in the repository), and the
  deck's speaker notes in four places.
- **13 October 2026.** `FINDINGS.md` statuses refreshed, and the register's index with them. The API
  answers `HEAD` and says `503 WARMING_UP` before its first snapshot. `FEEDBACK.pdf` corrected in four
  places, with a dated line under the signature (Andrea). An MIT licence. The repository as submitted is
  the [`hackathon-submission`](https://github.com/BuzzBallz/orma/releases/tag/hackathon-submission) release.
- **13 October 2026.** The two history routes no longer depend on Devnet keeping the event's ledgers. Each
  read is merged with the facilities' account histories, captured that day under
  [`evidence/devnet-tx/`](evidence/devnet-tx/README.md); each point or event says whether it came from the
  archive, and each response states the window it covers. When that window does not reach back to the
  broker's creation, the conduct grade is withheld rather than computed: a pruned record would have graded
  Kestrel's broker A 100 instead of E 25 (raised by Andrea). On a cold start, a facility not read yet answers
  `503 WARMING_UP` rather than `404`. The deployed API serves all of this since that day.
- **13 October 2026.** The app moved to its own domain, https://ormaprotocol.com, which its link card now
  names; the old `ormaprotocol.vercel.app` address still works. A withheld conduct grade reads "Not
  assessed" instead of "— / 100", and the history caveat is printed in the note's own vocabulary (Andrea).

---

## Team

**Alexandre Lemiere** ([@frytegg](https://github.com/frytegg)): the reader, scoring, NAV, the XLS-47
publisher and the credential gate (`src/`); the verification screen and demo exhibits in the app; the
40-finding register (`feedback/`); the upstream filings and `contrib/`; the paper and the documentation.\
**Andrea Gonzalez** ([@andreagnzz](https://github.com/andreagnzz)): the app (`app/`), its visual identity (the Orma mark and palette) and its redesign; the
three-page rewrite of the feedback report (`37d6a96`); `FINDINGS.md`; and the NAV-history API added after the
event.

Team BuzzBallz, 1st place of 14 projects. De Vinci Blockchain XRPL Lending Protocol Hackathon, Paris, 12 and
13 September 2026.
