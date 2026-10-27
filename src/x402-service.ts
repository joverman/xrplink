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
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { getAttestationPrice, isPriceFeedAvailable, readNumber, AttestationPrice } from "./price-service.js";
import { atomicWriteFileSync, createMutex } from "./file-lock.js";
import { recordX402Settlement } from "./x402-ledger.js";
import { lookupXrplTx, TF_PARTIAL_PAYMENT, XrplIssuedAmount, XrplTxResult } from "./xrpl-tx.js";

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
  asset?: string;
  amount?: string;
  issuer?: string;
  createdAt: number;
  updatedAt: number;
}

interface PersistFile {
  quotes: Record<string, StoredQuote>;
  payments: Record<string, PaymentRecord>;
  usedPayloadHashes: string[];
}

type FacilitatorFn = (
  path: "/verify" | "/settle",
  body: unknown
) => Promise<{ ok: boolean; status: number; json: any }>;

const quotes = new Map<string, StoredQuote>();
const payments = new Map<string, PaymentRecord>();
const usedPayloadHashes = new Set<string>();
const invoiceLocks = new Map<string, Promise<void>>();

let facilitatorOverride: FacilitatorFn | null = null;
let stateLoaded = false;

function statePath(): string {
  return join(process.env.DATA_DIR || "data", "x402-state.json");
}

const stateLock = createMutex();

function persistUnlocked(): void {
  pruneQuotes();
  const file: PersistFile = {
    quotes: Object.fromEntries(quotes),
    payments: Object.fromEntries(payments),
    usedPayloadHashes: [...usedPayloadHashes],
  };
  atomicWriteFileSync(statePath(), JSON.stringify(file));
}

function persistState(): Promise<void> {
  return stateLock(() => persistUnlocked());
}

function loadState(): void {
  quotes.clear();
  payments.clear();
  usedPayloadHashes.clear();
  const path = statePath();
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistFile;
    for (const [id, q] of Object.entries(parsed.quotes || {})) quotes.set(id, q);
    for (const [id, p] of Object.entries(parsed.payments || {})) payments.set(id, p);
    for (const fp of parsed.usedPayloadHashes || []) usedPayloadHashes.add(fp);
  } catch {
    /* start empty if the file is corrupt */
  }
  pruneQuotes();
}

function ensureStateLoaded(): void {
  if (stateLoaded) return;
  stateLoaded = true;
  loadState();
}

async function withInvoiceLock<T>(invoiceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = invoiceLocks.get(invoiceId) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  invoiceLocks.set(invoiceId, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (invoiceLocks.get(invoiceId) === next) invoiceLocks.delete(invoiceId);
  }
}

