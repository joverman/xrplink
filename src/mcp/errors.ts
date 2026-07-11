export interface AgentError {
  error: string;
  message: string;
  suggestedAction?: string;
  docsUrl?: string;
  details?: string;
}

type ErrorEntry = Omit<AgentError, "error"> & {
  context?: (ctx: Record<string, string>) => Partial<AgentError>;
};

const catalog: Record<string, ErrorEntry> = {
  INVALID_TX_HASH: {
    message: "Expected 64 hex characters for transaction hash",
    suggestedAction:
      'Provide a valid XRP transaction hash (64 hex chars, with or without 0x prefix). Example: 388076B7245A60A13D6A764C8D0B5919F8A77E04E720C32CA1E30E9B7A291F22',
    docsUrl: "xrplink://docs/tools",
  },
  MISSING_API_KEY: {
    message: "X-API-Key header is required for this endpoint",
    suggestedAction:
      "Pass an 'X-API-Key' header with a valid API key. Generate a new key via the 'create_api_key' tool (requires an existing pro-tier key).",
    docsUrl: "xrplink://docs/config",
  },
  INVALID_API_KEY: {
    message: "API key is not valid or has been deactivated",
    suggestedAction:
      "Check that the API key is correct and active. Generate a new key via the 'create_api_key' tool with an existing pro-tier key, or contact your administrator.",
    docsUrl: "xrplink://docs/config",
  },
  RATE_LIMITED: {
    message: "Rate limit exceeded for this API key",
    context: (ctx) => ({
      suggestedAction: `Your tier (${ctx.tier || "unknown"}) allows ${ctx.limit || "?"} requests per minute. Wait and retry, or upgrade to a higher tier.`,
    }),
    docsUrl: "xrplink://docs/config",
  },
  SUBMIT_FAILED: {
    message: "Failed to submit attestation request to FdcHub",
    suggestedAction:
      "Check that your wallet has sufficient FLR balance for the attestation fee (1 FLR minimum). Verify the XRP transaction hash is valid and the transaction exists on the XRP Ledger.",
    docsUrl: "xrplink://docs/network",
  },
  NOT_FOUND: {
    message: "The requested resource was not found",
    suggestedAction:
      "Verify the ID or transaction hash is correct. Attestations are stored in the 'data/' directory and persist across restarts.",
    docsUrl: "xrplink://docs/tools",
  },
  FORBIDDEN: {
    message: "You do not have permission to perform this action",
    suggestedAction:
      "This operation requires a pro-tier API key. Generate one via the 'create_api_key' tool or contact your administrator.",
    docsUrl: "xrplink://docs/tools",
  },
  MISSING_URL: {
    message: "A 'url' field is required in the request body",
    suggestedAction:
      "Provide a valid HTTPS URL where the webhook payload should be delivered.",
    docsUrl: "xrplink://docs/tools",
  },
  INVALID_URL: {
    message: "The provided URL is not valid",
    suggestedAction:
      'Ensure the URL starts with http:// or https:// and is properly formatted. Example: https://example.com/hooks/xrp',
    docsUrl: "xrplink://docs/tools",
  },
  INTERNAL_ERROR: {
    message: "An unexpected error occurred",
    suggestedAction:
      "Retry the request. If the problem persists, check the server logs for details.",
    docsUrl: "xrplink://docs/overview",
  },
  MISSING_ATTESTATION_ID: {
    message: "attestationId not found",
    suggestedAction:
      "Verify the attestation ID is correct. Attestation IDs are UUIDs returned by the verify endpoint.",
    docsUrl: "xrplink://docs/tools",
  },
  VERIFIER_ERROR: {
    message: "The Flare verifier API returned an error",
    suggestedAction:
      "The XRP transaction may not exist, or the verifier API is temporarily unavailable. Verify the txHash and retry.",
    docsUrl: "xrplink://docs/network",
  },
  DA_LAYER_ERROR: {
    message: "The Flare DA Layer returned an error",
    suggestedAction:
      "The attestation round may not have finalized yet (wait 90-180s), or the request bytes don't match what was submitted. Check the round ID and retry.",
    docsUrl: "xrplink://docs/network",
  },
};

export function formatError(code: string, ctx?: Record<string, string>, fallbackMessage?: string): AgentError {
  const entry = catalog[code];
  if (!entry) {
    return { error: code, message: fallbackMessage || code, suggestedAction: "Retry the request or check server logs." };
  }
  const overrides = entry.context ? entry.context(ctx || {}) : {};
  return {
    error: code,
    message: entry.message,
    suggestedAction: overrides.suggestedAction || entry.suggestedAction,
    docsUrl: entry.docsUrl,
    details: ctx ? JSON.stringify(ctx) : undefined,
  };
}

export function wrapError(err: unknown, code = "INTERNAL_ERROR", ctx?: Record<string, string>): AgentError {
  const message = err instanceof Error ? err.message : String(err);
  return formatError(code, ctx, message);
}
