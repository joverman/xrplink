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
      "Pass an 'X-API-Key' header with a valid API key. Sign in at /dashboard to view a masked key or regenerate it.",
    docsUrl: "xrplink://docs/config",
  },
  INVALID_API_KEY: {
    message: "API key is not valid or has been deactivated",
    suggestedAction:
      "Check that the API key is correct and active. Sign in at /dashboard to regenerate your key if it was lost or rotated.",
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
      "The verifier accepted this payment, but submitting to FdcHub failed. Check that PRIVATE_KEY_FLARE is a funded Flare mainnet wallet with enough FLR for SUBMIT_FEE_FLR (default 20 FLR).",
    docsUrl: "xrplink://docs/network",
  },
  TX_TOO_OLD: {
    message: "This XRP payment is older than the Flare FDC 14-day lookback window",
    suggestedAction:
      "Flare's XRPPayment attestation (IXRPPayment lutlimit 0x127500 = 14 days) cannot prove payments older than that. Retry with a native XRP Payment whose ledger close time is within the last 14 days.",
    docsUrl: "xrplink://docs/network",
  },
  TX_NOT_ON_LEDGER: {
    message: "No transaction with this hash was found on the XRP Ledger",
    suggestedAction:
      "Confirm the 64-character hash is a validated XRPL transaction on the same network this server uses (mainnet when FLARE_NETWORK=flare). Very new payments may need a few ledgers before they appear.",
    docsUrl: "xrplink://docs/tools",
  },
  TX_NOT_PAYMENT: {
    message: "Flare FDC XRPPayment can only attest XRPL Payment transactions",
    suggestedAction:
      "Submit a native XRP Payment hash, not Offers, TrustSet, or other transaction types.",
    docsUrl: "xrplink://docs/tools",
  },
  TX_NOT_NATIVE_XRP: {
    message: "Flare FDC XRPPayment can only attest native XRP Payments, not issued-currency (IOU) payments",
    suggestedAction:
      "Submit a Payment whose Amount is XRP drops, not an issued currency such as RLUSD.",
    docsUrl: "xrplink://docs/tools",
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
      "This operation requires the server ADMIN_API_KEY sent as an X-Admin-Key header. Customer API keys of any tier are not accepted.",
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
    message: "The Flare verifier API rejected this attestation request",
    suggestedAction:
      "The hosted XRPPayment verifier could not prove this hash. Typical causes: the payment is older than 14 days, it is not a native XRP Payment, it is on the other XRPL network (mainnet vs testnet), or it does not yet have enough ledger confirmations. Wait a few ledgers and retry, or use a Payment from the last 14 days.",
    docsUrl: "xrplink://docs/network",
  },
  DA_LAYER_ERROR: {
    message: "The Flare DA Layer returned an error",
    suggestedAction:
      "The attestation round may not have finalized yet (wait 90-180s), or the request bytes don't match what was submitted. Check the round ID and retry.",
    docsUrl: "xrplink://docs/network",
  },
  MISSING_AUTH: {
    message: "Authorization header is required",
    suggestedAction: "Pass an 'Authorization: Bearer <token>' header. Sign up or log in at /auth/signup or /auth/login.",
    docsUrl: "",
  },
  INVALID_AUTH: {
    message: "Invalid or expired authorization token",
    suggestedAction: "Log in again at /auth/login to get a new token.",
    docsUrl: "",
  },
  AUTH_FAILED: {
    message: "Authentication failed",
    suggestedAction: "Check your credentials and try again.",
    docsUrl: "",
  },
  MISSING_EMAIL: {
    message: "Email field is required",
    suggestedAction: "Provide an email address in the request body.",
    docsUrl: "",
  },
  MISSING_PARAMS: {
    message: "Required parameters are missing",
    suggestedAction: "Check the request body for all required fields.",
    docsUrl: "",
  },
  INVALID_TIER: {
    message: "Invalid subscription tier",
    suggestedAction: "Choose 'paid' ($29/mo) or 'pro' ($99/mo).",
    docsUrl: "",
  },
  BILLING_ERROR: {
    message: "Billing service error",
    suggestedAction: "Retry the request. If the problem persists, contact support.",
    docsUrl: "",
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
