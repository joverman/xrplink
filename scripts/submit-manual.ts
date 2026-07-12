import { ethers } from "ethers";
import { config, activeNetwork } from "../src/config.js";

async function main() {
  const txHashRaw = process.argv[2] || "87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F";
  const txHash = "0x" + txHashRaw;
  const proofOwner = new ethers.Wallet(config.privateKey).address;

  // Encode attestation request (same as verifier API would)
  const attestationType = ethers.utils.formatBytes32String("XRPPayment");
  const sourceId = ethers.utils.formatBytes32String(activeNetwork.sourceId);
  const requestBody = ethers.utils.defaultAbiCoder.encode(
    ["bytes32", "address"],
    [txHash, proofOwner]
  );
  const mic = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes", "string"],
      [attestationType, sourceId, requestBody, "Flare"]
    )
  );
  const abiEncoded = attestationType + sourceId.slice(2) + mic.slice(2) + requestBody.slice(2);

  console.log("=== XRPLink Mainnet Attestation (Manual MIC) ===\n");
  console.log("Network:", config.network);
  console.log("Source:", activeNetwork.sourceId);
  console.log("TX Hash:", txHash);
  console.log("Proof Owner:", proofOwner);
  console.log("Request length:", abiEncoded.length / 2 - 1, "bytes");
  console.log();

  const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log("Wallet:", wallet.address);
  console.log("Balance:", ethers.utils.formatEther(balance), "FLR");
  console.log();

  const fdcHub = new ethers.Contract(
    activeNetwork.fdcHub,
    ["function requestAttestation(bytes _data) external payable"],
    wallet
  );
  const fee = ethers.utils.parseEther("20"); // mainnet fee is 20 FLR
  console.log("Submitting to FdcHub with fee", ethers.utils.formatEther(fee), "FLR...");
  const tx = await fdcHub.requestAttestation(abiEncoded, { value: fee });
  console.log("TX:", tx.hash);

  const receipt = await tx.wait();
  const block = await provider.getBlock(receipt.blockNumber);
  const roundId = Math.floor(
    (block.timestamp - activeNetwork.firstVotingRoundStart) / 90
  );

  console.log("Confirmed in block", receipt.blockNumber);
  console.log("\n✅ Attestation submitted!");
  console.log("Round ID:", roundId);
  console.log("Explorer:", `https://systems-explorer.flare.rocks/voting-round/${roundId}?tab=fdc`);
  console.log();
  console.log("After ~90s, run: tsx scripts/fetch-proof.ts", roundId, txHashRaw);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
