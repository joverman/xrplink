import { store } from "../src/store.js";

const TX_HASH = "87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F";

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

const a = store.createAttestation(TX_HASH);
store.updateAttestation(a.id, {
  roundId: 1393372,
  abiEncodedRequest: "",
  proof: proofData,
  status: "verified",
  verifiedTxHash: "0xb5a17f0e7d3e990a3d56bc2394a93af1debee098ba1c64012de0bfb3810058d8",
});
console.log("Seeded attestation:", a.id, "for tx:", TX_HASH);
