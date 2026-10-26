/**
 * x402 v2 pay-per-attestation on the XRP Ledger.
 *
 * Uses the hosted XRPL facilitator (verify + settle). Payments are payer-signed
 * XRPL Payment transactions; this server never holds buyer keys.
 *
 * Spec: https://docs.x402.org and the XRPL exact scheme
 * (payer-signed Payment, invoice binding via InvoiceID = SHA-256(invoiceId)).
 */

import crypto from "crypto";
import { getAttestationPrice, isPriceFeedAvailable, readNumber, AttestationPrice } from "./price-service.js";
import { recordX402Quote, recordX402Settlement } from "./x402-ledger.js";

const DEFAULT_FACILITATOR = "https://xrpl-facilitator-mainnet.t54.ai";
const RLUSD_HEX = "524C555344000000000000000000000000000000";
/**
 * Official Ripple USD issuers.
 * Mainnet: https://docs.ripple.com/products/stablecoin/overview/token-addresses
 * Testnet: https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
 * The pay-to wallet must already hold an RLUSD trust line to the issuer in use.
 */
export const DEFAULT_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
export const DEFAULT_RLUSD_ISSUER_TESTNET = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const DEFAULT_QUOTE_TTL_MS = 120_000;
/** t54 XRPL exact scheme default SourceTag. */
const XRPL_SOURCE_TAG = 804681468;

/** Classic XRPL address (no secrets — validation only). */
const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export interface X402PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
    extra: {
      areFeesSponsored: false;
      assetTransferMethod: "sequence";
      invoiceId: string;
      sourceTag: number;
      issuer?: string;
      resource: string;
      txHash: string;
    };
}

export interface X402PaymentRequired {
  x402Version: 2;
  error: string;
  accepts: X402PaymentRequirements[];
}

export interface X402SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  error?: string;
  errorReason?: string;
}

export interface StoredQuote {
  invoiceId: string;
  txHash: string;
  accepts: X402PaymentRequirements[];
  price: AttestationPrice;
  createdAt: number;
}

export type PaymentRecordStatus = "quoted" | "settled" | "fdc_ok" | "fdc_failed";

export interface PaymentRecord {
  invoiceId: string;
  txHash: string;
  status: PaymentRecordStatus;
  settlementTx?: string;
  payer?: string;
  createdAt: number;
  updatedAt: number;
}

type FacilitatorFn = (
  path: "/verify" | "/settle",
  body: unknown
) => Promise<{ ok: boolean; status: number; json: any }>;

const quotes = new Map<string, StoredQuote>();
const payments = new Map<string, PaymentRecord>();
const usedPayloadHashes = new Set<string>();

let facilitatorOverride: FacilitatorFn | null = null;

function facilitatorUrl(): string {
  return process.env.XRPL_FACILITATOR_URL || DEFAULT_FACILITATOR;
}

function xrplNetwork(): string {
  return process.env.XRPL_NETWORK || "xrpl:0";
}

export function isXrplTestnet(network = xrplNetwork()): boolean {
  const n = network.toLowerCase();
  return n === "xrpl:1" || n === "testnet" || n.includes("testnet") || n === "xrpl-testnet";
}

export function defaultRlusdIssuer(network = xrplNetwork()): string {
  return isXrplTestnet(network) ? DEFAULT_RLUSD_ISSUER_TESTNET : DEFAULT_RLUSD_ISSUER;
}

export function getPayToAddress(): string {
  const addr = (process.env.X402_PAY_TO_ADDRESS || "").trim();
  if (!addr || !XRPL_ADDRESS_RE.test(addr)) return "";
  return addr;
}

export function isX402Enabled(): boolean {
  return process.env.X402_ENABLED !== "false";
}

function rlusdIssuer(): string {
  return (process.env.X402_RLUSD_ISSUER || defaultRlusdIssuer()).trim();
}

export function getQuoteTtlMs(): number {
  return readNumber("X402_QUOTE_TTL_MS", DEFAULT_QUOTE_TTL_MS);
}

function maxTimeoutSeconds(): number {
  return Math.max(1, Math.ceil(getQuoteTtlMs() / 1000));
}

