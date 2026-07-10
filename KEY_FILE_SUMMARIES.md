# Key File Summaries

## 1. `contracts/PaymentVerifier.sol` — Core Smart Contract
**Purpose:** Verifies XRP payment proofs attested through Flare's FDC protocol. This is the contract that XRPLink's customers would integrate.

**Key functions:**
- `processPaymentProof(IXRPPayment.Proof calldata _proof)` — Entry point. Validates the FDC proof, checks `status == 0` (success), prevents replay via `processedTransactions` mapping, records the verified payment details
- `isProofValid(IXRPPayment.Proof memory _proof)` — Calls `ContractRegistry.getFdcVerification().verifyXRPPayment(_proof)` — the actual FDC crypto verification
- `getVerifiedPayments()` / `getPaymentCount()` — View functions for reading state

**Structs:** `VerifiedPayment { transactionId, sourceAddress, receivingAddressHash, receivedAmount, firstMemoData, destinationTag }`

**Gotchas:**
- Uses **IXRPPayment** (not IPayment) — this is the XRP-specific attestation type that exposes memo data and destination tags. The generic `IPayment` doesn't have these fields
- ContractRegistry address is resolved dynamically from the FSP — no hardcoded addresses needed
- The `Proof` struct is complex: nested tuple of `(bytes32[] merkleProof, Response data)` where Response itself has 5+ layers of nesting

---

## 2. `scripts/prepare-request.ts` — Attestation Preparation
**Purpose:** Calls the Flare verifier API to validate an XRP transaction and produce the ABI-encoded request (with MIC) needed for FdcHub submission.

**Key details:**
- Reads `XRP_TX_HASH` and `PRIVATE_KEY` from .env
- Derives proofOwner address from PRIVATE_KEY wallet
- Attestation type encoded as the string "XRPPayment" padded to 32 bytes: `0x5852505061796d656e7400000000000000000000000000000000000000000000`
- Source ID encoded as "testXRP" padded: `0x7465737458525000000000000000000000000000000000000000000000000000`
- POSTs to `https://fdc-verifiers-testnet.flare.network/verifier/xrp/XRPPayment/prepareRequest`
- Saves `ABI_ENCODED_REQUEST` to .env

**Status:** ✅ Works (returned VALID)

---

## 3. `scripts/submit-request.ts` — FdcHub Submission
**Purpose:** Submits the ABI-encoded attestation request to the FdcHub contract on Coston2, paying the FLR fee.

**Key details:**
- Uses ethers v5: `new ethers.providers.JsonRpcProvider()`, `new ethers.Wallet(pk, provider)`
- ABI: `["function requestAttestation(bytes _data) external payable"]`
- Fee: 1 test FLR (`ethers.utils.parseEther("1")`)
- Calculates round ID from block timestamp

**Known bug:** Uses `FIRST_VOTING_ROUND_START_TS = 1658429955` which is for Songbird/Coston. Coston2 correct value: `1658430000`. This means `roundId` logged to console is wrong (showed 1389760, actual was ~1389493).

**Status:** ⚠️ Submission tx went through (block 32635719, tx `0xcbb9687...`) but round ID is wrong

---

## 4. `scripts/verify-proof.ts` — Proof Retrieval & Verification
**Purpose:** Fetches the Merkle proof from the DA Layer and (ideally) verifies it on-chain.

**Issues (multiple, needs rewrite):**
- ❌ Uses `import { ethers } from "ethers"` (ESM) but package.json is CommonJS — will crash at runtime
- ❌ Uses `new ethers.JsonRpcProvider()` (ethers v6 API) — installed version is 5.8.0
- ❌ DA Layer URL: `https://da-layer-coston2.flare.network` — does not resolve. Correct: `https://ctn2-data-availability.flare.network`
- ❌ Missing `X-API-KEY` header in DA Layer request
- ⚠️ Hardhat ContractFactory deployment approach is overly complex — deploy PaymentVerifier.sol via Hardhat task instead

**Status:** ❌ Broken — needs full rewrite

---

## 5. `scripts/send-xrp-test.ts` — XRP Testnet Transaction
**Purpose:** Creates and sends an XRP testnet payment with memo data for use in FDC attestation testing.

**Key details:**
- Connects to XRP testnet via WebSocket: `wss://s.altnet.rippletest.net:51233`
- `client.fundWallet()` creates + funds a test wallet from the XRP testnet faucet
- Sends 1 XRP payment with:
  - MemoData: `"XRPLinkTest"` (hex-encoded, padded)
  - MemoType: `"https://xrplink.io"` (hex-encoded)
- Saves transaction hash to .env

**Status:** ✅ Works (tx `388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22`)

---

## 6. `scripts/check-balance.ts` — Wallet Balance Check
**Purpose:** Quick balance check for the Coston2 test wallet.

**Correct syntax:** Uses `const ethers = require("ethers")` and `new ethers.providers.JsonRpcProvider()` (v5). Good reference pattern for other scripts.

**Status:** ✅ Works (shows 100 test FLR)

---

## 7. `hardhat.config.ts` — Hardhat Configuration
**Purpose:** Hardhat configuration with Coston2 and Flare mainnet network definitions.

**Issue:** Accounts from `PRIVATE_KEY` env var is not wired up — network configs don't include `accounts`. Will need `accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []` added to deploy contracts.

**Status:** ⚠️ Needs accounts config for contract deployment
