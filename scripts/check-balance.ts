import { ethers } from "ethers";
import { config, activeNetwork } from "../src/config.js";

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log(`Network: ${config.network}`);
  console.log(`Wallet:  ${wallet.address}`);
  console.log(`Balance: ${ethers.utils.formatEther(balance)} FLR`);
}

main().catch(console.error);
