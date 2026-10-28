import { Contract, JsonRpcProvider, Wallet, parseEther } from "ethers";
import { config, activeNetwork } from "./config.js";
import { ProofResponse } from "./types.js";

function getProvider() {
  return new JsonRpcProvider(activeNetwork.rpc);
}

function getWallet(provider: JsonRpcProvider) {
  return new Wallet(config.privateKey, provider);
}

function encodeAttestationType(type: string): string {
  return "0x" + Buffer.from(type).toString("hex").padEnd(64, "0");
}

export class FdcVerifierError extends Error {
  readonly httpStatus?: number;
  readonly verifierStatus?: string;

  constructor(message: string, opts?: { httpStatus?: number; verifierStatus?: string }) {
    super(message);
    this.name = "FdcVerifierError";
    this.httpStatus = opts?.httpStatus;
    this.verifierStatus = opts?.verifierStatus;
  }
}

/**
 * Prepare an attestation request via the verifier API.
 */
export async function prepareRequest(txHash: string, proofOwner: string): Promise<string> {
  const response = await fetch(
    `${activeNetwork.verifierBaseUrl}/verifier/xrp/XRPPayment/prepareRequest`,
    {
      method: "POST",
      headers: {
        "X-API-KEY": config.verifierApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        attestationType: encodeAttestationType("XRPPayment"),
        sourceId: encodeAttestationType(activeNetwork.sourceId),
        requestBody: { transactionId: "0x" + txHash, proofOwner },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new FdcVerifierError(`Verifier error (${response.status}): ${text}`, {
      httpStatus: response.status,
    });
  }

  const data = await response.json();
  if (data.status !== "VALID") {
    throw new FdcVerifierError(`Verifier returned non-VALID status: ${data.status}`, {
      verifierStatus: String(data.status ?? ""),
    });
  }

  return data.abiEncodedRequest;
}

/**
 * Submit an attestation request to FdcHub.
 */
export async function submitRequest(abiEncodedRequest: string): Promise<{ roundId: number; txHash: string; blockNumber: number }> {
  const provider = getProvider();
  const wallet = getWallet(provider);

  const abi = ["function requestAttestation(bytes _data) external payable"];
  const fdcHub = new Contract(activeNetwork.fdcHub, abi, wallet);

  const fee = parseEther(config.submitFeeFlr);
  const tx = await fdcHub.requestAttestation(abiEncodedRequest, { value: fee });
  const receipt = await tx.wait();
  if (!receipt) throw new Error("FdcHub transaction was not mined");
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block) throw new Error("FdcHub block not found");

  const roundId = Math.floor(
    (Number(block.timestamp) - activeNetwork.firstVotingRoundStart) / 90
  );

  return { roundId, txHash: tx.hash, blockNumber: receipt.blockNumber };
}

/**
 * Fetch attestation proof from the DA Layer.
 */
export async function fetchProof(roundId: number, abiEncodedRequest: string): Promise<ProofResponse | null> {
  const response = await fetch(
    `${activeNetwork.daLayerUrl}/api/v0/fdc/get-proof-round-id-bytes`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": config.verifierApiKey,
      },
      body: JSON.stringify({ votingRoundId: roundId, requestBytes: abiEncodedRequest }),
    }
  );

  if (response.status === 400) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DA Layer error (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * Build the IXRPPayment.Proof struct from a DA Layer response.
 */
export function buildProofStruct(proofData: ProofResponse) {
  const resp = proofData.response;
  const rb = resp.responseBody;

  function toNum(v: string | number): number {
    return typeof v === "string" ? Number(v) : v;
  }
  function toBN(v: string | number) {
    return BigInt(v);
  }

  return {
    merkleProof: proofData.proof,
    data: {
      attestationType: resp.attestationType,
      sourceId: resp.sourceId,
      votingRound: toNum(resp.votingRound),
      lowestUsedTimestamp: toNum(resp.lowestUsedTimestamp),
      requestBody: {
        transactionId: resp.requestBody.transactionId,
        proofOwner: resp.requestBody.proofOwner,
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
}

/**
 * Verify a proof on-chain via the PaymentVerifier contract.
 */
export async function verifyProofOnChain(proofData: ProofResponse, contractAddress: string): Promise<string> {
  if (!contractAddress) throw new Error("PAYMENT_VERIFIER_ADDRESS not configured");

  const { readFileSync } = await import("fs");
  const artifact = JSON.parse(
    readFileSync("./artifacts/contracts/PaymentVerifier.sol/PaymentVerifier.json", "utf8")
  );

  const provider = getProvider();
  const wallet = getWallet(provider);
  const verifier = new Contract(contractAddress, artifact.abi, wallet);

  const proofStruct = buildProofStruct(proofData);
  const tx = await verifier.processPaymentProof(proofStruct);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("PaymentVerifier transaction was not mined");
  return receipt.hash;
}

/**
 * Check if a txHash has been verified on-chain.
 */
export async function isAlreadyVerified(txHash: string): Promise<boolean> {
  const contractAddress = config.paymentVerifierAddress;
  if (!contractAddress) return false;

  const { readFileSync } = await import("fs");
  const artifact = JSON.parse(
    readFileSync("./artifacts/contracts/PaymentVerifier.sol/PaymentVerifier.json", "utf8")
  );

  const provider = getProvider();
  const verifier = new Contract(contractAddress, artifact.abi, provider);

  try {
    const txId = "0x" + txHash;
    return await verifier.processedTransactions(txId);
  } catch {
    return false;
  }
}

/**
 * Compute the wallet address from the configured private key.
 */
export function getProofOwner(): string {
  return new Wallet(config.privateKey).address;
}
