# Project Context & Roadmap

## Current State

The project is in **technical validation phase** — proving the end-to-end FDC attestation pipeline works for XRP payments on Flare Coston2 before building the product layer.

### What Works
- **FDC XRPPayment attestation type is confirmed supported** on both Coston2 (testXRP) and Flare mainnet (XRP)
- **Verifier API** accepts XRP tx hashes, validates sources, returns ABI-encoded requests with MIC — the public API key `00000000-0000-0000-0000-000000000000` works for testnet
- **FdcHub.requestAttestation()** accepts and processes requests on Coston2 (tested: tx `0xcbb9687...`)
- **PaymentVerifier.sol** compiles, imports IXRPPayment/IFdcVerification from Flare periphery contracts
- **XRP testnet tx with memo** successfully created and verified on XRPL explorer

### What's Blocked
- **Proof retrieval from DA Layer failed** — the attestation request was submitted successfully but the DA Layer returns "attestation request not found" for all attempted rounds
- **Root cause (most likely):** the `FIRST_VOTING_ROUND_START_TS` constant (`1658429955`) was for Songbird/Coston testnet, not Flare/Coston2. The correct Coston2 value is `1658430000`. This means the script calculated the wrong round ID when tracking the attestation. The attestation may have been included in round **1389493** (not 1389760 as the script reported) — or it may have failed consensus entirely.
- **verify-proof.ts** has broken code:
  - Uses `import { ethers }` (ESM) but package.json is `commonjs`
  - Uses `new ethers.JsonRpcProvider()` (ethers v6) but installed version is 5.8.0
  - Uses wrong DA Layer URL (`https://da-layer-coston2.flare.network` — doesn't resolve)
  - Correct URL: `https://ctn2-data-availability.flare.network`
- **FDC fee viability** — paid 1 test FLR but unclear if this was sufficient minimum for the XRPPayment attestation type

## Roadmap

### Phase 0 — Technical Validation (current)
- Fix round calculation constant in scripts
- Fix verify-proof.ts: correct DA Layer URL, correct ethers v5 syntax
- Resubmit attestation with correct constants
- Retrieve proof from DA Layer
- Verify proof on-chain via PaymentVerifier contract deployment

### Phase 1 — MVP (next)
- Deploy PaymentVerifier to Coston2
- Build REST API wrapper: `POST /api/v1/verify/xrp-payment { txHash } → { proof, status, amount }`
- Manage FDC round lifecycle: submit, poll, cache, respond
- Webhook callbacks on successful attestation

### Phase 2 — Product (future)
- Multi-tier subscription model ($free/$99/$299)
- Xahau DEX data feeds
- Dashboard for monitoring attestations
- Flare grant application
- Mainnet deployment

### Phase 3 — Scale
- MCP server for agent-driven attestation
- Custom data feeds via Web2Json (when it hits mainnet)
- White-label for protocols

## Known Issues & Technical Debt

| Issue | Severity | Notes |
|---|---|---|
| **Round calc constant wrong** | HIGH | `submit-request.ts` shows round 1389760; actual round was 1389493. Fix FIRST_VOTING_ROUND_START_TS to 1658430000 for Coston2 |
| **verify-proof.ts broken** | HIGH | Wrong ethers imports, wrong DA Layer URL, uses v6 syntax with v5 installed |
| **All scripts use CommonJS** | MEDIUM | Inconsistent — some use `import`, some use `require()`. Standardize on one (CommonJS works with installed ethers v5) |
| **No Hardhat compile tested** | MEDIUM | `@flarenetwork/flare-periphery-contracts` installed but `npx hardhat compile` not yet run — may have Solidity version incompatibilities |
| **Coston2 firstVotingRound constant undetermined** | MEDIUM | The value `1658430000` was derived from round timestamps but not verified against Flare docs or chain state |
| **Fee structure unknown** | LOW | Paid 1 test FLR as minimum; no documentation on minimum fee per attestation type |
| **No test suite** | LOW | Should add Hardhat tests once pipeline is validated |
| **No gas benchmarking** | LOW | FDC attestation fees on mainnet will be real FLR — need to know cost per verification |

## Design Patterns & Constraints

1. **FDC fee pass-through** — attestation fees are paid to FDC providers. The product either bundles fees into subscription or charges per-verification on top
2. **90-second round latency** — FDC consensus rounds take 90 seconds. The API design must account for this: submit → poll → respond, not synchronous
3. **MIC pre-commitment** — the Message Integrity Code commits the requestor to an expected response before the round completes. This means the verifier service (which we run in production) must compute MIC from real data. The public testnet verifier is rate-limited
4. **Proof caching** — once an attestation round completes, the Merkle proof is available indefinitely. Duplicate verifications of the same tx should be cached, not re-attested
5. **xrpl v5 vs v6 inconsistency** — ethers 5.8.0 is installed (from hardhat-deploy deps). All scripts must use v5 API: `new ethers.providers.JsonRpcProvider()`, `ethers.utils.formatEther()`, `require("ethers")` not `import`
