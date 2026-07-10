import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deploying PaymentVerifier from: ${wallet.address}`);
  console.log(`Balance: ${ethers.utils.formatEther(balance)} test FLR`);
  console.log();

  // Read compiled artifact
  const artifactPath = "./artifacts/contracts/PaymentVerifier.sol/PaymentVerifier.json";
  if (!fs.existsSync(artifactPath)) {
    throw new Error("Run 'npx hardhat compile' first");
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log("Deploying PaymentVerifier...");
  const contract = await factory.deploy();
  console.log(`  TX sent: ${contract.deployTransaction.hash}`);

  await contract.deployed();

  console.log(`✅ PaymentVerifier deployed to: ${contract.address}`);
  console.log();
  console.log(`To verify proof on-chain, run:`);
  console.log(`  tsx scripts/verify-proof.ts <roundId> ${contract.address}`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
