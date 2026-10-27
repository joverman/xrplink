/**
 * Shared XRP payment attestation flow used by REST and MCP.
 *
 * Auth order:
 *  1. Cached / already-on-chain attestations are free (no quota, no x402).
 *  2. Valid subscription key inside quota attests without payment.
 *  3. Missing key, invalid key, or over-quota key: x402 402 quote (if configured).
 *  4. A valid x402 payment (verify + settle) authorizes exactly one attestation.
 *
 * Payment is settled before FDC submit. If FDC then fails, the invoice is marked
 * fdc_failed and the same PAYMENT-SIGNATURE may retry FDC without a second charge.
 */

import { store } from "./store.js";
import { config } from "./config.js";
import * as fdc from "./fdc-service.js";
import { FdcVerifierError } from "./fdc-service.js";
import { deliverWebhooks } from "./webhook-service.js";
import { userStore } from "./user-store.js";
import { formatError } from "./mcp/errors.js";
import { preflightXrplPayment, XrplPreflightFail } from "./xrpl-tx.js";
import {
  checkQuota,
  buildQuotaExceededError,
  BillingPeriod,
  getFallbackBillingPeriod,
  getBillingPeriodKey,
  QuotaExceededError,
} from "./attestation-quota.js";
import {
  isX402Configured,
  buildPaymentRequired,
  encodePaymentRequired,
  encodePaymentResponse,
  processX402Payment,
  markPaymentFdcOk,
  markPaymentFdcFailed,
  X402PaymentRequired,
  X402SettlementResponse,
} from "./x402-service.js";
import { VerifyResponse, ApiKey } from "./types.js";
import { apiKeyLookupId } from "./api-keys.js";

export interface AttestSuccess {
  kind: "ok";
  httpStatus: 200 | 202;
  body: VerifyResponse & { cached?: boolean; x402?: boolean };
  paymentResponseHeader?: string;
}

export interface AttestPaymentRequired {
  kind: "payment_required";
  httpStatus: 402;
  body: {
    code: "PAYMENT_REQUIRED" | "QUOTA_EXCEEDED";
    message: string;
    paymentRequired: X402PaymentRequired;
    priceUsd: number;
    priceXrp: number;
    priceRlusd: string;
    tier?: string;
    limit?: number;
    used?: number;
    resetDate?: string;
    upgradeUrl?: string;
  };
  paymentRequiredHeader: string;
}

export interface AttestError {
  kind: "error";
  httpStatus: number;
  body: Record<string, any>;
}

export type AttestResult = AttestSuccess | AttestPaymentRequired | AttestError;

function isHexTxHash(v: string): boolean {
  return /^[0-9A-Fa-f]{64}$/.test(v);
}

type FdcSubmitFn = (abiEncoded: string) => Promise<{ roundId: number; txHash: string }>;
type FdcPrepareFn = (txHash: string, proofOwner: string) => Promise<string>;

let fdcSubmitOverride: FdcSubmitFn | null = null;
let fdcPrepareOverride: FdcPrepareFn | null = null;
let alreadyVerifiedOverride: ((txHash: string) => Promise<boolean>) | null = null;

export function setFdcMocksForTests(mocks: {
  submitRequest?: FdcSubmitFn;
  prepareRequest?: FdcPrepareFn;
  isAlreadyVerified?: (txHash: string) => Promise<boolean>;
} | null): void {
  fdcSubmitOverride = mocks?.submitRequest || null;
  fdcPrepareOverride = mocks?.prepareRequest || null;
  alreadyVerifiedOverride = mocks?.isAlreadyVerified || null;
}

async function paymentRequiredResult(
  txHash: string,
  messagePrefix: string,
  quota?: QuotaExceededError
): Promise<AttestResult> {
  try {
    const { paymentRequired, price } = await buildPaymentRequired(txHash);
    const message = `${messagePrefix} Pay $${price.usd.toFixed(2)} USD (${price.xrp.toFixed(4)} XRP or ${price.rlusd} RLUSD) for this attestation.`;
    const body: AttestPaymentRequired["body"] = {
      code: quota ? "QUOTA_EXCEEDED" : "PAYMENT_REQUIRED",
      message,
      paymentRequired,
      priceUsd: price.usd,
      priceXrp: price.xrp,
      priceRlusd: price.rlusd,
    };
    if (quota) {
      body.tier = quota.tier;
      body.limit = quota.limit;
      body.used = quota.used;
      body.resetDate = quota.resetDate;
      body.upgradeUrl = quota.upgradeUrl;
    }
    return {
      kind: "payment_required",
      httpStatus: 402,
      body,
      paymentRequiredHeader: encodePaymentRequired(paymentRequired),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      httpStatus: 503,
      body: {
        code: "PRICE_UNAVAILABLE",
        error: "PRICE_UNAVAILABLE",
        message: `Cannot quote a pay-per-use attestation: ${reason}`,
        suggestedAction: "Retry shortly, or use a subscription API key that is inside quota.",
      },
    };
  }
}

