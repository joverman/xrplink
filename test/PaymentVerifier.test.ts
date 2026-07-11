import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

describe("PaymentVerifier", async () => {
  const { viem, networkHelpers } = await network.create();

  async function deployFixtures() {
    const mockFdc = await viem.deployContract("MockFdcVerification");
    const verifier = await viem.deployContract("TestPaymentVerifier");
    await verifier.write.setMockFdc([mockFdc.address]);
    return { mockFdc, verifier };
  }

  const validProof = {
    merkleProof: [
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ],
    data: {
      attestationType: "0x5852505061796d656e7400000000000000000000000000000000000000000000",
      sourceId: "0x7465737458525000000000000000000000000000000000000000000000000000",
      votingRound: 1389768n,
      lowestUsedTimestamp: 1783508302n,
      requestBody: {
        transactionId: "0x388076b7245a60a13d6a764c8d0b5919f8a77e04e720c32ca1e30e9b7a291f22",
        proofOwner: "0x0000000000000000000000000000000000000001",
      },
      responseBody: {
        blockNumber: 18889806n,
        blockTimestamp: 1783508302n,
        sourceAddress: "rPfi6ALJ7wC5eBwfnZB7Uz2YfbrVTeAA5p",
        sourceAddressHash: "0x17630855c8e811cc4c5360af4711f1ba17c664e45eacfeacd5e8a499df01c646",
        receivingAddressHash: "0x45f1eadfd3f20f3f02043a5ded11cee104b93be484b03f94826ffb97c560bd1c",
        intendedReceivingAddressHash: "0x45f1eadfd3f20f3f02043a5ded11cee104b93be484b03f94826ffb97c560bd1c",
        spentAmount: 1000012n,
        intendedSpentAmount: 1000012n,
        receivedAmount: 1000000n,
        intendedReceivedAmount: 1000000n,
        hasMemoData: true,
        firstMemoData: "0x5852504c696e6b546573740000000000000000000000000000000000000000",
        hasDestinationTag: false,
        destinationTag: 0n,
        status: 0,
      },
    },
  };

  it("should reject when FDC verification returns false", async () => {
    const { mockFdc, verifier } = await networkHelpers.loadFixture(deployFixtures);
    await mockFdc.write.setShouldVerify([false]);
    await viem.assertions.revertWith(
      verifier.write.processPaymentProof([validProof]),
      "Invalid XRP payment proof",
    );
  });

  it("should accept when FDC verification returns true", async () => {
    const { mockFdc, verifier } = await networkHelpers.loadFixture(deployFixtures);
    await mockFdc.write.setShouldVerify([true]);
    await assert.doesNotReject(() => verifier.write.processPaymentProof([validProof]));
  });

  it("should emit PaymentVerified event on successful verification", async () => {
    const { mockFdc, verifier } = await networkHelpers.loadFixture(deployFixtures);
    await mockFdc.write.setShouldVerify([true]);

    // Check event emitted (indexed string params are hashed, so we just check event name)
    await viem.assertions.emit(
      verifier.write.processPaymentProof([validProof]),
      verifier,
      "PaymentVerified",
    );
  });

  it("should increment getPaymentCount after verification", async () => {
    const { mockFdc, verifier } = await networkHelpers.loadFixture(deployFixtures);
    await mockFdc.write.setShouldVerify([true]);

    assert.equal(await verifier.read.getPaymentCount(), 0n);
    await verifier.write.processPaymentProof([validProof]);
    assert.equal(await verifier.read.getPaymentCount(), 1n);
  });

  it("should store verified payment in the payments array", async () => {
    const { mockFdc, verifier } = await networkHelpers.loadFixture(deployFixtures);
    await mockFdc.write.setShouldVerify([true]);

    await verifier.write.processPaymentProof([validProof]);
    const payments = await verifier.read.getVerifiedPayments();
    assert.equal(payments.length, 1);
    assert.equal(payments[0].transactionId, validProof.data.requestBody.transactionId);
    assert.equal(payments[0].sourceAddress, "rPfi6ALJ7wC5eBwfnZB7Uz2YfbrVTeAA5p");
    assert.equal(payments[0].receivedAmount, 1000000n);
  });

  it("should reject duplicate transactions (replay protection)", async () => {
    const { mockFdc, verifier } = await networkHelpers.loadFixture(deployFixtures);
    await mockFdc.write.setShouldVerify([true]);

    await verifier.write.processPaymentProof([validProof]);
    await viem.assertions.revertWith(
      verifier.write.processPaymentProof([validProof]),
      "Already processed",
    );
  });

  it("should reject payment with non-zero status", async () => {
    const { mockFdc, verifier } = await networkHelpers.loadFixture(deployFixtures);
    await mockFdc.write.setShouldVerify([true]);

    const failedProof = {
      ...validProof,
      data: {
        ...validProof.data,
        responseBody: { ...validProof.data.responseBody, status: 1 },
      },
    };
    await viem.assertions.revertWith(
      verifier.write.processPaymentProof([failedProof]),
      "Payment not successful",
    );
  });

  it("should track processed transactions in mapping", async () => {
    const { mockFdc, verifier } = await networkHelpers.loadFixture(deployFixtures);
    await mockFdc.write.setShouldVerify([true]);

    const txId = validProof.data.requestBody.transactionId;
    assert.equal(await verifier.read.processedTransactions([txId]), false);
    await verifier.write.processPaymentProof([validProof]);
    assert.equal(await verifier.read.processedTransactions([txId]), true);
  });
});
