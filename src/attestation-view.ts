import { apiKeyLookupId } from "./api-keys.js";
import { Attestation, StatusResponse } from "./types.js";
import { getMcpContext } from "./mcp/context.js";

export const NETWORK_STATUS_URI = "xrplink://network/status";

export function callerOwnsAttestation(attestation: Attestation, presentedKey?: string): boolean {
  if (!presentedKey || !attestation.ownerKeyId) return false;
  return attestation.ownerKeyId === apiKeyLookupId(presentedKey);
}

function paymentFromProof(attestation: Attestation) {
  const rb = attestation.proof?.response?.responseBody;
  if (!rb) return null;
  const memoHex = rb.firstMemoData || "";
  const memoStr = memoHex.startsWith("0x")
    ? Buffer.from(memoHex.slice(2), "hex").toString("utf8").replace(/\0+$/, "")
    : "";
  return {
    sourceAddress: rb.sourceAddress,
    receivedAmount: rb.receivedAmount,
    status: rb.status === "0" ? "success" : `failed (${rb.status})`,
    memo: rb.hasMemoData && memoStr ? memoStr : null,
    destinationTag: rb.hasDestinationTag && rb.destinationTag !== "0" ? rb.destinationTag : null,
  };
}

/** Same fields as the public JSON receipt — no merkle path, no abi-encoded request. */
export function publicAttestationView(attestation: Attestation) {
  return {
    id: attestation.id,
    txHash: attestation.txHash,
    roundId: attestation.roundId,
    status: attestation.status,
    verifiedTxHash: attestation.verifiedTxHash,
    createdAt: attestation.createdAt,
    payment: paymentFromProof(attestation),
    proof: attestation.proof
      ? {
          votingRound: attestation.proof.response?.votingRound,
          merkleProofLength: attestation.proof.proof?.length || 0,
        }
      : null,
  };
}

export function ownerAttestationView(attestation: Attestation): StatusResponse {
  return {
    id: attestation.id,
    txHash: attestation.txHash,
    roundId: attestation.roundId,
    status: attestation.status,
    proof: attestation.proof,
    verifiedTxHash: attestation.verifiedTxHash,
    error: attestation.error,
  };
}

export function attestationViewForCaller(attestation: Attestation, presentedKey?: string) {
  return callerOwnsAttestation(attestation, presentedKey)
    ? ownerAttestationView(attestation)
    : publicAttestationView(attestation);
}

/** HTTP MCP: public subset unless the presented key owns the row. Stdio (no ALS): full view. */
export function attestationViewForMcp(attestation: Attestation) {
  const ctx = getMcpContext();
  if (!ctx.http) return ownerAttestationView(attestation);
  const presented = ctx.apiKeyRecord?.key || ctx.apiKey;
  return attestationViewForCaller(attestation, presented);
}