export function invoiceBindingHash(invoiceId: string): string {
  return crypto.createHash("sha256").update(invoiceId, "utf8").digest("hex").toUpperCase();
}

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
  ensureStateLoaded();
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
  await stateLock(() => {
    ensureStateLoaded();
    quotes.set(invoiceId, quote);
    payments.set(invoiceId, {
      invoiceId,
      txHash,
      status: "quoted",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    persistUnlocked();
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
  ensureStateLoaded();
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
  ensureStateLoaded();
  return payments.get(invoiceId);
}

export async function markPaymentFdcOk(invoiceId: string): Promise<void> {
  await stateLock(() => {
    ensureStateLoaded();
    const rec = payments.get(invoiceId);
    if (!rec) return;
    rec.status = "fdc_ok";
    rec.updatedAt = Date.now();
    persistUnlocked();
  });
}

export async function markPaymentFdcFailed(invoiceId: string): Promise<void> {
  await stateLock(() => {
    ensureStateLoaded();
    const rec = payments.get(invoiceId);
    if (!rec) return;
    rec.status = "fdc_failed";
    rec.updatedAt = Date.now();
    persistUnlocked();
  });
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
  return null;
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
  | { outcome: "retry_fdc"; invoiceId: string; settlement: X402SettlementResponse; requirements?: X402PaymentRequirements }
  | { outcome: "replay"; invoiceId: string; error: string }
  | { outcome: "failed"; error: string };

function deliveredAmount(tx: XrplTxResult): string | XrplIssuedAmount | undefined {
  return tx.meta?.delivered_amount ?? tx.meta?.DeliveredAmount ?? tx.Amount;
}

function invoiceBoundOnTx(tx: XrplTxResult, invoiceId: string): boolean {
  const expected = invoiceBindingHash(invoiceId);
  const field = String(tx.InvoiceID || "").replace(/^0x/i, "").toUpperCase();
  if (field && field === expected) return true;
  for (const wrap of tx.Memos || []) {
    const data = wrap.Memo?.MemoData || "";
    if (!data) continue;
    if (data.replace(/^0x/i, "").toUpperCase() === expected) return true;
    try {
      const text = Buffer.from(data, "hex").toString("utf8").replace(/\0+$/, "");
      if (text === invoiceId) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function issuedMatches(
  amount: string | XrplIssuedAmount | undefined,
  quoted: string,
  issuer: string | undefined
): boolean {
  if (!amount || typeof amount === "string") return false;
  const currency = String(amount.currency || "").toUpperCase();
  const currencyOk = currency === "RLUSD" || currency === RLUSD_HEX.toUpperCase();
  const issuerOk = !issuer || amount.issuer === issuer;
  const value = Number(amount.value);
  const need = Number(quoted);
  return currencyOk && issuerOk && Number.isFinite(value) && Number.isFinite(need) && value + 1e-12 >= need;
}

export function assertSettledXrplPayment(
  tx: XrplTxResult,
  requirements: X402PaymentRequirements,
  invoiceId: string
): string | null {
  if (tx.validated !== true) return "Settlement transaction is not in a validated ledger";
  if (tx.TransactionType !== "Payment") return "Settlement transaction is not a Payment";
  if ((Number(tx.Flags || 0) & TF_PARTIAL_PAYMENT) !== 0) {
    return "Settlement used tfPartialPayment";
  }
  if (tx.Destination !== requirements.payTo) {
    return "Settlement destination does not match the quoted payTo address";
  }
  if (!invoiceBoundOnTx(tx, invoiceId)) {
    return "Settlement InvoiceID/memo does not match the quoted invoice";
  }
  const delivered = deliveredAmount(tx);
  if (requirements.asset === "XRP") {
    const drops = typeof delivered === "string" ? delivered : "";
    if (!/^\d+$/.test(drops)) return "Settlement delivered amount is not native XRP";
    try {
      if (BigInt(drops) < BigInt(requirements.amount)) {
        return "Settlement delivered amount is below the quoted price";
      }
    } catch {
      return "Settlement delivered amount is not native XRP";
    }
  } else {
    if (!issuedMatches(delivered, requirements.amount, requirements.extra.issuer)) {
      return "Settlement asset, issuer, or delivered amount does not match the quote";
    }
  }
  return null;
}

async function confirmSettlementOnLedger(
  settlementTx: string | undefined,
  requirements: X402PaymentRequirements,
  invoiceId: string
): Promise<string | null> {
  if (!settlementTx || typeof settlementTx !== "string") {
    return "Facilitator settle did not return a transaction hash";
  }
  const lookup = await lookupXrplTx(settlementTx);
  if (lookup.status !== "found") {
    return "Could not independently re-read the settlement transaction on XRPL";
  }
  return assertSettledXrplPayment(lookup.tx, requirements, invoiceId);
}

function retryRequirements(rec: PaymentRecord, quote?: StoredQuote): X402PaymentRequirements | undefined {
  if (rec.asset && rec.amount) {
    return {
      scheme: "exact",
      network: xrplNetwork(),
      asset: rec.asset,
      payTo: getPayToAddress(),
      amount: rec.amount,
      maxTimeoutSeconds: maxTimeoutSeconds(),
      extra: {
        areFeesSponsored: false,
        assetTransferMethod: "sequence",
        invoiceId: rec.invoiceId,
        sourceTag: XRPL_SOURCE_TAG,
        issuer: rec.issuer,
        resource: "/api/v1/verify/xrp-payment",
        txHash: rec.txHash,
      },
    };
  }
  if (!quote) return undefined;
  return quote.accepts.find((a) => a.asset === rec.asset) || undefined;
}

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

  return withInvoiceLock(invoiceId, () => processX402PaymentLocked(paymentSignature, expectedTxHash, paymentPayload, invoiceId));
}

async function processX402PaymentLocked(
  paymentSignature: string,
  expectedTxHash: string,
  paymentPayload: any,
  invoiceId: string
): Promise<ProcessPaymentResult> {
  ensureStateLoaded();

  const rec = payments.get(invoiceId);
  if (rec && rec.txHash !== expectedTxHash) {
    return { outcome: "failed", error: "Payment invoice is bound to a different transaction hash" };
  }

  if (rec?.status === "fdc_ok") {
    return { outcome: "replay", invoiceId, error: "Payment already used for an attestation" };
  }

  if (rec?.status === "settled" || rec?.status === "fdc_failed") {
    const quote = quotes.get(invoiceId);
    return {
      outcome: "retry_fdc",
      invoiceId,
      settlement: {
        success: true,
        transaction: rec.settlementTx,
        payer: rec.payer,
      },
      requirements: retryRequirements(rec, quote),
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

  const ledgerError = await confirmSettlementOnLedger(settlement.transaction, requirements, invoiceId);
  if (ledgerError) {
    return { outcome: "failed", error: ledgerError };
  }

  await stateLock(() => {
    usedPayloadHashes.add(fp);
    payments.set(invoiceId, {
      invoiceId,
      txHash: expectedTxHash,
      status: "settled",
      settlementTx: settlement.transaction,
      payer: settlement.payer,
      asset: requirements.asset,
      amount: requirements.amount,
      issuer: requirements.extra.issuer,
      createdAt: rec?.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
    persistUnlocked();
  });

  await recordX402Settlement({
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
  stateLoaded = true;
  try {
    if (existsSync(statePath())) unlinkSync(statePath());
  } catch {
    /* ignore */
  }
}

/** Simulate a process restart: drop memory and reload DATA_DIR state. */
export function reloadX402StateFromDiskForTests(): void {
  stateLoaded = false;
  ensureStateLoaded();
}

export function listStoredQuotesForTests(): StoredQuote[] {
  ensureStateLoaded();
  return [...quotes.values()];
}

export function getStoredQuoteCountForTests(): number {
  ensureStateLoaded();
  return quotes.size;
}

export { RLUSD_HEX };
