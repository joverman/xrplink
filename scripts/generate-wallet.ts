import { ethers } from "ethers";
import fs from "fs";

const wallet = ethers.Wallet.createRandom();

const output = `
========================================
  XRPLink Test Wallet
========================================
  Address:     ${wallet.address}
  Private Key: ${wallet.privateKey}
========================================

To fund this wallet on Coston2 testnet:
  1. Visit https://coston2-faucet.flare.network/
  2. Connect your wallet or paste this address:
     ${wallet.address}
  3. Request test FLR

Or use the Faucet API (if available):
  curl -X POST https://coston2-faucet.flare.network/api/v1/claim \\
    -H "Content-Type: application/json" \\
    -d '{"address": "${wallet.address}"}'
========================================
`;

console.log(output);

const envPath = "./.env";
if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, `PRIVATE_KEY=${wallet.privateKey}\nVERIFIER_API_KEY=\n`);
  console.log("Saved to .env (fill in VERIFIER_API_KEY when you have it)");
} else {
  console.log(".env already exists - not overwriting");
}