async function resolveBillingPeriod(apiKey: ApiKey): Promise<BillingPeriod> {
  const owner = userStore.findByApiKey(apiKey.key);
  if (owner && owner.billingPeriodStart && owner.billingPeriodEnd) {
    return { start: owner.billingPeriodStart, end: owner.billingPeriodEnd };
  }
  if (owner) return getFallbackBillingPeriod(owner.createdAt);
  return getFallbackBillingPeriod(apiKey.createdAt);
}

async function submitToFdc(
  cleanHash: string,
  x402InvoiceId?: string,
  ownerKeyId?: string
): Promise<AttestResult> {
  const attestation = await store.createAttestation(cleanHash, ownerKeyId);

  try {
    const proofOwner = fdcPrepareOverride
      ? "0x0000000000000000000000000000000000000001"
      : fdc.getProofOwner();
    const prepare = fdcPrepareOverride || fdc.prepareRequest;
    const abiEncoded = await prepare(cleanHash, proofOwner);
    await store.updateAttestation(attestation.id, { abiEncodedRequest: abiEncoded });

    const submit = fdcSubmitOverride || fdc.submitRequest;
    const { roundId } = await submit(abiEncoded);
    await store.updateAttestation(attestation.id, { roundId, status: "pending" });

    if (x402InvoiceId) markPaymentFdcOk(x402InvoiceId);

    if (!fdcSubmitOverride) {
      pollForProof(attestation.id, roundId, abiEncoded).catch((err) => {
        console.error(`Polling failed for ${attestation.id}:`, err.message);
        store.updateAttestation(attestation.id, { status: "failed", error: err.message });
      });
    }

    const body: VerifyResponse & { x402?: boolean } = {
      id: attestation.id,
      txHash: cleanHash,
      roundId,
      status: "pending",
    };
    if (x402InvoiceId) body.x402 = true;

    return { kind: "ok", httpStatus: 202, body };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await store.updateAttestation(attestation.id, { status: "failed", error: message });
    if (x402InvoiceId) markPaymentFdcFailed(x402InvoiceId);
    console.error(`Attestation ${attestation.id} failed:`, message);
    return mapSubmitError(err, message, x402InvoiceId);
  }
}

function preflightToAttestError(fail: XrplPreflightFail): AttestError {
  const ctx: Record<string, string> = {};
  if (fail.ageDays != null) ctx.ageDays = String(fail.ageDays);
  if (fail.windowDays != null) ctx.windowDays = String(fail.windowDays);
  if (fail.closedAt) ctx.closedAt = fail.closedAt;
  if (fail.transactionType) ctx.transactionType = fail.transactionType;

  const body: Record<string, any> = {
    ...formatError(fail.code, Object.keys(ctx).length ? ctx : undefined),
  };
  if (fail.ageDays != null) body.ageDays = fail.ageDays;
  if (fail.windowDays != null) body.windowDays = fail.windowDays;
  if (fail.closedAt) body.closedAt = fail.closedAt;
  if (fail.transactionType) body.transactionType = fail.transactionType;
  return { kind: "error", httpStatus: fail.httpStatus, body };
}

