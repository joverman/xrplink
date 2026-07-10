import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const DA_LAYER_URL = "https://ctn2-data-availability.flare.network";
const API_KEY = process.env.VERIFIER_API_KEY;

let PAYMENT_VERIFIER_ABI = null;

function getVerifierAbi() {
  if (PAYMENT_VERIFIER_ABI) return PAYMENT_VERIFIER_ABI;
  const artifact = JSON.parse(fs.readFileSync("./artifacts/contracts/PaymentVerifier.sol/PaymentVerifier.json", "utf8"));
  PAYMENT_VERIFIER_ABI = artifact.abi;
  return PAYMENT_VERIFIER_ABI;
}

async function fetchProofFromDALayer(roundId, abiEncodedRequest) {
  const url = `${DA_LAYER_URL}/api/v0/fdc/get-proof-round-id-bytes`;
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-KEY"] = API_KEY;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      votingRoundId: roundId,
      requestBytes: abiEncodedRequest,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const errMsg = `DA Layer error (${response.status}): ${text}`;
    return { error: errMsg };
  }

  return await response.json();
}

function toNum(v) {
  return typeof v === "string" ? Number(v) : v;
}

function toBN(v) {
  return ethers.BigNumber.from(v);
}

function buildProofStruct(proofData) {
  const resp = proofData.response;
  const rb = resp.responseBody;

  return {
    merkleProof: proofData.proof,
    data: {
      attestationType: resp.attestationType,
      sourceId: resp.sourceId,
      votingRound: toNum(resp.votingRound),
      lowestUsedTimestamp: toNum(resp.lowestUsedTimestamp),
      requestBody: {
        transactionId: resp.requestBody.transactionId,
        proofOwner: resp.requestBody.proofOwner,
      },
      responseBody: {
        blockNumber: toNum(rb.blockNumber),
        blockTimestamp: toNum(rb.blockTimestamp),
        sourceAddress: rb.sourceAddress,
        sourceAddressHash: rb.sourceAddressHash,
        receivingAddressHash: rb.receivingAddressHash,
        intendedReceivingAddressHash: rb.intendedReceivingAddressHash,
        spentAmount: toBN(rb.spentAmount),
        intendedSpentAmount: toBN(rb.intendedSpentAmount),
        receivedAmount: toBN(rb.receivedAmount),
        intendedReceivedAmount: toBN(rb.intendedReceivedAmount),
        hasMemoData: rb.hasMemoData,
        firstMemoData: rb.firstMemoData,
        hasDestinationTag: rb.hasDestinationTag,
        destinationTag: toBN(rb.destinationTag),
        status: toNum(rb.status),
      },
    },
  };
}

async function verifyOnChain(proofStruct, contractAddress) {
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const verifier = new ethers.Contract(contractAddress, getVerifierAbi(), wallet);

  console.log(`Calling processPaymentProof() on ${contractAddress}...`);
  const tx = await verifier.processPaymentProof(proofStruct);
  console.log(`  TX sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt.blockNumber}`);

  const count = await verifier.getPaymentCount();
  console.log(`  Verified payments count: ${count.toString()}`);
  console.log("✅ On-chain verification successful!");
}

function printSummary(proofData) {
  const data = proofData.response;
  const rb = data.responseBody;

  console.log("Proof data summary:");
  console.log(`  XRP Transaction: ${data.requestBody.transactionId}`);
  console.log(`  Round:           ${data.votingRound}`);
  console.log(`  Source:          ${rb.sourceAddress}`);
  console.log(`  Amount received: ${rb.receivedAmount} drops`);
  console.log(`  Amount spent:    ${rb.spentAmount} drops`);
  console.log(`  Status:          ${rb.status === "0" ? "✅ Success" : "❌ Failed"}`);
  console.log(`  Has Memo:        ${rb.hasMemoData}`);
  if (rb.hasMemoData) {
    console.log(`  Memo data:       ${rb.firstMemoData}`);
  }
  console.log(`  Has Dest Tag:    ${rb.hasDestinationTag}`);
  if (rb.hasDestinationTag) {
    console.log(`  Destination Tag: ${rb.destinationTag}`);
  }
}

async function main() {
  const roundId = process.argv[2] ? parseInt(process.argv[2]) : undefined;
  const contractAddress = process.argv[3];

  if (!roundId) {
    console.error("Usage: tsx scripts/verify-proof.ts <roundId> [contractAddress]");
    console.error("  roundId         — FDC voting round ID");
    console.error("  contractAddress — optional, deployed PaymentVerifier address for on-chain verification");
    console.error("Set ABI_ENCODED_REQUEST in .env");
    process.exit(1);
  }

  const abiEncoded = process.env.ABI_ENCODED_REQUEST;
  if (!abiEncoded) {
    console.error("ABI_ENCODED_REQUEST not set in .env");
    process.exit(1);
  }

  console.log(`Fetching proof for round ${roundId}...`);
  const proofData = await fetchProofFromDALayer(roundId, abiEncoded);

  if (proofData.error) {
    console.error(`\n❌ ${proofData.error}`);
    console.log("\nPossible causes:");
    console.log("  - Round hasn't finalized yet (wait 90-180s from submission)");
    console.log("  - Attestation failed consensus (wrong MIC or data)");
    console.log("  - Wrong round ID");
    console.log("  - ABI_ENCODED_REQUEST doesn't match what was submitted");
    process.exit(1);
  }

  console.log("✅ Proof retrieved from DA Layer!");
  console.log(`  Merkle proof entries: ${proofData.proof ? proofData.proof.length : 0}`);
  console.log();

  printSummary(proofData);

  const proofStruct = buildProofStruct(proofData);

  if (contractAddress) {
    console.log();
    await verifyOnChain(proofStruct, contractAddress);
  } else {
    console.log("\nTo verify on-chain, deploy PaymentVerifier.sol and pass its address:");
    console.log(`  tsx scripts/verify-proof.ts ${roundId} <deployed-contract-address>`);
  }

  return proofStruct;
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
