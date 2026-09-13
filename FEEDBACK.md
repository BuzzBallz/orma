# Developer feedback — building Orma on XLS-65 / XLS-66

| | |
|---|---|
| **Track** | **2** — closed-ended vault, Lending Protocol **V1.1** |
| **Flavour** | **Loaded** — XLS-47 Oracle, XLS-70 Credentials, XLS-80 Permissioned Domains, XLS-85 Token Escrow, MPT shares |
| **Environment** | XRPL Devnet, `wss://s.devnet.rippletest.net:51233`, `network_id` 2, rippled **3.4.0-rc5** (rc4 when we started) |
| **Libraries** | `xrpl` **5.2.0** with `ripple-binary-codec` **2.11.0**, Node 24.13.0 · frontend `xrpl-connect` 0.8.2 |
| **DevEx pseudonyms** | `tender-gopher-21`, `keen-auk-43` |

**The report is [`FEEDBACK.pdf`](FEEDBACK.pdf)** — three pages, written from the build rather than from
reconnaissance, and signed.

Every claim in it is evidenced with transaction hashes in
[`FEEDBACK-APPENDIX.md`](FEEDBACK-APPENDIX.md): 40 findings, 7 P0, 19 P1, 14 P2, and 3 we withdrew.

The tutorial fix we are contributing is in [`contrib/tutorial-fix/`](contrib/tutorial-fix/), verified
green on rc5 and ready to file.
