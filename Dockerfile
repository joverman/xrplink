FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
COPY contracts/ ./contracts/
COPY hardhat.config.ts ./
COPY artifacts/ ./artifacts/

RUN npm install -g tsx

EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]
