# XRPLink — Next Steps

## Current State
Phase 0 (Technical Validation) is **complete**. The end-to-end FDC attestation pipeline is validated on Coston2:
XRP testnet tx → verifier API → FdcHub → DA Layer → on-chain verification. All 8 tests pass.
MCP server and REST API start cleanly.

## Priority Roadmap

### 1. Mainnet Deployment
- Deploy PaymentVerifierMainnet.sol to Flare mainnet
- Update `.env` with mainnet RPC and contract address
- Test a real XRP transaction attestation on mainnet
- Confirm fee economics (FLR cost per attestation on mainnet)

### 2. Flare Grant Application
- docs/flare-grant-application.md is drafted — submit to Flare
- Request: FLR tokens for attestation fees + Google Cloud credits
- Timeline: ASAP (Phase 0 completion is strong validation)

### 3. x402 Monetization (Cloudflare Monetization Gateway)
- Join Cloudflare Monetization Gateway waitlist
- Implement 402 Payment Required responses for `verify_xrp_payment`
- Set pricing: $0.01 per attestation
- See docs/x402-integration.md for full plan

### 4. Promotion & Community
- Post to HN ("Show HN: XRPLink – XRP Payment Attestation on Flare FDC")
- Share on Flare Discord / Flare Dev Telegram
- Publish integration guide for developers
- Add CI badge to README (GitHub Actions for test status)

### 5. Production Hardening
- Add GitHub Actions CI: lint, compile, test
- Add `.nvmrc` / engines field in package.json
- Add monitoring (server uptime, attestation success rate)
- Fix Dockerfile to include `tsx` properly (currently uses `npm install -g tsx` workaround)
- Add `xrpl` to devDependencies (currently only a transitive dep)

### 6. Feature Roadmap
- Webhook retry logic with exponential backoff
- Xahau DEX data feeds (Phase 3)
- Dashboard v2 with real-time charts
- Custom data feeds via Web2Json

## Saved Resources
- `.env` contains: PRIVATE_KEY, VERIFIER_API_KEY, ABI_ENCODED_REQUEST, XRP_TX_HASH
- Coston2 wallet has ~99 test FLR remaining
- PaymentVerifier deployed at `0x6c3443ba8A11666BCEd0dA2f40c378a47b620cfc`
- FDC docs: `https://dev.flare.network/llms.txt`
- XRPPayment attestation docs: `https://dev.flare.network/fdc/attestation-types/xrp-payment.md`

## Important Gotchas
1. **ethers v5, not v6** — use `new ethers.providers.JsonRpcProvider()`, not `new ethers.JsonRpcProvider()`
2. **ESM modules** — `"type": "module"` in package.json. All scripts use `import`, not `require()`
3. **DA Layer URL** — `https://ctn2-data-availability.flare.network` (Coston2), `https://data-availability.flare.network` (mainnet)
4. **FIRST_VOTING_ROUND** — `1658430000` for Coston2, `1668510000` for Flare mainnet (see `src/config.ts`)
5. **XRPPayment vs Payment** — use `IXRPPayment` interface (not `IPayment`) for memo data + destination tag support
6. **Global `fetch`** — requires Node 18+. Available natively, no `node-fetch` dependency needed
