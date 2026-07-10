import "dotenv/config";
import { ethers } from "ethers";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const FDC_HUB = "0x48aC463d7975828989331F4De43341627b9c5f1D";

const FIRST_VOTING_ROUND_START_TS = 1658430000;
const VOTING_EPOCH_DURATION = 90;

async function main() {
  const abiEncoded = process.env.ABI_ENCODED_REQUEST;
  if (!abiEncoded) throw new Error("ABI_ENCODED_REQUEST not set");

  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log(`Submitting attestation request...`);
  console.log(`  Wallet:     ${wallet.address}`);
  console.log(`  Balance:    ${ethers.utils.formatEther(await provider.getBalance(wallet.address))} test FLR`);

  const abi = ["function requestAttestation(bytes _data) external payable"];
  const fdcHub = new ethers.Contract(FDC_HUB, abi, wallet);

  const fee = ethers.utils.parseEther("1");

  console.log(`  Fee:        ${ethers.utils.formatEther(fee)} test FLR`);
  console.log();

  const tx = await fdcHub.requestAttestation(abiEncoded, { value: fee });
  console.log(`  TX sent:    ${tx.hash}`);
  console.log(`  Waiting for confirmation...`);

  const receipt = await tx.wait();
  const block = await provider.getBlock(receipt.blockNumber);

  const roundId = Math.floor(
    (block.timestamp - FIRST_VOTING_ROUND_START_TS) / VOTING_EPOCH_DURATION
  );

  console.log(`  Block:      ${receipt.blockNumber}`);
  console.log();
  console.log("✅ Attestation request submitted to FdcHub!");
  console.log();
  console.log(`  Round ID:   ${roundId}`);
  console.log(`  Track:      https://coston-systems-explorer.flare.rocks/voting-round/${roundId}?tab=fdc`);
  console.log();
  console.log("Wait ~90-180 seconds for round finalization, then verify.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
