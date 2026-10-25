# Multi-stage build: compile contracts with devDependencies, then create slim runtime image

# =============================================================================
# BUILDER STAGE: Install all deps, compile Solidity contracts
# =============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install all dependencies (including devDependencies for hardhat)
COPY package.json package-lock.json ./
RUN npm ci

# Copy contract sources and config needed for compilation
COPY hardhat.config.ts tsconfig.json ./
COPY contracts/ ./contracts/

# Compile Solidity contracts to generate artifacts
RUN npx hardhat compile --quiet

# =============================================================================
# RUNTIME STAGE: Production image with only runtime dependencies
# =============================================================================
FROM node:22-alpine AS runtime

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled contract artifacts from builder
COPY --from=builder /app/artifacts/ ./artifacts/

# Copy application source and static files
COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json ./

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs && \
    mkdir -p /app/data && \
    chown -R nodejs:nodejs /app

# Default environment variables (can be overridden at runtime)
# TRUST_PROXY: Safe default restricts trust to loopback/private ranges.
# Set to "true" ONLY if your reverse proxy (cloudflared, nginx, etc.) is on
# the same Docker network AND you trust all containers on that network.
# See docs/production-hardening.md for details.
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV TRUST_PROXY=loopback,linklocal,uniquelocal

EXPOSE 3000

# Switch to non-root user
USER nodejs

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["npx", "tsx", "src/index.ts", "--api"]
