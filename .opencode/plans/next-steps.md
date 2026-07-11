# Next Steps — Execution Plan

## 1. Test Agent-Native Build

### Scope
Full integration test of the MCP-first architecture. Verify that every component works correctly and that the system behaves correctly for AI agents.

### Test Cases

#### 1.1 MCP Tools (stdio)
- `tools/list` — confirm 5 tools returned
- `tools/call verify_xrp_payment` — submit valid txHash → returns pending/verified
- `tools/call verify_xrp_payment` — submit invalid txHash → returns enriched error with `suggestedAction`
- `tools/call get_attestation_status` — lookup by UUID
- `tools/call lookup_attestation_by_tx` — lookup by txHash
- `tools/call get_attestation_by_round` — filter by round ID
- `tools/call get_server_info` — returns network + branding

#### 1.2 MCP Resources (stdio)
- `resources/list` — confirm 5 resources
- `resources/read xrplink://docs/overview` — returns markdown
- `resources/read xrplink://docs/config` — returns config with live network values
- `resources/read xrplink://docs/network` — returns contract addresses
- `resources/read xrplink://docs/tools` — returns usage guide
- `resources/read xrplink://network/status` — returns live data (block number, balance)

#### 1.3 MCP Prompts (stdio)
- `prompts/list` — confirm 4 prompts
- `prompts/get welcome` — returns introduction
- `prompts/get verify_flow` — returns step-by-step guide
- `prompts/get admin_setup` — returns config guide
- `prompts/get troubleshoot` — returns common issues

#### 1.4 SSE Streaming
- Start server with `npm start:rest`
- Connect to `GET /mcp` — should receive SSE event stream
- Submit an attestation — should receive SSE notification on completion

#### 1.5 HTTP API + Enriched Errors
- `GET /health` — returns branding
- `POST /api/v1/verify/xrp-payment` without API key → `MISSING_API_KEY` with `suggestedAction`
- Same with bad API key → `INVALID_API_KEY` with `suggestedAction`
- Same with bad txHash → `INVALID_TX_HASH` with `suggestedAction`
- Same with valid key + valid txHash → returns `verified` (cached)
- `GET /mcp/resources` — returns all 5 resources as JSON
- `GET /mcp/prompts` — returns all 4 prompts as JSON

#### 1.6 Full Pipeline (if there's test FLR)
- Submit a real XRP testnet tx → attest → poll → verify on-chain via HTTP and MCP

### Success Criteria
- All MCP tools respond correctly
- All MCP resources return valid markdown content
- All MCP prompts return structured guides
- Enriched errors include `error`, `message`, `suggestedAction`, `docsUrl`
- SSE stream receives attestation completion events
- `/mcp/resources` and `/mcp/prompts` HTTP endpoints return valid JSON

---

## 2. Join Cloudflare Monetization Gateway Waitlist

### Steps
1. Open the waitlist form: https://docs.google.com/forms/d/e/1FAIpQLSfq6yaIgp57FCGFg7riXlSWTeD8d8Adur2c8tWaKY4SuzweiQ/viewform
2. Fill in: Cloudflare account info, use case details
3. Prepare a document describing x402 integration plan for XRPLink

### x402 Integration Plan (document)
```
# XRPLink x402 Integration

## What we'd charge for
| Resource | Price | Description |
|----------|-------|-------------|
| verify_xrp_payment (MCP tool) | $0.01 | Cost of FDC attestation fee + gas |
| POST /api/v1/verify/xrp-payment | $0.01 | Same via REST |
| Status checks | Free | No cost to check attestation state |

## How it works
1. Agent calls verify_xrp_payment with a txHash
2. Server responds 402 Payment Required: { price: 0.01, asset: "USDC", address: "..." }
3. Agent sends payment via x402 protocol
4. Server verifies payment, submits attestation to FdcHub
5. Agent receives attestation ID
6. Agent polls for completion via get_attestation_status (free)

## Why x402
- No API key management required for agents
- Sub-cent micropayments feasible
- Stablecoin settlement (no FLR conversion needed)
- Agent pays autonomously without human signup
- Cloudflare handles payment verification at the edge

## What we need from Monetization Gateway
- Pay-per-MCP-tool-call pricing
- x402 protocol support at the edge
- Dashboard for revenue tracking
```

### Files to create
- `docs/x402-integration.md` — Integration plan doc

---

## 3. Test Suite

### Scope
Hardhat tests for `PaymentVerifier.sol` and `PaymentVerifierMainnet.sol`.

### Test cases

#### 3.1 Unit tests
- `isProofValid` — returns false for invalid proof structure
- `processPaymentProof` — reverts for invalid proof
- `processPaymentProof` — reverts for already-processed transaction (replay protection)
- `processPaymentProof` — emits `PaymentVerified` event with correct args
- `processPaymentProof` — stores verified payment in array
- `getPaymentCount` — returns correct count
- `getVerifiedPayments` — returns stored payments
- `processedTransactions` — correctly tracks processed tx IDs

#### 3.2 Integration tests
- Deploy contract + FDC mock
- Submit valid proof → verify → check state
- Submit same proof twice → revert

#### 3.3 Mock FDC contracts
Need to create mock contracts that implement `IFdcVerification` and `IXRPPayment` for testing without live Flare network.

### Files to create
- `test/PaymentVerifier.test.ts` — Main test file
- `contracts/test/MockFdcVerification.sol` — Mock FDC contract for tests
- `contracts/test/MockContractRegistry.sol` — Mock registry returning mock FDC

### Running tests
```bash
npx hardhat test
```

---

## 4. Flare Grant Application

### Thesis
"XRP Data Infrastructure for the Flare Ecosystem"

### Application sections

#### Problem
Developers building cross-chain applications (bridges, payment verifiers, escrow services) need to verify XRP payment data on-chain. Without a service like XRPLink, each developer must:
- Manage FDC attestation rounds and fees
- Implement Merkle proof verification
- Build DA Layer polling infrastructure
- Handle MIC computation and verifier API integration
This is complex, error-prone, and expensive to build per-project.

#### Solution
XRPLink is an agent-native XRP payment attestation layer that wraps Flare's FDC protocol into:
- A one-click API/MCP endpoint for XRP payment verification
- A deployed PaymentVerifier smart contract (Coston2 + Flare mainnet)
- Persistent proof caching
- Webhook and SSE notifications
- An MCP server for AI agent consumption

#### Traction (validated)
- End-to-end pipeline proven on Coston2 testnet
- XRP testnet transaction verified on-chain via FDC attestation
- Attestation proof retrieved and verified through PaymentVerifier contract
- All phases (0-3.5) implemented

#### Why Flare
XRPLink is built exclusively on Flare FDC — it's a showcase application for Flare's data attestation protocol. A successful XRPLink demonstrates:
- FDC's viability for real-world cross-chain use cases
- Developer demand for XRP data on Flare
- A blueprint for other asset attestation products (BTC, DOGE, LTC)

#### Grant request
- FLR token grant for mainnet attestation fees
- Google Cloud credits ($200k) for API server infrastructure
- Advisory: technical guidance on FDC protocol optimization

#### Team / Builder
- Solo developer
- Full pipeline: Solidity → Hardhat → Express → MCP → Cloudflare
- GitHub: (link)

### Files to create
- `docs/flare-grant-application.md` — Full grant application

---

## Execution Order

1. **Test agent-native build** — Verify everything works before writing docs/tests
2. **Write test suite** — Hardhat tests for PaymentVerifier
3. **Write Cloudflare integration doc** — x402 plan
4. **Write Flare grant application** — Full application doc
5. **Submit Cloudflare waitlist** — User action (form)