export function generateInvoiceId(txHash: string): string {
  const rand = crypto.randomBytes(8).toString("hex");
  return `xrplink:${txHash.slice(0, 16).toLowerCase()}:${Date.now().toString(36)}:${rand}`;
}

export function payloadFingerprint(paymentSignature: string): string {
  return crypto.createHash("sha256").update(paymentSignature).digest("hex");
}

function pruneQuotes(): void {
  const now = Date.now();
  const ttl = getQuoteTtlMs();
  for (const [id, q] of quotes) {
    if (now - q.createdAt > ttl) quotes.delete(id);
  }
}

export function isX402Configured(): boolean {
  return isX402Enabled() && Boolean(getPayToAddress());
}

export async function isX402Available(): Promise<{ available: boolean; reason?: string }> {
  if (!isX402Enabled()) return { available: false, reason: "x402 is disabled" };
  if (!getPayToAddress()) {
    return { available: false, reason: "X402_PAY_TO_ADDRESS is not set to a valid XRPL address" };
  }
  try {
    const ok = await isPriceFeedAvailable();
    if (!ok) return { available: false, reason: "Price feed unavailable" };
  } catch {
    return { available: false, reason: "Price feed unavailable" };
  }
  return { available: true };
}

export async function buildPaymentRequired(txHash: string): Promise<{
  paymentRequired: X402PaymentRequired;
  quote: StoredQuote;
  price: AttestationPrice;
}> {
  const payTo = getPayToAddress();
  if (!payTo) {
    throw new Error("X402_PAY_TO_ADDRESS is not configured");
  }

  const price = await getAttestationPrice();
  const invoiceId = generateInvoiceId(txHash);
  const network = xrplNetwork();
  const timeout = maxTimeoutSeconds();

  const accepts: X402PaymentRequirements[] = [];
  const issuer = rlusdIssuer();
  if (issuer && XRPL_ADDRESS_RE.test(issuer)) {
    accepts.push({
      scheme: "exact",
      network,
      asset: RLUSD_HEX,
      payTo,
      amount: price.rlusd,
      maxTimeoutSeconds: timeout,
      extra: {
        areFeesSponsored: false,
        assetTransferMethod: "sequence",
        invoiceId,
        sourceTag: XRPL_SOURCE_TAG,
        issuer,
        resource: "/api/v1/verify/xrp-payment",
        txHash,
      },
    });
  }

  accepts.push({
    scheme: "exact",
    network,
    asset: "XRP",
    payTo,
    amount: price.xrpDrops,
    maxTimeoutSeconds: timeout,
    extra: {
      areFeesSponsored: false,
      assetTransferMethod: "sequence",
      invoiceId,
      sourceTag: XRPL_SOURCE_TAG,
      resource: "/api/v1/verify/xrp-payment",
      txHash,
    },
  });

  const paymentRequired: X402PaymentRequired = {
    x402Version: 2,
    error: `Payment of $${price.usd.toFixed(2)} USD required for one XRP payment attestation. Pay in RLUSD or XRP, or upgrade at /pricing.`,
    accepts,
  };

  const quote: StoredQuote = {
    invoiceId,
    txHash,
    accepts,
    price,
    createdAt: Date.now(),
  };
  quotes.set(invoiceId, quote);
  payments.set(invoiceId, {
    invoiceId,
    txHash,
    status: "quoted",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  recordX402Quote({
    invoiceId,
    time: new Date(quote.createdAt).toISOString(),
    usd: price.usd,
    flrUsd: price.flrUsdRate,
    feeFlr: price.flrCost,
    flrCostUsd: price.flrCost * price.flrUsdRate,
    xrpUsd: price.xrpUsdRate,
    assets: accepts.map((a) => ({ asset: a.asset === RLUSD_HEX ? "RLUSD" : a.asset, amount: a.amount })),
  });

  return { paymentRequired, quote, price };
}

export function encodePaymentRequired(paymentRequired: X402PaymentRequired): string {
  return Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
}

export function encodePaymentResponse(settlement: X402SettlementResponse): string {
  return Buffer.from(JSON.stringify(settlement)).toString("base64");
}

export function decodePaymentPayload(header: string): any {
  const json = Buffer.from(header, "base64").toString("utf-8");
  return JSON.parse(json);
}

export function extractInvoiceId(payload: any): string | null {
  return (
    payload?.accepted?.extra?.invoiceId ||
    payload?.extra?.invoiceId ||
    payload?.invoiceId ||
    null
  );
}

export function getQuote(invoiceId: string): StoredQuote | undefined {
  pruneQuotes();
  const q = quotes.get(invoiceId);
  if (!q) return undefined;
  if (Date.now() - q.createdAt > getQuoteTtlMs()) {
    quotes.delete(invoiceId);
    return undefined;
  }
  return q;
}

export function getPaymentRecord(invoiceId: string): PaymentRecord | undefined {
  return payments.get(invoiceId);
}

export function markPaymentFdcOk(invoiceId: string): void {
  const rec = payments.get(invoiceId);
  if (!rec) return;
  rec.status = "fdc_ok";
  rec.updatedAt = Date.now();
}

export function markPaymentFdcFailed(invoiceId: string): void {
  const rec = payments.get(invoiceId);
  if (!rec) return;
  rec.status = "fdc_failed";
  rec.updatedAt = Date.now();
}

function matchAccept(payload: any, accepts: X402PaymentRequirements[]): X402PaymentRequirements | null {
  const accepted = payload?.accepted;
  if (accepted?.asset) {
    const hit = accepts.find((a) => a.asset.toUpperCase() === String(accepted.asset).toUpperCase());
    if (hit) return hit;
  }
  const asset = payload?.asset || payload?.price?.asset;
  if (asset) {
    const hit = accepts.find((a) => a.asset.toUpperCase() === String(asset).toUpperCase());
    if (hit) return hit;
  }
  return accepts[0] || null;
}

async function callFacilitator(path: "/verify" | "/settle", body: unknown): Promise<{ ok: boolean; json: any }> {
  if (facilitatorOverride) {
    const res = await facilitatorOverride(path, body);
    return { ok: res.ok, json: res.json };
  }

  const url = `${facilitatorUrl().replace(/\/$/, "")}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    json = { error: await response.text().catch(() => "unreadable facilitator response") };
  }
  return { ok: response.ok, json };
}

export async function verifyWithFacilitator(
  paymentPayload: any,
  paymentRequirements: X402PaymentRequirements
): Promise<{ valid: boolean; error?: string }> {
  const { ok, json } = await callFacilitator("/verify", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });
  const valid = json?.isValid === true || json?.valid === true || json?.isValid === "true";
  if (!ok || !valid) {
    const error = json?.invalidReason || json?.errorReason || json?.error || "Payment verification failed";
    return { valid: false, error: String(error) };
  }
  return { valid: true };
}

export async function settleWithFacilitator(
  paymentPayload: any,
  paymentRequirements: X402PaymentRequirements
): Promise<X402SettlementResponse> {
  const { ok, json } = await callFacilitator("/settle", {
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });
  if (!ok || json?.success === false) {
    return {
      success: false,
      error: String(json?.errorReason || json?.error || json?.invalidReason || "Settlement failed"),
      errorReason: json?.errorReason,
      transaction: json?.transaction,
      network: json?.network,
    };
  }
  return {
    success: true,
    transaction: json?.transaction,
    network: json?.network,
    payer: json?.payer,
  };
}

export type ProcessPaymentResult =
  | { outcome: "settled"; invoiceId: string; settlement: X402SettlementResponse; requirements: X402PaymentRequirements }
  | { outcome: "retry_fdc"; invoiceId: string; settlement: X402SettlementResponse; requirements: X402PaymentRequirements }
  | { outcome: "replay"; invoiceId: string; error: string }
  | { outcome: "failed"; error: string };

/**
 * Verify then settle a PAYMENT-SIGNATURE against a stored quote.
 * One settled payment authorizes exactly one attestation.
 * A payload replay after successful FDC is rejected.
 * If FDC previously failed after settlement, returns retry_fdc (no second charge).
 */
export async function processX402Payment(
  paymentSignature: string,
  expectedTxHash: string
): Promise<ProcessPaymentResult> {
  let paymentPayload: any;
  try {
    paymentPayload = decodePaymentPayload(paymentSignature);
  } catch {
    return { outcome: "failed", error: "Invalid PAYMENT-SIGNATURE encoding" };
  }

  const invoiceId = extractInvoiceId(paymentPayload);
  if (!invoiceId) {
    return { outcome: "failed", error: "Payment payload missing invoiceId" };
  }

  const rec = payments.get(invoiceId);
  if (rec && rec.txHash !== expectedTxHash) {
    return { outcome: "failed", error: "Payment invoice is bound to a different transaction hash" };
  }

  if (rec?.status === "fdc_ok") {
    return { outcome: "replay", invoiceId, error: "Payment already used for an attestation" };
  }

  if (rec?.status === "settled" || rec?.status === "fdc_failed") {
    const quote = quotes.get(invoiceId);
    const requirements = quote?.accepts[0];
    if (!requirements) {
      return { outcome: "failed", error: "Previous payment found but quote expired; contact support with settlement tx" };
    }
    return {
      outcome: "retry_fdc",
      invoiceId,
      settlement: {
        success: true,
        transaction: rec.settlementTx,
        payer: rec.payer,
      },
      requirements,
    };
  }

  const fp = payloadFingerprint(paymentSignature);
  if (usedPayloadHashes.has(fp)) {
    return { outcome: "replay", invoiceId, error: "Payment already used for an attestation" };
  }

  const quote = getQuote(invoiceId);
  if (!quote) {
    return { outcome: "failed", error: "Unknown or expired payment quote. Request a new 402 quote." };
  }
  if (quote.txHash !== expectedTxHash) {
    return { outcome: "failed", error: "Payment invoice is bound to a different transaction hash" };
  }

  const requirements = matchAccept(paymentPayload, quote.accepts);
  if (!requirements) {
    return { outcome: "failed", error: "Payment asset not accepted" };
  }

  const verification = await verifyWithFacilitator(paymentPayload, requirements);
  if (!verification.valid) {
    return { outcome: "failed", error: verification.error || "Payment verification failed" };
  }

  const settlement = await settleWithFacilitator(paymentPayload, requirements);
  if (!settlement.success) {
    return { outcome: "failed", error: settlement.error || "Payment settlement failed" };
  }

  usedPayloadHashes.add(fp);
  payments.set(invoiceId, {
    invoiceId,
    txHash: expectedTxHash,
    status: "settled",
    settlementTx: settlement.transaction,
    payer: settlement.payer,
    createdAt: rec?.createdAt || Date.now(),
    updatedAt: Date.now(),
  });

  recordX402Settlement({
    invoiceId,
    time: new Date().toISOString(),
    asset: requirements.asset === RLUSD_HEX ? "RLUSD" : requirements.asset,
    amount: requirements.amount,
    usd: quote.price.usd,
    flrUsd: quote.price.flrUsdRate,
    feeFlr: quote.price.flrCost,
    flrCostUsd: quote.price.flrCost * quote.price.flrUsdRate,
    settlementTx: settlement.transaction,
  });

  return { outcome: "settled", invoiceId, settlement, requirements };
}

export function getX402Config() {
  const payTo = getPayToAddress();
  return {
    enabled: isX402Enabled(),
    facilitatorUrl: facilitatorUrl(),
    network: xrplNetwork(),
    payToConfigured: Boolean(payTo),
    rlusdIssuerConfigured: Boolean(rlusdIssuer()) && XRPL_ADDRESS_RE.test(rlusdIssuer()),
    rlusdIssuer: rlusdIssuer(),
    quoteTtlMs: getQuoteTtlMs(),
  };
}

export function setFacilitatorMockForTests(fn: FacilitatorFn | null): void {
  facilitatorOverride = fn;
}

export function resetX402ForTests(): void {
  quotes.clear();
  payments.clear();
  usedPayloadHashes.clear();
  facilitatorOverride = null;
}

export function getStoredQuoteCountForTests(): number {
  return quotes.size;
}

export { RLUSD_HEX };
