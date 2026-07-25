FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY hardhat.config.ts ./
COPY contracts/ ./contracts/
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

# Compile Solidity contracts to generate artifacts
RUN npx hardhat compile --quiet

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts", "--api"]