function mapSubmitError(err: unknown, message: string, x402InvoiceId?: string): AttestError {
  const isVerifier =
    err instanceof FdcVerifierError ||
    message.startsWith("Verifier ") ||
    message.includes("Verifier returned non-VALID");

  const retry = {
    x402InvoiceId,
    retryWithoutRepayment: Boolean(x402InvoiceId),
  };

  if (isVerifier) {
    const verifierStatus = err instanceof FdcVerifierError ? err.verifierStatus : undefined;
    const httpStatus =
      err instanceof FdcVerifierError && err.httpStatus && err.httpStatus >= 500 ? 502 : 400;
    const body = {
      ...formatError("VERIFIER_ERROR", {
        message,
        ...(verifierStatus ? { status: verifierStatus } : {}),
      }),
      ...retry,
    };
    if (x402InvoiceId) {
      body.suggestedAction =
        "Payment settled but the Flare verifier rejected this hash. Retry the same request with the same PAYMENT-SIGNATURE after using a native XRP Payment from the last 14 days — you will not be charged again.";
    }
    return { kind: "error", httpStatus, body };
  }

  return {
    kind: "error",
    httpStatus: 500,
    body: {
      ...formatError("SUBMIT_FAILED", { message }),
      ...retry,
      ...(x402InvoiceId
        ? {
            suggestedAction:
              "Payment settled but FDC submit failed. Retry the same request with the same PAYMENT-SIGNATURE to resubmit to FDC without paying again.",
          }
        : {}),
    },
  };
}

function recordReceiptForCaller(opts: { apiKeyHeader?: string; apiKeyRecord?: ApiKey }, txHash: string) {
  const presented = opts.apiKeyHeader || opts.apiKeyRecord?.key;
  if (!presented) return;
  const owner = userStore.findByApiKey(presented);
  if (owner) userStore.addReceipt(owner.id, txHash);
}

async function resolveOwnerKeyId(opts: { apiKeyHeader?: string; apiKeyRecord?: ApiKey }): Promise<string | undefined> {
  if (opts.apiKeyRecord?.active) return apiKeyLookupId(opts.apiKeyRecord.key);
  if (opts.apiKeyHeader) {
    const found = await store.getApiKey(opts.apiKeyHeader);
    if (found?.active) return apiKeyLookupId(found.key);
  }
  return undefined;
}

