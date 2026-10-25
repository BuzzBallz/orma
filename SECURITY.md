# Security

Orma serves an HTTP API over XRP Ledger Devnet state. It holds no user funds. Every read route is
public and answers with CORS `*`. The only write routes are under `/api/roles/*` and `/api/demo/*`, and
they sign and submit Devnet transactions for the demo's own role accounts, never for a visitor:

- `POST /api/roles/{runId}/{role}/{action}` and its `/confirm` accept only an action on the allow-list
  (anything else answers 404), from an origin listed in `ALLOWED_WRITE_ORIGINS` (a request with no
  `Origin` only from loopback), carrying the run's bearer token. Each action is previewed by `simulate` before it can be confirmed, and submitted through one queue
  per signing account. The desk signer (`src/desk/signer.mjs`) countersigns a `LoanSet` only after reading
  the ledger again, and records each decision in a hash-chained log.
- `POST /api/demo/run`, `/kill` and `/unkill` are operator routes. They answer only a request from loopback,
  or one carrying the `x-demo-key` set on the server, and refuse any request sent by a browser. `/run` mints
  a run and its token; `/kill` turns on a switch under which every write answers 423 and nothing is signed.

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a
vulnerability**. Please do not open a public issue.

You will get a first answer within 7 days. Include the route or file, what an attacker can do,
and the request that shows it.

## Scope

- The API in `src/`, run as a container on the team's server, and the site in `app/` (deployed on Vercel).
  The write path is in scope first: the role engine (`src/roles/engine.mjs`), the desk signer and its
  decision log (`src/desk/`), the origin allow-list, the run token, the operator gate and the kill switch.
- Not in scope: Devnet itself, the XRPL libraries, and the throwaway Devnet keys the demo scripts
  generate.
