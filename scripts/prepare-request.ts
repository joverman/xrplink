import "dotenv/config";

const VERIFIER_BASE_URL = "https://fdc-verifiers-testnet.flare.network";
const apiKey = process.env.VERIFIER_API_KEY;
const xrpTxHash = process.env.XRP_TX_HASH;

async function main() {
  if (!apiKey) throw new Error("VERIFIER_API_KEY not set");
  if (!xrpTxHash) throw new Error("XRP_TX_HASH not set");

  const { ethers } = await import("ethers");
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);

  const attestationType = "0x" + Buffer.from("XRPPayment").toString("hex").padEnd(64, "0");
  const sourceId = "0x" + Buffer.from("testXRP").toString("hex").padEnd(64, "0");
  const txHash = "0x" + xrpTxHash;
  const proofOwner = wallet.address;

  console.log("Preparing XRPPayment attestation request...");
  console.log(`  Attestation Type: XRPPayment (0x08)`);
  console.log(`  Source:           testXRP`);
  console.log(`  TX Hash:          ${txHash}`);
  console.log(`  Proof Owner:      ${proofOwner}`);
  console.log();

  const requestBody = {
    attestationType: attestationType,
    sourceId: sourceId,
    requestBody: {
      transactionId: txHash,
      proofOwner: proofOwner,
    },
  };

  console.log("Request:", JSON.stringify(requestBody, null, 2));
  console.log();

  const response = await fetch(
    `${VERIFIER_BASE_URL}/verifier/xrp/XRPPayment/prepareRequest`,
    {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Verifier error (${response.status}): ${text}`);
  }

  const data = await response.json();
  console.log("✅ Attestation request prepared successfully!");
  console.log(`  Status: ${data.status}`);
  console.log(`\n  ABI Encoded Request:`);
  console.log(`  ${data.abiEncodedRequest}`);
  console.log();

  const fs = await import("fs");
  let env = fs.readFileSync(".env", "utf8");
  env = env.replace(/ABI_ENCODED_REQUEST=.*/, `ABI_ENCODED_REQUEST=${data.abiEncodedRequest}`);
  fs.writeFileSync(".env", env);
  console.log("  (Saved ABI_ENCODED_REQUEST to .env)");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
