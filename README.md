# XRPLink — Cryptographically Verified XRP Payment Receipts

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Generate tamper-proof, independently verifiable receipts for any XRP payment.** XRPLink attests XRP transactions through Flare's FDC protocol and provides a shareable receipt with a cryptographic Merkle proof. Built for compliance, audit, and merchant reconciliation.

**Live at [https://xrp-link.com](https://xrp-link.com)**

## Quick Start

```bash
# Visit the hosted app
open https://xrp-link.com

# Or run locally
git clone <repo-url>
cd xrplink
npm install
cp .env.example .env
# Edit .env with your private key and API key
npm run start:rest
```

## Project Status

Live on Flare mainnet. End-to-end pipeline validated: XRP tx → verifier API → FdcHub → DA Layer proof → on-chain verification.

| Milestone | Status |
|---|---|
| Mainnet deployment | ✅ **Live** (`PaymentVerifierMainnet` at `0xA10034...e14b`) |
| End-to-end pipeline validated | ✅ Complete — XRP tx attested on mainnet |
| User auth (signup/login) | ✅ Complete |
| Receipt pages | ✅ Complete — shareable at `/receipt/:txHash` |
| Dashboard | ✅ Complete — API key, usage stats, receipt history |
| REST API | ✅ Complete — verify, status, webhooks, health |
| API key auth + rate limiting | ✅ Complete |
| Subscription tiers | ✅ Complete — free/paid/pro |
| MCP Server | ✅ Complete — 5 tools, 4 prompts, 5 resources |
| Hardhat test suite | ✅ Complete — 8 tests passing |
| Open source | ✅ MIT license |

## Server Modes

| Command | What starts |
|---------|-------------|
| `npm start` | MCP server (stdio) + REST API |
| `npm run start:mcp` | MCP server only |
| `npm run start:rest` | REST API only |

## Tech Stack & Dependencies

| Dep | Version | Purpose |
|---|---|---|
| `hardhat` | ^3.9.1 | Solidity dev environment |
| `ethers` | 5.8.0 | EVM interaction |
| `tsx` | ^4.23.0 | TypeScript script runner |
| `dotenv` | ^17.4.2 | .env config |
| `express` | ^5.2.1 | HTTP API server |
| `@flarenetwork/flare-periphery-contracts` | ^0.1.52 | FDC protocol interfaces |
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP server framework |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/signup` | Public | Create account + free API key |
| `POST` | `/auth/login` | Public | Log in and get a session token |
| `GET` | `/me` | Bearer token | Current user info and API keys |
| `GET` | `/health` | Public | Server status and network info |
| `GET` | `/dashboard` | Public | HTML user dashboard |
| `GET` | `/receipt/:txHash` | Public | View a receipt (HTML) |
| `POST` | `/api/v1/verify/xrp-payment` | API key | Attest an XRP tx |
| `GET` | `/api/v1/status/:id` | API key | Check attestation by UUID |
| `GET` | `/api/v1/status-by-tx/:txHash` | API key | Check attestation by txHash |
| `POST` | `/api/v1/webhooks` | API key | Register webhook callback |
| `POST` | `/billing/subscribe` | Bearer token | Upgrade subscription |
| `GET` | `/billing/portal` | Bearer token | Manage billing |
| `GET` | `/mcp/resources` | Public | List MCP resources |
| `GET` | `/mcp/prompts` | Public | List MCP prompts |

## MCP Tools

| Tool | Description |
|------|-------------|
| `verify_xrp_payment` | Submit txHash for FDC attestation |
| `get_attestation_status` | Check attestation by UUID |
| `lookup_attestation_by_tx` | Find attestation by txHash |
| `get_attestation_by_round` | List attestations by round ID |
| `get_server_info` | Server + network info |

Connect via stdio: `npm run start:mcp`

## Network Configuration

| Param | Coston2 (Testnet) | Flare Mainnet |
|---|---|---|
| RPC | `https://coston2-api.flare.network` | `https://flare-api.flare.network` |
| Chain ID | 114 | 14 |
| FdcHub | `0x48aC463d7975828989331F4De43341627b9c5f1D` | `0xc25c749DC27Efb1864Cb3DADa8845B7687eB2d44` |
| FdcVerification | `0x906507E0B64bcD494Db73bd0459d1C667e14B933` | `0x9394c7A36b3Da8de1b4F27cdD0a554dA4Fa7132d` |
| DA Layer | `https://ctn2-data-availability.flare.network` | `https://flr-data-availability.flare.network` |
| Verifier API | `https://fdc-verifiers-testnet.flare.network` | `https://fdc-verifiers-mainnet.flare.network` |
| Source ID | `testXRP` | `XRP` |
| First Voting Round | `1658430000` | `1658430000` |
| Attestation fee | 1 test FLR | 20 FLR |

## Architecture

```
┌───────────────────────┐
│     User dApp         │  (Flare EVM)
│  (PaymentVerifier.sol)│
└────────┬──────────────┘
         │ verifyXRPPayment(proof)
         ▼
┌───────────────────────┐
│  FdcVerification      │  (enshrined FDC protocol contract)
│  (via ContractRegistry)│
└────────┬──────────────┘
         │
    ┌────┴────┐
    │ DA Layer│──── Proof + response
    └────┬────┘
         │
    ┌────┴────┐
    │ Verifier│──── ABI-encoded request with MIC
    └────┬────┘
         │
    XRP Testnet / Mainnet
```

**Key data flow:**
1. XRP tx happens on XRP Ledger
2. Verifier API fetches tx details, computes MIC, returns ABI-encoded request
3. Request submitted to FdcHub on Flare with FLR fee
4. FDC providers independently verify the XRP tx, reach consensus (90s round)
5. Merkle root stored onchain via Relay contract
6. DA Layer serves attestation response + Merkle proof
7. Smart contract verifies proof against onchain Merkle root via FdcVerification

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributions welcome —
bug fixes, feature requests, docs improvements, and test additions.

XRPLink is open source (MIT) and built for the Flare ecosystem.

## License

MIT — see [LICENSE](LICENSE).
