# Project Context & Roadmap

## Current State

The project has completed **Phase 0 — Technical Validation** and is ready for **Phase 1 — Product Launch**. The end-to-end FDC attestation pipeline is validated on Coston2 testnet: XRP testnet tx → verifier API → FdcHub → DA Layer → on-chain verification.

### What Works
- **FDC XRPPayment attestation type is confirmed supported** on both Coston2 (testXRP) and Flare mainnet (XRP)
- **Verifier API** accepts XRP tx hashes, validates sources, returns ABI-encoded requests with MIC — the public API key `00000000-0000-0000-0000-000000000000` works for testnet
- **FdcHub.requestAttestation()** accepts and processes requests on Coston2
- **PaymentVerifier.sol** compiles, imports IXRPPayment/IFdcVerification from Flare periphery contracts
- **XRP testnet tx with memo** successfully created and verified on XRPL explorer
- **Proof retrieval from DA Layer** — works with correct URL `https://ctn2-data-availability.flare.network`
- **On-chain verification** — PaymentVerifier deployed at `0x6c3443ba8A11666BCEd0dA2f40c378a47b620cfc`, proof verification complete (payment count: 1)
- **REST API** — Express server with verify, status, webhooks, health, auth, rate limiting
- **MCP Server** — 5 tools, 5 resources, 4 prompts, stdio + SSE transport
- **Hardhat test suite** — 8 tests passing
- **White-label support** — brand name, colors, logo for pro-tier customers
- **Dashboard** — HTML dashboard at /dashboard
- **Docker support** — Dockerfile for containerized deployment

### What's Blocked (or needs attention)
- **FDC fee viability** — paid 1 test FLR but unclear if this was sufficient minimum for the XRPPayment attestation type on mainnet
- **x402 pay-per-attestation** — Cloudflare Monetization Gateway integration planned but not implemented (waiting for MG access)

## Roadmap

### Phase 0 — Technical Validation ✅ Complete
- Pipeline validated end-to-end on Coston2
- Round calculation constant confirmed: `1658430000` for Coston2, `1668510000` for Flare mainnet
- All scripts use ESM `import` with ethers v5 API
- PaymentVerifier.sol deployed and verified on-chain

### Phase 1 — Product Launch (current)
- Productionize REST API + MCP server
- Deploy to Coston2 and Flare mainnet
- Add monitoring, alerting, and uptime tracking
- Publish docs and integration guides
- Apply for Flare grant
- Open source promotion (HN, Flare community)

### Phase 2 — Monetization (next)
- Cloudflare x402 integration (pay-per-attestation)
- Multi-tier subscription model ($free/$99/$299)
- Subscription billing via Stripe or similar

### Phase 3 — Scale (future)
- Xahau DEX data feeds
- Custom data feeds via Web2Json
- Dashboard v2 with real-time charts

## Known Issues & Technical Debt

| Issue | Severity | Notes |
|---|---|---|
| **xrpl not in package.json** | LOW | `send-xrp-test.ts` imports `xrpl` but it's only a transitive dep — add to devDependencies |
| **No `.nvmrc` or engines** | LOW | Node 18+ required for global `fetch` — should document |
| **Fee structure unknown** | LOW | Paid 1 test FLR as minimum; no documentation on minimum fee per attestation type |
| **No gas benchmarking** | LOW | FDC attestation fees on mainnet will be real FLR — need to know cost per verification |
| **Dockerfile uses `npm ci --omit=dev`** | LOW | `tsx` is in devDependencies; workaround via `npm install -g tsx` but should be cleaned up |
| **TypeScript strict mode** | LOW | `src/middleware.ts` uses `(req as any)` cast — could be stricter |

## Design Patterns & Constraints

1. **FDC fee pass-through** — attestation fees are paid to FDC providers. The product either bundles fees into subscription or charges per-verification on top
2. **90-second round latency** — FDC consensus rounds take 90 seconds. The API design must account for this: submit → poll → respond, not synchronous
3. **MIC pre-commitment** — the Message Integrity Code commits the requestor to an expected response before the round completes. This means the verifier service (which we run in production) must compute MIC from real data. The public testnet verifier is rate-limited
4. **Proof caching** — once an attestation round completes, the Merkle proof is available indefinitely. Duplicate verifications of the same tx should be cached, not re-attested
5. **ethers v5** — ethers 5.8.0 is installed (from hardhat-deploy deps). All code uses v5 API: `new ethers.providers.JsonRpcProvider()`, `ethers.utils.formatEther()`, `ethers.BigNumber.from()`
6. **ESM modules** — Package has `"type": "module"`. All scripts use `import` syntax. `tsx` is used as the TypeScript runner
7. **Global `fetch`** — Node 18+ required; `fetch` is used directly in scripts and service layer (no `node-fetch` dependency)