export async function attestXrpPayment(opts: {
  txHash: string;
  apiKeyHeader?: string;
  /** When the caller already resolved the key (MCP), skip a second lookup/usage bump. */
  apiKeyRecord?: ApiKey;
  paymentSignature?: string;
}): Promise<AttestResult> {
  const { txHash, paymentSignature } = opts;
  const apiKeyHeader = opts.apiKeyHeader || opts.apiKeyRecord?.key;

  if (!txHash || typeof txHash !== "string") {
    return { kind: "error", httpStatus: 400, body: formatError("MISSING_TX_HASH", undefined, "txHash is required") };
  }

  const cleanHash = txHash.replace(/^0x/i, "").toUpperCase();
  if (!isHexTxHash(cleanHash)) {
    return { kind: "error", httpStatus: 400, body: formatError("INVALID_TX_HASH") };
  }

  const cached = await store.getByTxHash(cleanHash);
  if (cached && cached.status !== "failed" && cached.status !== "not_found") {
    const body: VerifyResponse & { cached?: boolean } = {
      id: cached.id,
      txHash: cleanHash,
      roundId: cached.roundId,
      status: cached.status,
    };
    if (cached.status === "verified") body.cached = true;
    recordReceiptForCaller(opts, cleanHash);
    return { kind: "ok", httpStatus: 200, body };
  }

  if (config.paymentVerifierAddress || alreadyVerifiedOverride) {
    try {
      const check = alreadyVerifiedOverride || fdc.isAlreadyVerified;
      if (await check(cleanHash)) {
        const ownerKeyId = await resolveOwnerKeyId(opts);
        const record = await store.createAttestation(cleanHash, ownerKeyId);
        await store.updateAttestation(record.id, { status: "verified" });
        recordReceiptForCaller(opts, cleanHash);
        return {
          kind: "ok",
          httpStatus: 200,
          body: { id: record.id, txHash: cleanHash, roundId: null, status: "verified" },
        };
      }
    } catch {}
  }

  const isMainnet = config.network === "flare";
  let apiKey: ApiKey | undefined;
  let billingPeriod: BillingPeriod | null = null;
  let x402InvoiceId: string | undefined;
  let settlement: X402SettlementResponse | undefined;

  if (paymentSignature) {
    if (!isX402Configured()) {
      return {
        kind: "error",
        httpStatus: 400,
        body: { code: "X402_UNAVAILABLE", error: "X402_UNAVAILABLE", message: "x402 is not configured" },
      };
    }
  } else if (apiKeyHeader) {
    const found = opts.apiKeyRecord || (await store.getApiKey(apiKeyHeader));
    if (!found || !found.active) {
      if (isX402Configured()) {
        return paymentRequiredResult(
          cleanHash,
          "API key is not valid. Pay per attestation with x402, or use a valid key."
        );
      }
      return { kind: "error", httpStatus: 401, body: formatError("INVALID_API_KEY") };
    }

    apiKey = found;
    if (!opts.apiKeyRecord) {
      store.incrementApiKeyUsage(apiKeyHeader);
    }

    if (isMainnet) {
      billingPeriod = await resolveBillingPeriod(apiKey);
      const periodKey = getBillingPeriodKey(billingPeriod);
      const currentUsage = await store.getAttestationUsage(apiKey.key, periodKey);
      const quotaCheck = checkQuota(apiKey.tier, currentUsage, billingPeriod);
      if (!quotaCheck.allowed) {
        const quotaError = buildQuotaExceededError(quotaCheck);
        if (isX402Configured()) {
          return paymentRequiredResult(cleanHash, quotaError.message, quotaError);
        }
        return { kind: "error", httpStatus: 402, body: quotaError };
      }
    }
  } else {
    if (isX402Configured()) {
      return paymentRequiredResult(cleanHash, "API key required, or pay per attestation with x402.");
    }
    return { kind: "error", httpStatus: 401, body: formatError("MISSING_API_KEY") };
  }

  // Skip XRPL preflight when FDC is mocked (unit/integration tests).
  if (!fdcPrepareOverride) {
    const preflight = await preflightXrplPayment(cleanHash);
    if (!preflight.ok) return preflightToAttestError(preflight);
  }

  if (paymentSignature) {
    const paid = await processX402Payment(paymentSignature, cleanHash);
    if (paid.outcome === "replay") {
      return {
        kind: "error",
        httpStatus: 409,
        body: { code: "PAYMENT_REPLAY", error: "PAYMENT_REPLAY", message: paid.error },
      };
    }
    if (paid.outcome === "failed") {
      return {
        kind: "error",
        httpStatus: 402,
        body: { code: "PAYMENT_FAILED", error: "PAYMENT_FAILED", message: paid.error },
      };
    }
    x402InvoiceId = paid.invoiceId;
    settlement = paid.settlement;
  }

  const ownerKeyId = apiKey ? apiKeyLookupId(apiKey.key) : undefined;
  const result = await submitToFdc(cleanHash, x402InvoiceId, ownerKeyId);

  if (result.kind === "ok" && !x402InvoiceId && isMainnet && billingPeriod && apiKey) {
    const periodKey = getBillingPeriodKey(billingPeriod);
    await store.incrementAttestationUsage(apiKey.key, periodKey);
  }

  if (result.kind === "ok" && settlement) {
    result.paymentResponseHeader = encodePaymentResponse(settlement);
  }

  if (result.kind === "ok") {
    const owner =
      (apiKey && userStore.findByApiKey(apiKey.key)) ||
      (apiKeyHeader ? userStore.findByApiKey(apiKeyHeader) : undefined);
    if (owner) userStore.addReceipt(owner.id, cleanHash);
  }

  return result;
}

export async function pollForProof(id: string, roundId: number, abiEncoded: string, attempt = 1) {
  await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  try {
    const proofData = await fdc.fetchProof(roundId, abiEncoded);
    if (!proofData) {
      if (attempt < config.maxPollAttempts) return pollForProof(id, roundId, abiEncoded, attempt + 1);
      await store.updateAttestation(id, { status: "not_found", error: "Proof not found after max poll attempts" });
      return;
    }
    await store.updateAttestation(id, { proof: proofData, status: "ready" });
    if (config.paymentVerifierAddress) {
      try {
        const verifiedTxHash = await fdc.verifyProofOnChain(proofData, config.paymentVerifierAddress);
        await store.updateAttestation(id, { verifiedTxHash, status: "verified" });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await store.updateAttestation(id, { error: message });
      }
    }
    await deliverWebhooks(id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < config.maxPollAttempts) return pollForProof(id, roundId, abiEncoded, attempt + 1);
    await store.updateAttestation(id, { status: "failed", error: message });
  }
}
