# XRPLink — XRP Payment Attestation on Flare FDC

**XRP data attestation layer for the Flare Network.** XRPLink wraps Flare's enshrined FDC (Flare Data Connector) protocol into a simple API + smart contract library, letting developers verify XRP payments and use XRP data on Flare without managing attestation rounds, Merkle proofs, or DA Layer interactions.

## Project Status

| Milestone | Status |
|---|---|---|
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
| Dockerfile | ✅ Complete |

## Tech Stack & Dependencies

| Dep | Version | Purpose |
|---|---|---|
| `hardhat` | ^3.9.1 | Solidity dev environment |
| `ethers` | 5.8.0 | EVM interaction (via hardhat-deploy) |
| `tsx` | ^4.23.0 | TypeScript script runner |
| `dotenv` | ^17.4.2 | .env config |
| `xrpl` | via npm | XRP Ledger testnet interaction |
| `@flarenetwork/flare-periphery-contracts` | ^0.1.52 | FDC protocol interfaces (IXRPPayment, IFdcVerification, ContractRegistry) |

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
| FIRST_VOTING_ROUND | `1658430000` (CRITICAL: not 1658429955) |
| Voting duration | 90 seconds |
| Faucet | `https://faucet.flare.network/coston2` (browser, requires captcha) |

### Flare Mainnet
| Param | Value |
|---|---|
| RPC | `https://flare-api.flare.network/ext/C/rpc` |
| Chain ID | 14 |
| FDC source ID | `XRP` (not `testXRP`) |

### XRP Testnet
| Param | Value |
|---|---|
| RPC | `wss://s.altnet.rippletest.net:51233` |
| Wallet funded | `rPfi6ALJ7wC5eBwfnZB7Uz2YfbrVTeAA5p` |

## Setup & Run

```bash
cd ~/mycode/xrp-link-test
npm install

# Set up .env (copy from .env.example)
# PRIVATE_KEY and XRP_TX_HASH are already populated

# Generate a new wallet
npm run wallet

# Check balance
npm run check-balance  # or: npx tsx scripts/check-balance.ts

# Send a new XRP testnet transaction
npx tsx scripts/send-xrp-test.ts

# Prepare attestation request (uses verifier API)
npx tsx scripts/prepare-request.ts

# Submit attestation to FdcHub
npx tsx scripts/submit-request.ts

# After ~90-180s, verify
npx tsx scripts/verify-proof.ts <roundId>
```

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

## Key Decisions

- **XRPPayment attestation type** used instead of generic Payment — gives direct access to memo data, source r-address as string, and destination tags
- **Coston2 testnet first** — validate pipeline before mainnet deployment
- **xv5 compatibility** — ethers v5 still required (installed via hardhat-deploy dependency); scripts use `require("ethers")` with `new ethers.providers.JsonRpcProvider()`
- **CommonJS modules** — `"type": "commonjs"` in package.json; scripts use `require()` not `import`
