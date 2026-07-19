FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY contracts/ ./contracts/
COPY hardhat.config.ts ./
COPY artifacts/ ./artifacts/

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]
