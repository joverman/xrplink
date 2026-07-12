import { ethers } from "ethers";
import { readFileSync } from "fs";
import { config, activeNetwork } from "../src/config.js";
import * as fdc from "../src/fdc-service.js";

const TX_HASH = process.argv[2] || "87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F";

async function main() {
  console.log("=== XRPLink Mainnet Attestation ===\n");
  console.log("Network:", config.network);
  console.log("TX Hash:", TX_HASH);
  console.log("Verifier:", activeNetwork.verifierBaseUrl);

  const proofOwner = fdc.getProofOwner();
  console.log("Proof owner:", proofOwner);
  console.log();

  // 1. Prepare
  console.log("1. Preparing attestation request...");
  const abiEncoded = await fdc.prepareRequest(TX_HASH, proofOwner);
  console.log("   ABI encoded request length:", abiEncoded.length);
  console.log();

  // 2. Submit
  console.log("2. Submitting to FdcHub (cost: ~1 FLR)...");
  const { roundId, txHash: subTx } = await fdc.submitRequest(abiEncoded);
  console.log("   Submitted! Round:", roundId, "TX:", subTx);
  console.log("   Track:", `https://systems-explorer.flare.rocks/voting-round/${roundId}?tab=fdc`);
  console.log();

  // 3. Poll
  console.log("3. Polling DA Layer for proof (waiting 90-180s)...");
  for (let attempt = 1; attempt <= 6; attempt++) {
    console.log(`   Attempt ${attempt}/6 - waiting 30s...`);
    await new Promise((r) => setTimeout(r, 30000));
    const proofData = await fdc.fetchProof(roundId, abiEncoded);
    if (proofData) {
      console.log("   Proof retrieved! Merkle entries:", proofData.proof?.length ?? 0);
      console.log();

      // 4. Verify on-chain
      console.log("4. Verifying on-chain via PaymentVerifierMainnet...");
      const verTx = await fdc.verifyProofOnChain(proofData, config.paymentVerifierAddress);
      console.log("   Verified! TX:", verTx);
      console.log();

      // 5. Check count
      const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
      const artifact = JSON.parse(
        readFileSync(
          "./artifacts/contracts/PaymentVerifierMainnet.sol/PaymentVerifierMainnet.json",
          "utf8"
        )
      );
      const verifier = new ethers.Contract(config.paymentVerifierAddress, artifact.abi, provider);
      const count = await verifier.getPaymentCount();
      console.log("   On-chain verified payments count:", count.toString());
      console.log("\n✅ End-to-end attestation complete!");
      return;
    }
    console.log("   Not ready yet");
  }
  console.log("❌ Proof not found after 6 attempts (~3 min). The round may need more time.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  console.error(err.stack?.split("\n").slice(0, 3).join("\n"));
  process.exit(1);
});
