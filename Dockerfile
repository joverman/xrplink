# Multi-stage build: compile contracts with devDependencies, then create slim runtime image
# Pinned to Node 22.23.4 on Alpine 3.24 (uid 1000 `node`, compatible with run.sh --user 1000:1000).

# =============================================================================
# BUILDER STAGE: Install all deps, compile Solidity contracts
# =============================================================================
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY hardhat.config.ts tsconfig.json ./
COPY contracts/ ./contracts/

RUN npx hardhat compile --quiet

# =============================================================================
# RUNTIME STAGE: Production image with only runtime dependencies
# =============================================================================
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/artifacts/ ./artifacts/

COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json ./

# Official node image already has uid/gid 1000 (`node`). Prod run.sh uses 1000:1000,
# a read-only root, and dropped capabilities — keep ownership aligned.
RUN mkdir -p /app/data && chown -R node:node /app

ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV TRUST_PROXY=loopback,linklocal,uniquelocal

EXPOSE 3000

USER node

# Use 127.0.0.1, not localhost — localhost can resolve to IPv6 ::1 and fail in prod.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["npx", "tsx", "src/index.ts", "--api"]
