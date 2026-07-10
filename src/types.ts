export type AttestationStatus =
  | "pending"       // submitted to FdcHub, waiting for round
  | "ready"         // proof available from DA Layer
  | "verified"      // verified on-chain via PaymentVerifier
  | "failed"        // attestation failed consensus
  | "not_found";    // no proof found after polling

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

export interface Webhook {
  id: string;
  url: string;
  attestationId: string | null;
  createdAt: string;
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
  attestationId?: string;
}

export interface ApiError {
  error: string;
  code: string;
  details?: string;
}
