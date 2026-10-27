export type Tier = "free" | "paid" | "pro";

export type AttestationStatus =
  | "pending"
  | "ready"
  | "verified"
  | "failed"
  | "not_found";

export interface Attestation {
  id: string;
  txHash: string;
  status: AttestationStatus;
  roundId: number | null;
  abiEncodedRequest: string | null;
  proof: ProofResponse | null;
  verifiedTxHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** SHA-256 API key id that created this attestation (unset for legacy / x402-only). */
  ownerKeyId?: string | null;
}

export interface ProofResponse {
  response: {
    attestationType: string;
    sourceId: string;
    votingRound: string;
    lowestUsedTimestamp: string;
    requestBody: {
      transactionId: string;
      proofOwner: string;
    };
    responseBody: {
      blockNumber: string;
      blockTimestamp: string;
      sourceAddress: string;
      sourceAddressHash: string;
      receivingAddressHash: string;
      intendedReceivingAddressHash: string;
      spentAmount: string;
      intendedSpentAmount: string;
      receivedAmount: string;
      intendedReceivedAmount: string;
      hasMemoData: boolean;
      firstMemoData: string;
      hasDestinationTag: boolean;
      destinationTag: string;
      status: string;
    };
  };
  proof: string[];
}

export interface ApiKey {
  /** SHA-256 hex of the secret (or, until migrated, the plaintext sk_live_ value). */
  key: string;
  name: string;
  tier: Tier;
  active: boolean;
  usageCount: number;
  createdAt: string;
  keyPrefix?: string;
  keyLast4?: string;
}

export interface Webhook {
  id: string;
  url: string;
  /** Required for active hooks. Null/legacy global hooks are disabled on load. */
  attestationId: string | null;
  /** SHA-256 API key id that registered the hook. */
  apiKeyId?: string;
  secret?: string;
  createdAt: string;
  /** False for migrated unscoped (null attestationId) hooks. */
  active?: boolean;
}

export interface VerifyResponse {
  id: string;
  txHash: string;
  roundId: number | null;
  status: AttestationStatus;
}

export interface StatusResponse {
  id: string;
  txHash: string;
  roundId: number | null;
  status: AttestationStatus;
  proof: ProofResponse | null;
  verifiedTxHash: string | null;
  error: string | null;
}

export interface RegisterWebhookBody {
  url: string;
  attestationId: string;
}

export interface ApiError {
  error: string;
  code: string;
  details?: string;
}
