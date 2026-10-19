# Security

Orma serves a public, read-only HTTP API over XRP Ledger Devnet state. It holds no user funds
and signs nothing on a visitor's behalf.

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a
vulnerability**. Please do not open a public issue.

You will get a first answer within 7 days. Include the route or file, what an attacker can do,
and the request that shows it.

## Scope

- The API in `src/` (deployed on Render) and the site in `app/` (deployed on Vercel).
- Not in scope: Devnet itself, the XRPL libraries, and the throwaway Devnet keys the demo scripts
  generate.
