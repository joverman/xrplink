# XRPLink — Next Steps for Cursor/Opencode

## Current State
The FDC attestation pipeline has been set up and partially tested on Coston2 testnet. An XRP testnet transaction was created, the attestation request was prepared (VALID), submitted to FdcHub (tx confirmed in block 32635719), but proof retrieval from the DA Layer failed. The verify-proof.ts script has code bugs and the round calculation constant was wrong for Coston2.

## What to Fix First (Priority Order)

### 1. Fix Round Calculation Constant
The `FIRST_VOTING_ROUND_START_TS` in `submit-request.ts` is `1658429955` (Songbird/Coston value). Coston2 correct value is `1658430000`. Update it, then recalculate the correct round ID for our existing submission.

- Block 32635719 timestamp: 1783484391
- Correct round: (1783484391 - 1658430000) / 90 = 1389493
- Query the DA Layer at round 1389493 with the saved ABI_ENCODED_REQUEST

### 2. Rewrite verify-proof.ts
Current file is broken (wrong ethers imports, wrong DA Layer URL, missing API key). Rewrite using the same CommonJS + ethers v5 pattern that submit-request.ts uses:
- `const { ethers } = require("ethers")`
- Correct DA Layer URL: `https://ctn2-data-availability.flare.network`
- Include `X-API-KEY: 00000000-0000-0000-0000-000000000000` header
- After getting proof, deploy PaymentVerifier.sol via Hardhat compile + deploy task to Coston2, then call `processPaymentProof()`

### 3. Resubmit Attestation (if round 1389493 fails)
If the attestation isn't found at any round (meaning it failed consensus):
- Run `prepare-request.ts` again (should still work with the existing XRP_TX_HASH)
- Run `submit-request.ts` (will automatically calculate correct round after fixing the constant)
- Wait 90-180 seconds
- Run `verify-proof.ts <roundId>` with the corrected script

### 4. Deploy PaymentVerifier to Coston2
Once proof retrieval works:
- Add accounts config to hardhat.config.ts from PRIVATE_KEY env
- Run `npx hardhat compile`
- Write a Hardhat deploy script for PaymentVerifier.sol
- Deploy to Coston2
- Call `processPaymentProof()` with the retrieved proof

### 5. Build the API Wrapper
Once the Solidity pipeline is fully validated:
- Build a simple REST API (Express/Fastify) with endpoints:
  - `POST /api/v1/verify/xrp-payment { txHash }` — submits to FdcHub, returns round ID
  - `GET /api/v1/status/:roundId` — polls DA Layer, returns proof when ready
- Add webhook callback on successful verification

### 6. Apply for Flare Grant
- Flare grants program offers token grants, up to $200k Google Cloud credits ($350k for AI projects), co-marketing, advisory
- Thesis: "XRP Data Infrastructure for the Flare Ecosystem"

## Saved Resources
- `.env` contains: PRIVATE_KEY, VERIFIER_API_KEY, ABI_ENCODED_REQUEST, XRP_TX_HASH
- Coston2 wallet has 99 test FLR remaining (1 spent on attestation fee)
- Product sketch: `~/mycode/xrp-link-product-sketch.md`
- FDC docs index: `https://dev.flare.network/llms.txt`
- XRPPayment attestation docs: `https://dev.flare.network/fdc/attestation-types/xrp-payment.md`
- FDC getting-started (with submit/verify patterns): `https://dev.flare.network/fdc/getting-started.md`
- Contract registry guide: `https://dev.flare.network/network/guides/flare-contracts-registry.md`

## Important Gotchas
1. **ethers v5, not v6** — use `new ethers.providers.JsonRpcProvider()`, not `new ethers.JsonRpcProvider()`
2. **CommonJS** — `require()`, not `import`. Package.json has `"type": "commonjs"`
3. **DA Layer URL** — `https://ctn2-data-availability.flare.network`, not `da-layer-coston2.flare.network`
4. **FIRST_VOTING_ROUND** — `1658430000` for Coston2, not `1658429955`
5. **XRPPayment vs Payment** — use `IXRPPayment` interface (not `IPayment`) for memo data + destination tag support. Verify with `fdc.verifyXRPPayment(_proof)` not `fdc.verifyPayment()`
6. **Attestation type encoding** — the attestation type is the *string* "XRPPayment" padded to 32 bytes, not the numeric ID 0x08
