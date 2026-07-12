import { ethers } from "ethers";
import { readFileSync } from "fs";
import { config, activeNetwork } from "../src/config.js";

async function main() {
  const roundId = parseInt(process.argv[2] || "0");
  const txHashRaw = process.argv[3] || "87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F";
  const txHash = "0x" + txHashRaw;
  const proofOwner = new ethers.Wallet(config.privateKey).address;

  // Recompute the same ABI-encoded request
  const attestationType = ethers.utils.formatBytes32String("XRPPayment");
  const sourceId = ethers.utils.formatBytes32String(activeNetwork.sourceId);
  const requestBody = ethers.utils.defaultAbiCoder.encode(["bytes32", "address"], [txHash, proofOwner]);
  const mic = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32", "bytes32", "bytes", "string"], [attestationType, sourceId, requestBody, "Flare"])
  );
  const abiEncoded = attestationType + sourceId.slice(2) + mic.slice(2) + requestBody.slice(2);

  if (!roundId) {
    console.error("Usage: tsx scripts/fetch-proof.ts <roundId> [txHash]");
    process.exit(1);
  }

  console.log("Fetching proof for round", roundId, "on", config.network);
  console.log("Source:", activeNetwork.sourceId);
  console.log("DA Layer:", activeNetwork.daLayerUrl);
  console.log();

  // Fetch proof
  const response = await fetch(
    `${activeNetwork.daLayerUrl}/api/v0/fdc/get-proof-round-id-bytes`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": config.verifierApiKey,
      },
      body: JSON.stringify({
        votingRoundId: roundId,
        requestBytes: abiEncoded,
      }),
    }
  );

  if (response.status === 400) {
    console.log("Not ready yet (HTTP 400). Wait 30s and retry.");
    process.exit(0);
  }

  if (!response.ok) {
    console.error(`DA Layer error (${response.status}):`, await response.text());
    process.exit(1);
  }

  const proofData = await response.json();
  console.log("✅ Proof retrieved!");
  console.log("Merkle proof entries:", proofData.proof?.length ?? 0);
  console.log();

  // Verify on-chain
  if (config.paymentVerifierAddress) {
    console.log("Verifying on-chain via PaymentVerifierMainnet...");
    const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
    const wallet = new ethers.Wallet(config.privateKey, provider);
    const artifact = JSON.parse(
      readFileSync("./artifacts/contracts/PaymentVerifierMainnet.sol/PaymentVerifierMainnet.json", "utf8")
    );
    const verifier = new ethers.Contract(config.paymentVerifierAddress, artifact.abi, wallet);

    const tx = await verifier.processPaymentProof({
      merkleProof: proofData.proof,
      data: proofData.response,
    });
    console.log("Verify TX:", tx.hash);
    const receipt = await tx.wait();
    console.log("Confirmed in block", receipt.blockNumber);

    const count = await verifier.getPaymentCount();
    console.log("On-chain verified payments:", count.toString());
    console.log("\n✅ End-to-end attestation complete!");
  } else {
    console.log("PAYMENT_VERIFIER_ADDRESS not configured. Skipping on-chain verification.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
