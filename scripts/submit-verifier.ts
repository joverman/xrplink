import { ethers } from "ethers";
import { config, activeNetwork } from "../src/config.js";

const CORRECT_REQUEST = "0x5852505061796d656e7400000000000000000000000000000000000000000000585250000000000000000000000000000000000000000000000000000000000083090138e368cca62d300e0d9361bef766a360be82c17ccbb669187bb398ca8e87ad359a0db9e27260aae29766dc858886c54dac4733d43b1b72cbb90e29b95f00000000000000000000000000c83677d2231b6c763f90d24ca9f78c909ded9a";

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log("Balance:", ethers.utils.formatEther(balance), "FLR");

  const fee = ethers.utils.parseEther("20");

  const fdcHub = new ethers.Contract(
    activeNetwork.fdcHub,
    ["function requestAttestation(bytes _data) external payable"],
    wallet
  );

  console.log("Submitting with correct request from verifier...");
  const tx = await fdcHub.requestAttestation(CORRECT_REQUEST, { value: fee });
  console.log("TX:", tx.hash);

  const receipt = await tx.wait();
  const block = await provider.getBlock(receipt.blockNumber);
  const roundId = Math.floor(
    (block.timestamp - activeNetwork.firstVotingRoundStart) / 90
  );

  console.log("Block:", receipt.blockNumber);
  console.log("Round:", roundId);
  console.log("Search:", `https://flare-systems-explorer.flare.rocks/voting-round/${roundId}?tab=fdc`);

  console.log("\nAfter ~120s, run:");
  console.log(`  curl -X POST 'https://flr-data-availability.flare.network/api/v0/fdc/get-proof-round-id-bytes'`);
  console.log(`  -H 'Content-Type: application/json'`);
  console.log(`  -H 'X-API-KEY: 00000000-0000-0000-0000-000000000000'`);
  console.log(`  -d '{"votingRoundId":${roundId},"requestBytes":"${CORRECT_REQUEST}"}'`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
