FROM node:22-alpine

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application files
COPY hardhat.config.ts tsconfig.json ./
COPY contracts/ ./contracts/
COPY src/ ./src/
COPY public/ ./public/

# Compile Solidity contracts to generate artifacts
RUN npx hardhat compile --quiet

# Default environment variables (can be overridden at runtime)
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV TRUST_PROXY=true

# Create data directory
RUN mkdir -p /app/data

EXPOSE 3000

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["npx", "tsx", "src/index.ts", "--api"]
