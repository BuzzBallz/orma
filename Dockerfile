# The reader and its HTTP API. The frontend is static and deploys separately, from app/.
#
# The image carries exactly what the process reads at runtime: the lockfile's dependencies,
# src/, the committed facility captures in demo/, and the Devnet transactions in
# evidence/devnet-tx that the history routes merge in once Devnet has pruned them (src/archive.mjs
# resolves them next to src/). Nothing is written to disk, so it runs
# as the unprivileged node user. No key is baked in: PUBLISH_SEED, when used, comes from the
# platform's environment.
FROM node:26.12.0-bookworm-slim@sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913

WORKDIR /srv/orma
ENV NODE_ENV=production

# npm ci installs the committed lockfile exactly (xrpl 5.3.0, ripple-binary-codec 2.11.0),
# rather than re-resolving it: the codec is the package that serializes closed-ended vaults.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY demo ./demo
COPY evidence/devnet-tx ./evidence/devnet-tx

USER node
EXPOSE 8787

# Platforms set PORT; 8787 is the local default. The API answers before the first ledger read
# lands, so a health check can pass while the reader is still connecting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.mjs"]
