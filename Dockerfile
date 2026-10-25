# The reader and its HTTP API. The frontend is static and deploys separately, from app/.
#
# The image carries exactly what the process reads at runtime: the lockfile's dependencies,
# src/, the committed facility captures in demo/, and the Devnet transactions in
# evidence/devnet-tx that the history routes merge in once Devnet has pruned them (src/archive.mjs
# resolves them next to src/). It runs as the unprivileged node user. The one thing it writes is
# the desk's chained decision log (margin calls included) at DESK_LOG_PATH, default
# .demo/decisions.jsonl under /srv/orma; that directory is created for node below, and a volume
# mounted over /srv/orma/.demo keeps the log across containers. No key is baked in: PUBLISH_SEED,
# DESK_SEED and ROLES_FILE, when used, come from the platform's environment.
FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f

WORKDIR /srv/orma
ENV NODE_ENV=production

# npm ci installs the committed lockfile exactly (xrpl 5.3.0, ripple-binary-codec 2.11.0),
# rather than re-resolving it: the codec is the package that serializes closed-ended vaults.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY demo ./demo
COPY evidence/devnet-tx ./evidence/devnet-tx

# WORKDIR is root-owned: without this the first decision-log append fails with EACCES as node.
RUN mkdir -p /srv/orma/.demo && chown node:node /srv/orma/.demo

USER node
EXPOSE 8787

# Platforms set PORT; 8787 is the local default. The API answers before the first ledger read
# lands, so a health check can pass while the reader is still connecting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.mjs"]
