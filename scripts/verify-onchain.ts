import { ethers } from "ethers";
import { readFileSync } from "fs";
import { config, activeNetwork } from "../src/config.js";

const proofData = {
  response: {
    attestationType: "0x5852505061796d656e7400000000000000000000000000000000000000000000",
    sourceId: "0x5852500000000000000000000000000000000000000000000000000000000000",
    votingRound: "1393372",
    lowestUsedTimestamp: "1783832690",
    requestBody: {
      transactionId: "0x87ad359a0db9e27260aae29766dc858886c54dac4733d43b1b72cbb90e29b95f",
      proofOwner: "0x00c83677d2231b6c763f90d24ca9f78c909ded9a",
    },
    responseBody: {
      blockNumber: "105540426",
      blockTimestamp: "1783832690",
      sourceAddress: "rL7pkkJpNTJUTPcrYeWm9Sav9oJH8kXMRR",
      sourceAddressHash: "0x30254431af4f2d2ad34d4a30c16a93acef751a3742bf94c04809ff6bd832c960",
      receivingAddressHash: "0xcca36bd9cfaf47b4218d217a7e40cf67d09ff2076b9d68e94fc38d651b75a3c9",
      intendedReceivingAddressHash: "0xcca36bd9cfaf47b4218d217a7e40cf67d09ff2076b9d68e94fc38d651b75a3c9",
      spentAmount: "1000012",
      intendedSpentAmount: "1000012",
      receivedAmount: "1000000",
      intendedReceivedAmount: "1000000",
      hasMemoData: true,
      firstMemoData: "0x5852504c696e6b54657374",
      hasDestinationTag: false,
      destinationTag: "0",
      status: "0",
    },
  },
  proof: [
    "0xc26a2163caefaa2b697b8438be20fbbc9635ce3d66bf6825d1b6195fd3460282",
    "0x217c77740ae5f9f6799b9d4a6f38e0bc2c8eb87afdbd6e20cec9b0234bae705b",
    "0x191c70c34782b67bf943771d8b18cf8b4a757752d8d4d47abf99dff4eb49f2b5",
  ],
};

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(activeNetwork.rpc);
  const wallet = new ethers.Wallet(config.privateKey, provider);

  const artifact = JSON.parse(
    readFileSync(
      "./artifacts/contracts/PaymentVerifierMainnet.sol/PaymentVerifierMainnet.json"
    )
  );
  const verifier = new ethers.Contract(
    config.paymentVerifierAddress,
    artifact.abi,
    wallet
  );

  const rb = proofData.response.responseBody;
  const toNum = (v: any) => (typeof v === "string" ? Number(v) : v);
  const toBN = (v: any) => ethers.BigNumber.from(v);

  const proofStruct = {
    merkleProof: proofData.proof,
    data: {
      attestationType: proofData.response.attestationType,
      sourceId: proofData.response.sourceId,
      votingRound: toNum(proofData.response.votingRound),
      lowestUsedTimestamp: toNum(proofData.response.lowestUsedTimestamp),
      requestBody: {
        transactionId: proofData.response.requestBody.transactionId,
        proofOwner: proofData.response.requestBody.proofOwner,
      },
      responseBody: {
        blockNumber: toNum(rb.blockNumber),
        blockTimestamp: toNum(rb.blockTimestamp),
        sourceAddress: rb.sourceAddress,
        sourceAddressHash: rb.sourceAddressHash,
        receivingAddressHash: rb.receivingAddressHash,
        intendedReceivingAddressHash: rb.intendedReceivingAddressHash,
        spentAmount: toBN(rb.spentAmount),
        intendedSpentAmount: toBN(rb.intendedSpentAmount),
        receivedAmount: toBN(rb.receivedAmount),
        intendedReceivedAmount: toBN(rb.intendedReceivedAmount),
        hasMemoData: rb.hasMemoData,
        firstMemoData: rb.firstMemoData,
        hasDestinationTag: rb.hasDestinationTag,
        destinationTag: toBN(rb.destinationTag),
        status: toNum(rb.status),
      },
    },
  };

  console.log("Verifying on-chain via PaymentVerifierMainnet...");
  console.log("Contract:", config.paymentVerifierAddress);
  console.log("XRP Tx:", proofData.response.requestBody.transactionId);
  console.log("Status:", rb.status, "(0 = success)");
  console.log("Amount:", rb.receivedAmount, "drops (1 XRP)");
  console.log("Memo:", rb.firstMemoData);
  console.log();

  const tx = await verifier.processPaymentProof(proofStruct);
  console.log("Verify TX:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block", receipt.blockNumber);

  const count = await verifier.getPaymentCount();
  console.log("Verified payments count:", count.toString());
  console.log("\n✅ END-TO-END MAINNET ATTESTATION COMPLETE!");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
