> **⚠️ Alpha Software** — XRPLink is in active development. The pipeline is validated on
> Coston2 testnet. Mainnet deployment and production use pending. Use at your own risk.

# XRPLink — XRP Payment Attestation on Flare FDC

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**XRP data attestation layer for the Flare Network.** XRPLink wraps Flare's enshrined FDC (Flare Data Connector) protocol into a simple API + smart contract library, letting developers verify XRP payments and use XRP data on Flare without managing attestation rounds, Merkle proofs, or DA Layer interactions.

## Quick Start

```bash
git clone <repo-url>
cd xrplink
npm install
cp .env.example .env
# Edit .env with your private key and API key
npm run start:rest
curl http://localhost:3000/health
```

Then open `http://localhost:3000/dashboard` in your browser.

## Project Status

| Milestone | Status |
|---|---|
| Product sketch (v0.1) | ✅ Complete |
| Project scaffolding (Hardhat + scripts) | ✅ Complete |
| Coston2 wallet generated & funded (100 test FLR) | ✅ Complete |
| XRP testnet tx with memo created | ✅ Complete |
| FDC attestation request prepared (verifier = VALID) | ✅ Complete |
| Attestation submitted to FdcHub on Coston2 | ✅ Complete (round 1389768) |
| Proof retrieval from DA Layer | ✅ Complete — 3 Merkle entries |
| PaymentVerifier.sol deployed to Coston2 | ✅ Complete (`0x6c3443ba8A11666BCEd0dA2f40c378a47b620cfc`) |
| On-chain proof verification | ✅ Complete — payment count: 1 |
| End-to-end pipeline validated | ✅ **Phase 0 Complete** |
| REST API (Express) | ✅ Complete — verify, status, webhooks, health |
| Proof caching | ✅ Complete — checks PaymentVerifier contract |
| Background polling | ✅ Complete — polls DA Layer after submission |
| API key authentication | ✅ Complete — X-API-Key header on all protected routes |
| Subscription tiers | ✅ Complete — free (10/min), paid (100/min), pro (unlimited) |
| Admin key management | ✅ Complete — create/list/delete keys (pro-only) |
| Dashboard | ✅ Complete — HTML dashboard at /dashboard |
| Persistent storage | ✅ Complete — JSON files in data/ |
| Flare mainnet contract | ✅ Complete — PaymentVerifierMainnet.sol |
| MCP Server (agent-native) | ✅ Complete — 5 tools, 5 resources, 4 prompts |
| Hardhat test suite | ✅ Complete — 8 tests passing |
| Open source release | ✅ Complete — MIT license |

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
| `xrpl` | via npm | XRP Ledger testnet interaction |
| `@flarenetwork/flare-periphery-contracts` | ^0.1.52 | FDC protocol interfaces |
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP server framework |
| `express` | ^5.2.1 | HTTP API server |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | Public | Server status and network info |
| `GET` | `/dashboard` | Public | HTML dashboard |
| `POST` | `/api/v1/verify/xrp-payment` | API key | Submit txHash for attestation |
| `GET` | `/api/v1/status/:id` | API key | Check attestation by UUID |
| `GET` | `/api/v1/status-by-tx/:txHash` | API key | Check attestation by txHash |
| `POST` | `/api/v1/webhooks` | API key | Register webhook callback |
| `GET\|PUT` | `/api/v1/admin/white-label` | Pro key | Manage branding |
| `GET\|POST\|DELETE` | `/api/v1/admin/keys` | Pro key | Manage API keys |
| `GET` | `/mcp/resources` | Public | List MCP resources |
| `GET` | `/mcp/prompts` | Public | List MCP prompts |
| `GET` | `/mcp` | Public | SSE event stream |

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

### Coston2 (Flare Testnet)
| Param | Value |
|---|---|
| RPC | `https://coston2-api.flare.network/ext/C/rpc` |
| Chain ID | 114 |
| FdcHub | `0x48aC463d7975828989331F4De43341627b9c5f1D` |
| FdcVerification | `0x906507E0B64bcD494Db73bd0459d1C667e14B933` |
| ContractRegistry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` |
| Verifier API | `https://fdc-verifiers-testnet.flare.network` |
| DA Layer | `https://ctn2-data-availability.flare.network` |
| Public API Key | `00000000-0000-0000-0000-000000000000` |
| FIRST_VOTING_ROUND | `1658430000` |
| Voting duration | 90 seconds |
| Faucet | `https://faucet.flare.network/coston2` |

### Flare Mainnet
| Param | Value |
|---|---|
| RPC | `https://flare-api.flare.network/ext/C/rpc` |
| Chain ID | 14 |
| FDC source ID | `XRP` (not `testXRP`) |

Set `FLARE_NETWORK=flare` in `.env` to switch.

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
