/**
 * XRPL JSON-RPC lookup and FDC XRPPayment preflight.
 *
 * Flare's IXRPPayment attestation (@custom:lutlimit 0x127500) can only prove
 * native XRP Payments whose ledger close time is within 1,209,600 seconds
 * (14 days). The hosted XRP indexer returns INVALID: TRANSACTION DOES NOT EXIST
 * for older hashes even when the Payment is still on XRPL mainnet.
 */

export const RIPPLE_EPOCH = 946684800;

/** IXRPPayment lutlimit 0x127500 = 1,209,600 seconds = 14 days. */
export const FDC_XRP_PAYMENT_LUT_LIMIT_SECONDS = 0x127500;
export const FDC_XRP_PAYMENT_LUT_LIMIT_DAYS = FDC_XRP_PAYMENT_LUT_LIMIT_SECONDS / 86400;

const XRP_RPC_ENDPOINTS = [
  "https://s1.ripple.com:51234",
  "https://s2.ripple.com:51234",
  "https://xrplcluster.com",
];

export interface XrplIssuedAmount {
  currency?: string;
  issuer?: string;
  value?: string;
}

export interface XrplTxResult {
  Account: string;
  Destination?: string;
  Amount?: string | XrplIssuedAmount;
  Fee?: string;
  Flags?: number;
  InvoiceID?: string;
  Memos?: { Memo: { MemoData?: string; MemoType?: string } }[];
  DestinationTag?: number;
  TransactionType: string;
  hash?: string;
  meta?: {
    TransactionResult?: string;
    delivered_amount?: string | XrplIssuedAmount;
    DeliveredAmount?: string | XrplIssuedAmount;
  };
  date?: number;
  validated?: boolean;
  ledger_index?: number;
  inLedger?: number;
}

/** tfPartialPayment — must not be set on an exact x402 Payment. */
export const TF_PARTIAL_PAYMENT = 0x00020000;

export type XrplLookup =
  | { status: "found"; tx: XrplTxResult }
  | { status: "not_found" }
  | { status: "unavailable" };

export type XrplPreflightCode =
  | "TX_NOT_ON_LEDGER"
  | "TX_NOT_PAYMENT"
  | "TX_NOT_NATIVE_XRP"
  | "TX_TOO_OLD";

export interface XrplPreflightOk {
  ok: true;
}

export interface XrplPreflightFail {
  ok: false;
  code: XrplPreflightCode;
  httpStatus: number;
  ageDays?: number;
  windowDays?: number;
  closedAt?: string;
  transactionType?: string;
}

export type XrplPreflightResult = XrplPreflightOk | XrplPreflightFail;

type LookupFn = (txHash: string) => Promise<XrplLookup>;
type NowFn = () => number;

let lookupOverride: LookupFn | null = null;
let nowOverride: NowFn | null = null;

export function setXrplLookupForTests(fn: LookupFn | null): void {
  lookupOverride = fn;
}

export function setXrplNowForTests(fn: NowFn | null): void {
  nowOverride = fn;
}

function nowMs(): number {
  return nowOverride ? nowOverride() : Date.now();
}

export function xrplCloseTimeUnix(rippleDate: number): number {
  return RIPPLE_EPOCH + rippleDate;
}

export function xrplAgeSeconds(rippleDate: number, now = nowMs()): number {
  return Math.floor(now / 1000) - xrplCloseTimeUnix(rippleDate);
}

/**
 * Look up a transaction on XRPL mainnet (ripple.com + xrplcluster).
 * Distinguishes "not in ledger" from "every RPC endpoint failed".
 */
export async function lookupXrplTx(txHash: string): Promise<XrplLookup> {
  if (lookupOverride) return lookupOverride(txHash);

  let lastError: Error | null = null;
  let sawNotFound = false;

  for (const endpoint of XRP_RPC_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "tx",
          params: [{ transaction: txHash, binary: false }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const data: any = await res.json();
      if (data.result?.Account) return { status: "found", tx: data.result };
      if (data.result?.error === "txnNotFound") {
        sawNotFound = true;
        continue;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`XRPL endpoint ${endpoint} failed:`, lastError.message);
    }
  }

  if (sawNotFound) return { status: "not_found" };
  if (lastError) {
    console.error("All XRPL endpoints failed:", lastError.message);
    return { status: "unavailable" };
  }
  return { status: "not_found" };
}

/** Receipt pages treat both missing and unreachable as "not found". */
export async function fetchXrplTx(txHash: string): Promise<XrplTxResult | null> {
  const lookup = await lookupXrplTx(txHash);
  return lookup.status === "found" ? lookup.tx : null;
}

function isNativeXrpAmount(amount: XrplTxResult["Amount"]): boolean {
  return typeof amount === "string" && /^[0-9]+$/.test(amount);
}

/**
 * Reject hashes the hosted FDC XRPPayment verifier cannot prove.
 * If XRPL RPCs are all down, returns ok so the verifier is still attempted.
 */
export async function preflightXrplPayment(txHash: string): Promise<XrplPreflightResult> {
  const lookup = await lookupXrplTx(txHash);

  if (lookup.status === "unavailable") {
    return { ok: true };
  }
  if (lookup.status === "not_found") {
    return { ok: false, code: "TX_NOT_ON_LEDGER", httpStatus: 404 };
  }

  const tx = lookup.tx;
  if (tx.TransactionType !== "Payment") {
    return {
      ok: false,
      code: "TX_NOT_PAYMENT",
      httpStatus: 400,
      transactionType: tx.TransactionType,
    };
  }
  if (!isNativeXrpAmount(tx.Amount)) {
    return { ok: false, code: "TX_NOT_NATIVE_XRP", httpStatus: 400 };
  }

  if (typeof tx.date === "number") {
    const ageSeconds = xrplAgeSeconds(tx.date);
    if (ageSeconds > FDC_XRP_PAYMENT_LUT_LIMIT_SECONDS) {
      const closedAt = new Date(xrplCloseTimeUnix(tx.date) * 1000).toISOString();
      return {
        ok: false,
        code: "TX_TOO_OLD",
        httpStatus: 400,
        ageDays: Math.round((ageSeconds / 86400) * 100) / 100,
        windowDays: FDC_XRP_PAYMENT_LUT_LIMIT_DAYS,
        closedAt,
      };
    }
  }

  return { ok: true };
}
