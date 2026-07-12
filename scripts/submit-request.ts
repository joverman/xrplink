import { ethers } from "ethers";
import { config, activeNetwork } from "../src/config.js";

async function main() {
  const abiEncoded = process.env.ABI_ENCODED_REQUEST;
  if (!abiEncoded) throw new Error("ABI_ENCODED_REQUEST not set");

  const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
  const wallet = new ethers.Wallet(config.privateKey, provider);

  console.log(`Submitting attestation request...`);
  console.log(`  Wallet:     ${wallet.address}`);
  console.log(`  Balance:    ${ethers.utils.formatEther(await provider.getBalance(wallet.address))} FLR`);

  const abi = ["function requestAttestation(bytes _data) external payable"];
  const fdcHub = new ethers.Contract(activeNetwork.fdcHub, abi, wallet);

  const fee = ethers.utils.parseEther("1");

  console.log(`  Fee:        ${ethers.utils.formatEther(fee)} FLR`);
  console.log();

  const tx = await fdcHub.requestAttestation(abiEncoded, { value: fee });
  console.log(`  TX sent:    ${tx.hash}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await tx.wait();
  const block = await provider.getBlock(receipt.blockNumber);

  const roundId = Math.floor(
    (block.timestamp - activeNetwork.firstVotingRoundStart) / 90
  );

  console.log(`  Block:      ${receipt.blockNumber}`);
  console.log();
  console.log("✅ Attestation request submitted to FdcHub!");
  console.log();
  console.log(`  Round ID:   ${roundId}`);
  console.log(`  Track:      https://${config.network === "flare" ? "systems-explorer.flare.rocks" : "coston-systems-explorer.flare.rocks"}/voting-round/${roundId}?tab=fdc`);
  console.log();
  console.log("Wait ~90-180 seconds for round finalization, then verify.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
