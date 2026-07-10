import { ethers } from "ethers";
import "dotenv/config";

async function main() {
  const provider = new ethers.providers.JsonRpcProvider("https://coston2-api.flare.network/ext/C/rpc");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Balance: ${ethers.utils.formatEther(balance)} test FLR`);
}

main().catch(console.error);
