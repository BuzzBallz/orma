# Upstream filings

## Filed

| What | Where | When |
|---|---|---|
| Issue: impairing a healthy vault emits an empty `PreviousFields`. Filed as XRPLF/rippled#8222; moved by a RippleX maintainer on 2026-09-14 to the documentation repository as "Add clarification to docs on PreviousFields metadata rules" (open) | [XRPLF/xrpl-dev-portal#3926](https://github.com/XRPLF/xrpl-dev-portal/issues/3926) | 2026-09-13 |
| Courtesy comment crediting the prior report | [XRPLF/rippled#6487](https://github.com/XRPLF/rippled/issues/6487#issuecomment-5655575723) | 2026-09-13 |
| Comment: the missing 11th `LoanBrokerSet` failure condition, the §2.4 bounds, the §7.2.1 buffer | [XRPL-Standards#587](https://github.com/XRPLF/XRPL-Standards/pull/587#issuecomment-5655843515) | 2026-09-13 |
| Cross-reference on the cash-basis PR | [XRPL-Standards#582](https://github.com/XRPLF/XRPL-Standards/pull/582#issuecomment-5655843822) | 2026-09-13 |
| Issue: `Scale: 0` cannot be expressed through `validate()` | [XRPLF/xrpl.js#3477](https://github.com/XRPLF/xrpl.js/issues/3477) | 2026-09-13 |
| Comment: the live 11-20 bracket on the existing `SCALE_MAX` issue | [XRPLF/xrpl.js#3435](https://github.com/XRPLF/xrpl.js/issues/3435#issuecomment-5655842898) | 2026-09-13 |

Evidence was re-verified against live Devnet immediately before filing: both cited transactions
still validate, vault `864C5A2D` still carries `LossUnrealized`, vault `4A5A8E37` still has no such
field, and the network is still on 3.4.0-rc5.

## Not filed

Only one, deliberately: the tutorial pull request. `xrpl-dev-portal#3923` added code-sample commits
thirteen hours after our draft was written and carries four of its five fixes; it was merged on
2026-09-16. Filing it would have put a 90% duplicate on the desk of the maintainer who wrote the
original. What survives is the engine-result guard, which belongs as a comment on #3923 or on the
maintainer's own issue #3789.
