# What was built at the XRPL hackathon in New York (24–25 Oct 2026)

This repository existed before the event. This file says where the event's work starts, and how to check it without trusting us.

## The boundary

- **Before the event:** everything reachable from the tag `nyc-start`, commit `bd39502350a89b121b0726e093c3185dbac88445`, tagged `2026-10-24 12:18:07 -0400` when the build opened. That is Orma's information layer, built at the XRPL hackathon in Paris (September 2026) and maintained since: the vault reader, the withdrawal value per share, the score, the XLS-47 oracle publisher, the site and the HTTP API.
- **During the event:** everything in `nyc-start..main`, which is Orma Desk (the risk ticket, the role engine, the desk signer, the change engine, the desk screens, Universe, the Feed) and the weekend's hardening. Each build step is one commit and one tag, `step-01-contract` to `step-16-rehearsal`.
- **Preparation:** the build plan was written before the event, and rehearsed in a private repository on 22–23 Oct. No code was carried over: everything after `nyc-start` was written during the event, from that plan.

## Check it yourself

1. The event's diff: https://github.com/BuzzBallz/orma/compare/nyc-start...main
2. Every commit since the boundary: `git fetch --tags && git log --reverse --format='%h %cI %s' nyc-start..main`
3. The step tags, in order: `git for-each-ref --sort=creatordate --format='%(creatordate:iso8601) %(refname:short) %(objectname:short)' refs/tags/nyc-start 'refs/tags/step-*'`
4. The size of the change: `git diff --stat nyc-start main`
5. Times we cannot set. Commit dates are written by the committer, so on their own they prove nothing. GitHub records when each push reached it: https://github.com/BuzzBallz/orma/activity. And every demo vault, loan, default and oracle publication of the event is a Devnet transaction, whose ledger close time the network sets; their hashes are in the README section "Built in New York", and each one is captured in `evidence/devnet-tx/`.
