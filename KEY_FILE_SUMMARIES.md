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
- Calculates round ID from block timestamp using `FIRST_VOTING_ROUND_START_TS = 1658430000` (correct Coston2 value)

**Status:** ✅ Working — constant corrected to Coston2 value. Submit attestation, then wait 90s and run verify-proof.ts with the reported round ID.

---

## 4. `scripts/verify-proof.ts` — Proof Retrieval & Verification
**Purpose:** Fetches the Merkle proof from the DA Layer and optionally verifies it on-chain via the PaymentVerifier contract.

**Key details:**
- Uses ethers v5: `new ethers.providers.JsonRpcProvider()`, `new ethers.Wallet()`, `ethers.BigNumber.from()`
- Correct DA Layer URL: `https://ctn2-data-availability.flare.network`
- Includes `X-API-KEY` header from `VERIFIER_API_KEY` env var
- Accepts round ID and optional contract address as CLI arguments
- Builds the IXRPPayment.Proof struct from DA Layer response
- If contract address provided, calls `processPaymentProof()` on-chain

**Usage:** `tsx scripts/verify-proof.ts <roundId> [contractAddress]`

**Status:** ✅ Working — bugs resolved. Matches the same ethers v5 + ESM pattern used in `submit-request.ts` and `deploy-verifier.ts`.

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

**Correct syntax:** Uses `import { ethers } from "ethers"` and `new ethers.providers.JsonRpcProvider()` (v5). Good reference pattern for other scripts. Note: project uses ESM (`"type": "module"`) — all scripts use `import`, not `require()`.

**Status:** ✅ Works (shows wallet balance)

---

## 7. `hardhat.config.ts` — Hardhat Configuration
**Purpose:** Hardhat configuration with Coston2 and Flare mainnet network definitions.

**Key details:**
- Uses `@nomicfoundation/hardhat-toolbox-viem` plugin
- Accounts wired from `PRIVATE_KEY` env var: `const accounts = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []`
- Both coston2 and flare networks include `accounts`
- Solidity 0.8.25, EVM cancun target, optimizer enabled

**Status:** ✅ Working — accounts configured, compile passes, tests pass
