One cross-reference on §2.7, from building against this on Devnet this week.

The deferral line — *"Closed-ended Vault phase checks on `LoanSet` and the closed-ended requirement on `LoanBrokerSet` are specified in [PR #587](https://github.com/XRPLF/XRPL-Standards/pull/587), not in this patch"* — currently points at a document that contains the string `LoanBrokerSet` zero times. #587 specifies `VaultCreate`, `VaultDeposit`, `VaultWithdraw`, `LoanSet` and `LoanAccept`, but not broker creation, and `LoanBrokerSet` is absent from its §2.1 permission matrix as well.

The rule itself is real and merged in rippled (XRPLF/rippled#8076): `LoanBrokerSet` against an open-ended vault returns `tecNO_PERMISSION` even for the vault owner (`86AC8182A100EEDA32495706C06CDAC6D522B0E0772F5F65696064B6F3C0E5ED`, against `CFC576DF9DCF7DB12059C559F93BE6F6094011820796859A1E814586C0E4AD5F` for the same owner on a closed-ended vault). I have raised it on #587 with the full evidence.

Flagging here only so the deferral does not merge pointing at a gap.
