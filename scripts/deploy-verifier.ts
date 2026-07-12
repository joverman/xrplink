import "dotenv/config";
import { ethers } from "ethers";
import fs from "fs";
import { config, activeNetwork } from "../src/config.js";

type Network = "coston2" | "flare";

const NETWORKS: Record<Network, { name: string; contract: string; currency: string }> = {
  coston2: {
    name: "Coston2",
    contract: "PaymentVerifier.sol",
    currency: "test FLR",
  },
  flare: {
    name: "Flare Mainnet",
    contract: "PaymentVerifierMainnet.sol",
    currency: "FLR",
  },
};

async function main() {
  const networkArg = (process.argv[2] || "coston2").toLowerCase() as Network;
  const net = NETWORKS[networkArg];
  if (!net) {
    console.error(`Usage: tsx scripts/deploy-verifier.ts [coston2|flare]`);
    console.error(`  Unknown network: "${networkArg}"`);
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
  const wallet = new ethers.Wallet(config.privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deploying to ${net.name}`);
  console.log(`  From:      ${wallet.address}`);
  console.log(`  Balance:   ${ethers.utils.formatEther(balance)} ${net.currency}`);
  console.log();

  const artifactPath = `./artifacts/contracts/${net.contract}/PaymentVerifier${networkArg === "flare" ? "Mainnet" : ""}.json`;
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found at ${artifactPath}. Run 'npx hardhat compile' first.`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log(`Deploying ${net.contract.replace(".sol", "")}...`);
  const contract = await factory.deploy();
  console.log(`  TX sent: ${contract.deployTransaction.hash}`);
  await contract.deployed();

  console.log(`✅ Deployed to ${net.name}: ${contract.address}`);
  console.log();
  console.log(`Set this in .env for ${networkArg}:`);
  console.log(`PAYMENT_VERIFIER_ADDRESS=${contract.address}`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
