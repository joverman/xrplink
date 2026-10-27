/**
 * x402 pay-per-attestation and MCP scanner-safety tests.
 *
 * Facilitator and FDC are mocked. Price feed is mocked (or forced to fail).
 * The pay-to address is the well-known XRPL genesis account used only as a test fixture.
 */
import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import http from "node:http";
import express from "express";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PORT = "3459";
process.env.SESSION_SECRET = "test-secret-for-testing-1234567890";
process.env.FLARE_NETWORK = "flare";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "xrplink-x402-"));
process.env.X402_ENABLED = "true";
process.env.X402_PAY_TO_ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
process.env.X402_FLOOR_USD = "2.50";
process.env.X402_CAP_USD = "10";
process.env.X402_PRICE_STEP_USD = "0.25";
process.env.X402_MARKUP = "3";
process.env.X402_XRP_BUFFER = "0.01";
process.env.ATTESTATION_FEE_FLR = "20";
process.env.X402_QUOTE_TTL_MS = "120000";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "x402-test-admin-key";
delete process.env.X402_RLUSD_ISSUER;

const PORT = 3459;
let server: http.Server | null = null;
let storeModule: typeof import("../src/store.js");
let priceModule: typeof import("../src/price-service.js");
let x402Module: typeof import("../src/x402-service.js");
let attestModule: typeof import("../src/attest.js");
let ledgerModule: typeof import("../src/x402-ledger.js");
let xrplModule: typeof import("../src/xrpl-tx.js");

function settleHashFor(invoiceId: string): string {
  return createHash("sha256").update(`settle:${invoiceId}`).digest("hex").toUpperCase();
}

const TEST_PAY_TO = process.env.X402_PAY_TO_ADDRESS!;
const MAINNET_RLUSD = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const TESTNET_RLUSD = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const FLOOR_XRP_DROPS = "1262500"; // $2.50 / $2 * 1.01 = 1.2625 XRP

function generateTestTxHash(suffix: string): string {
  const timestamp = Date.now().toString(16).toUpperCase();
  const random = Math.random().toString(16).slice(2).toUpperCase();
  const suffixHex = Buffer.from(suffix).toString("hex").toUpperCase();
  return (timestamp + random + suffixHex).padEnd(64, "0").slice(0, 64);
}

function parseSseOrJson(data: string): any {
  const lines = data.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {}
    }
  }
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

async function request(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${PORT}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: parseSseOrJson(data), headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function mcpCall(
  method: string,
  params: any,
  headers?: Record<string, string>,
  sessionId?: string
) {
  const h: Record<string, string> = { ...headers };
  if (sessionId) h["mcp-session-id"] = sessionId;
  const res = await request("POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params }, h);
  return { ...res, sessionId: (res.headers["mcp-session-id"] as string) || sessionId };
}

function encodePayment(invoiceId: string, asset = "XRP"): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "xrpl:0",
        asset,
        extra: { invoiceId },
      },
      payload: { signedTxBlob: "00" },
    })
  ).toString("base64");
}

describe("x402 price formula", () => {
  it("applies the floor when marked-up FLR cost is below FLOOR_USD", async () => {
    const { calculateAttestationPrice } = await import("../src/price-service.js");
    const p = calculateAttestationPrice({
      flrUsd: 0.007,
      xrpUsd: 2,
      feeFlr: 20,
      markup: 3,
      floorUsd: 2.5,
      capUsd: 10,
      stepUsd: 0.25,
      xrpBuffer: 0.01,
    });
    assert.equal(p.usd, 2.5);
    assert.equal(p.floorApplied, true);
    assert.equal(p.capApplied, false);
    assert.equal(p.xrpDrops, FLOOR_XRP_DROPS);
    assert.equal(p.rlusd, "2.5");
  });

  it("rounds UP to the price step after clamp", async () => {
    const { calculateAttestationPrice } = await import("../src/price-service.js");
    // 20 × 0.043 × 3 = 2.58 → next step 2.75
    const p = calculateAttestationPrice({
      flrUsd: 0.043,
      xrpUsd: 2,
      feeFlr: 20,
      markup: 3,
      floorUsd: 2.5,
      capUsd: 10,
      stepUsd: 0.25,
      xrpBuffer: 0,
    });
    assert.equal(p.usd, 2.75);
    assert.equal(p.stepApplied, true);
  });

  it("applies the cap when marked-up cost exceeds it", async () => {
    const { calculateAttestationPrice } = await import("../src/price-service.js");
    const p = calculateAttestationPrice({
      flrUsd: 0.2,
      xrpUsd: 2,
      feeFlr: 20,
      markup: 3,
      floorUsd: 2.5,
      capUsd: 10,
      stepUsd: 0.25,
      xrpBuffer: 0.01,
    });
    assert.equal(p.usd, 10);
    assert.equal(p.capApplied, true);
    assert.equal(p.floorApplied, false);
    assert.equal(p.xrpDrops, "5050000"); // 10 / 2 * 1.01
  });

  it("adds a 1% buffer to the XRP amount only", async () => {
    const { calculateAttestationPrice } = await import("../src/price-service.js");
    const p = calculateAttestationPrice({
      flrUsd: 0.007,
      xrpUsd: 2,
      feeFlr: 20,
      markup: 3,
      floorUsd: 2.5,
      capUsd: 10,
      stepUsd: 0.25,
      xrpBuffer: 0.01,
    });
    assert.equal(p.rlusd, "2.5");
    assert.ok(p.xrp > 1.25);
    assert.equal(p.xrpDrops, "1262500");
  });

  it("fails closed on non-positive feed values", async () => {
    const { calculateAttestationPrice } = await import("../src/price-service.js");
    assert.throws(() =>
      calculateAttestationPrice({ flrUsd: 0, xrpUsd: 2, feeFlr: 20, markup: 3, floorUsd: 2.5 })
    );
  });
});

describe("x402 REST and MCP", () => {
  const facilitatorCalls: Array<{ path: string }> = [];
  let fdcSubmitCount = 0;
  let failVerify = false;
  let failFdc = false;

  before(async () => {
    process.env.X402_ENABLED = "true";
    process.env.X402_PAY_TO_ADDRESS = TEST_PAY_TO;
    process.env.X402_FLOOR_USD = "2.50";
    process.env.X402_CAP_USD = "10";
    process.env.X402_PRICE_STEP_USD = "0.25";
    process.env.X402_MARKUP = "3";
    process.env.X402_XRP_BUFFER = "0.01";
    process.env.ATTESTATION_FEE_FLR = "20";
    delete process.env.X402_RLUSD_ISSUER;

    priceModule = await import("../src/price-service.js");
    x402Module = await import("../src/x402-service.js");
    attestModule = await import("../src/attest.js");
    storeModule = await import("../src/store.js");
    ledgerModule = await import("../src/x402-ledger.js");

    priceModule.setMockPrices(0.007, 2);
    priceModule.setOnChainFeeFailureForTests(true);

    x402Module.setFacilitatorMockForTests(async (path, body) => {
      facilitatorCalls.push({ path });
      if (path === "/verify") {
        if (failVerify) {
          return { ok: true, status: 200, json: { isValid: false, invalidReason: "bad signature" } };
        }
        return { ok: true, status: 200, json: { isValid: true } };
      }
      const invoiceId = (body as any)?.paymentRequirements?.extra?.invoiceId || "unknown";
      return {
        ok: true,
        status: 200,
        json: {
          success: true,
          transaction: settleHashFor(invoiceId),
          network: "xrpl:0",
          payer: "rPayerTest",
        },
      };
    });

    xrplModule = await import("../src/xrpl-tx.js");
    xrplModule.setXrplLookupForTests(async (hash) => {
      const quotes = x402Module.listStoredQuotesForTests();
      const quote = quotes.find((q) => settleHashFor(q.invoiceId) === hash.toUpperCase());
      if (!quote) return { status: "not_found" };
      const xrp = quote.accepts.find((a) => a.asset === "XRP") || quote.accepts[0];
      return {
        status: "found",
        tx: {
          Account: "rPayerTestxxxxxxxxxxxxxxxxxxxxxxxx",
          Destination: xrp.payTo,
          Amount: xrp.amount,
          TransactionType: "Payment",
          Flags: 0,
          InvoiceID: x402Module.invoiceBindingHash(quote.invoiceId),
          validated: true,
          meta: { TransactionResult: "tesSUCCESS", delivered_amount: xrp.amount },
        },
      };
    });

    attestModule.setFdcMocksForTests({
      prepareRequest: async () => "0xencoded",
      submitRequest: async () => {
        fdcSubmitCount += 1;
        if (failFdc) throw new Error("FDC hub rejected");
        return { roundId: 42, txHash: "0xfdc" };
      },
      isAlreadyVerified: async () => false,
    });

    const app = express.default ? express.default() : express();
    app.use(express.json());
    const { default: routes } = await import("../src/routes.js");
    app.use(routes);

    await new Promise<void>((resolve, reject) => {
      server = app.listen(PORT, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
    priceModule.resetPriceServiceForTests();
    x402Module.resetX402ForTests();
    attestModule.setFdcMocksForTests(null);
    ledgerModule.resetX402LedgerForTests();
    xrplModule.setXrplLookupForTests(null);
  });

  beforeEach(() => {
    facilitatorCalls.length = 0;
    fdcSubmitCount = 0;
    failVerify = false;
    failFdc = false;
    priceModule.resetPriceServiceForTests();
    priceModule.setMockPrices(0.007, 2);
    priceModule.setOnChainFeeFailureForTests(true);
    process.env.X402_ENABLED = "true";
    process.env.X402_PAY_TO_ADDRESS = TEST_PAY_TO;
    delete process.env.X402_RLUSD_ISSUER;
    process.env.XRPL_NETWORK = "xrpl:0";
    process.env.X402_QUOTE_TTL_MS = "120000";
  });

  it("returns a spec-shaped 402 with RLUSD first and XRP second", async () => {
    const txHash = generateTestTxHash("NOKEY");
    const res = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, "PAYMENT_REQUIRED");
    assert.ok(res.headers["payment-required"], "PAYMENT-REQUIRED header");
    const pr = res.body.paymentRequired;
    assert.equal(pr.x402Version, 2);
    assert.equal(pr.accepts.length, 2);
    const rlusd = pr.accepts[0];
    const xrp = pr.accepts[1];
    assert.equal(rlusd.asset, RLUSD_HEX);
    assert.equal(rlusd.extra.issuer, MAINNET_RLUSD);
    assert.equal(rlusd.amount, "2.5");
    assert.equal(rlusd.payTo, TEST_PAY_TO);
    assert.equal(xrp.asset, "XRP");
    assert.equal(xrp.scheme, "exact");
    assert.equal(xrp.network, "xrpl:0");
    assert.equal(xrp.payTo, TEST_PAY_TO);
    assert.equal(xrp.amount, FLOOR_XRP_DROPS);
    assert.equal(xrp.extra.areFeesSponsored, false);
    assert.ok(xrp.extra.invoiceId);
    assert.equal(rlusd.extra.invoiceId, xrp.extra.invoiceId);
    assert.equal(res.body.priceUsd, 2.5);
    const after = await storeModule.store.getByTxHash(txHash);
    assert.equal(after, undefined);
    assert.equal(fdcSubmitCount, 0);
  });

  it("includes RLUSD by default without X402_RLUSD_ISSUER", async () => {
    assert.equal(process.env.X402_RLUSD_ISSUER, undefined);
    const { paymentRequired } = await x402Module.buildPaymentRequired(generateTestTxHash("DEFISS"));
    assert.equal(paymentRequired.accepts[0].extra.issuer, MAINNET_RLUSD);
    assert.equal(x402Module.defaultRlusdIssuer("xrpl:0"), MAINNET_RLUSD);
    assert.equal(x402Module.defaultRlusdIssuer("xrpl:1"), TESTNET_RLUSD);
  });

  it("uses the documented testnet RLUSD issuer when XRPL_NETWORK is testnet", async () => {
    process.env.XRPL_NETWORK = "xrpl:1";
    const { paymentRequired } = await x402Module.buildPaymentRequired(generateTestTxHash("TNISS"));
    assert.equal(paymentRequired.accepts[0].extra.issuer, TESTNET_RLUSD);
    assert.equal(paymentRequired.accepts[1].asset, "XRP");
  });

  it("settles a valid x402 payment then attests", async () => {
    const txHash = generateTestTxHash("PAID");
    const quote = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    assert.equal(quote.status, 402);
    const invoiceId = quote.body.paymentRequired.accepts[0].extra.invoiceId;
    const sig = encodePayment(invoiceId);

    const paid = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "PAYMENT-SIGNATURE": sig });
    assert.equal(paid.status, 202, JSON.stringify(paid.body));
    assert.equal(paid.body.status, "pending");
    assert.equal(paid.body.x402, true);
    assert.equal(fdcSubmitCount, 1);
    assert.ok(facilitatorCalls.some((c) => c.path === "/verify"));
    assert.ok(facilitatorCalls.some((c) => c.path === "/settle"));
    assert.ok(paid.headers["payment-response"]);
  });

  it("logs quotes and settlements by invoice id and computes daily margin", async () => {
    ledgerModule.resetX402LedgerForTests();
    const txHash = generateTestTxHash("LEDGER");
    const quote = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    const invoiceId = quote.body.paymentRequired.accepts[0].extra.invoiceId;
    const eventsAfterQuote = ledgerModule.listX402LedgerEvents();
    assert.ok(!eventsAfterQuote.some((e) => e.invoiceId === invoiceId), "quotes must not write a ledger row");

    const sig = encodePayment(invoiceId);
    const paid = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "PAYMENT-SIGNATURE": sig });
    assert.equal(paid.status, 202);
    const events = ledgerModule.listX402LedgerEvents();
    const settled = events.find((e) => e.type === "settled" && e.invoiceId === invoiceId);
    assert.ok(settled);
    assert.equal(settled.usd, 2.5);
    assert.equal(settled.feeFlr, 20);
    const margin = ledgerModule.getDailyMargin(settled.time.slice(0, 10));
    assert.equal(margin.settlements, 1);
    assert.equal(margin.revenueUsd, 2.5);
    assert.ok(margin.flrCostUsd > 0);
    assert.ok(margin.marginUsd > 0);
  });

  it("serves the daily margin summary only with X-Admin-Key", async () => {
    process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "x402-test-admin-key";
    const pro = await storeModule.store.createApiKey("margin-admin", "pro");
    const paid = await storeModule.store.createApiKey("margin-paid", "paid");
    const forbiddenPaid = await request("GET", "/api/v1/admin/x402-margin", undefined, { "X-API-Key": paid.key });
    assert.equal(forbiddenPaid.status, 403);
    const forbiddenPro = await request("GET", "/api/v1/admin/x402-margin", undefined, { "X-API-Key": pro.key });
    assert.equal(forbiddenPro.status, 403);
    const ok = await request("GET", "/api/v1/admin/x402-margin", undefined, {
      "X-Admin-Key": process.env.ADMIN_API_KEY,
    });
    assert.equal(ok.status, 200);
    assert.ok(typeof ok.body.revenueUsd === "number");
    assert.ok(typeof ok.body.flrCostUsd === "number");
    assert.ok(typeof ok.body.marginUsd === "number");
  });

  it("rejects a replay of the same payment and does not call FDC again", async () => {
    const txHash = generateTestTxHash("REPLAY");
    const quote = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    const invoiceId = quote.body.paymentRequired.accepts[0].extra.invoiceId;
    const sig = encodePayment(invoiceId);

    const first = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "PAYMENT-SIGNATURE": sig });
    assert.equal(first.status, 202);
    assert.equal(fdcSubmitCount, 1);

    const replay = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "PAYMENT-SIGNATURE": sig });
    assert.ok(replay.status === 409 || replay.status === 200, `unexpected ${replay.status}`);
    assert.equal(fdcSubmitCount, 1);
  });

  it("rejects an invalid payment without calling FDC", async () => {
    failVerify = true;
    const txHash = generateTestTxHash("BADPAY");
    const quote = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    const invoiceId = quote.body.paymentRequired.accepts[0].extra.invoiceId;
    const sig = encodePayment(invoiceId);

    const paid = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "PAYMENT-SIGNATURE": sig });
    assert.equal(paid.status, 402);
    assert.equal(paid.body.code, "PAYMENT_FAILED");
    assert.equal(fdcSubmitCount, 0);
    const after = await storeModule.store.getByTxHash(txHash);
    assert.equal(after, undefined);
  });

  it("does not ask a subscriber inside quota to pay", async () => {
    const { store } = storeModule;
    const paidKey = await store.createApiKey("x402-subscriber", "paid");
    const txHash = generateTestTxHash("SUB");

    const res = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "X-API-Key": paidKey.key });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.status, "pending");
    assert.equal(fdcSubmitCount, 1);
    assert.equal(facilitatorCalls.length, 0);
    assert.equal(res.body.x402, undefined);
  });

  it("offers an over-quota Paid subscriber an upgrade prompt and an x402 extra", async () => {
    const { store } = storeModule;
    const { ATTESTATION_LIMITS, getFallbackBillingPeriod, getBillingPeriodKey } = await import(
      "../src/attestation-quota.js"
    );
    const paidKey = await store.createApiKey("x402-over-quota", "paid");
    const period = getFallbackBillingPeriod(paidKey.createdAt);
    const periodKey = getBillingPeriodKey(period);
    for (let i = 0; i < ATTESTATION_LIMITS.paid; i++) {
      await store.incrementAttestationUsage(paidKey.key, periodKey);
    }

    const txHash = generateTestTxHash("OVERCAP");
    const res = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "X-API-Key": paidKey.key });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, "QUOTA_EXCEEDED");
    assert.ok(res.body.message.includes("Upgrade to Pro"));
    assert.ok(res.body.message.toLowerCase().includes("pay-per-use"));
    assert.equal(res.body.upgradeUrl, "/pricing");
    assert.equal(res.body.paymentRequired.accepts[0].asset, RLUSD_HEX);
    assert.equal(res.body.paymentRequired.accepts[1].asset, "XRP");
    assert.equal(res.body.priceUsd, 2.5);
    assert.equal(fdcSubmitCount, 0);
  });

  it("fails closed when FTSO and Kraken are down", async () => {
    priceModule.setPriceFeedFailureForTests(true);
    priceModule.clearPriceCache();
    const txHash = generateTestTxHash("NOPRICE");
    const res = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "PRICE_UNAVAILABLE");
    assert.equal(fdcSubmitCount, 0);
    priceModule.setMockPrices(0.007, 2);
  });

  it("falls back to Kraken when FTSO is down", async () => {
    priceModule.setPriceFeedFailureForTests(true);
    priceModule.clearPriceCache();
    priceModule.setKrakenMockForTests(0.007, 2);
    const txHash = generateTestTxHash("KRAKEN");
    const res = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.priceUsd, 2.5);
  });

  it("fails closed when the only cached price is older than max age", async () => {
    priceModule.setStalePriceCacheForTests(0.007, 2, 400_000);
    const txHash = generateTestTxHash("STALE");
    const res = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "PRICE_UNAVAILABLE");
  });

  it("uses the on-chain FDC fee when available", async () => {
    priceModule.setMockOnChainFeeFlr(25);
    priceModule.setMockPrices(0.05, 2);
    const p = await priceModule.getAttestationPrice();
    assert.equal(p.flrCost, 25);
    assert.equal(p.usd, 3.75);
  });

  it("rejects an expired quote", async () => {
    process.env.X402_QUOTE_TTL_MS = "1";
    const txHash = generateTestTxHash("TTL");
    const { paymentRequired } = await x402Module.buildPaymentRequired(txHash);
    await new Promise((r) => setTimeout(r, 5));
    const invoiceId = paymentRequired.accepts[0].extra.invoiceId;
    assert.equal(x402Module.getQuote(invoiceId), undefined);
    process.env.X402_QUOTE_TTL_MS = "120000";
  });

  it("lets FDC retry after settlement if submit fails, without a second charge", async () => {
    failFdc = true;
    const txHash = generateTestTxHash("FDCFAIL");
    const quote = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    const invoiceId = quote.body.paymentRequired.accepts[0].extra.invoiceId;
    const sig = encodePayment(invoiceId);

    const first = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "PAYMENT-SIGNATURE": sig });
    assert.equal(first.status, 500);
    assert.equal(first.body.retryWithoutRepayment, true);
    assert.equal(fdcSubmitCount, 1);
    const settleCalls = facilitatorCalls.filter((c) => c.path === "/settle").length;

    failFdc = false;
    const retry = await request("POST", "/api/v1/verify/xrp-payment", { txHash }, { "PAYMENT-SIGNATURE": sig });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    assert.equal(fdcSubmitCount, 2);
    assert.equal(facilitatorCalls.filter((c) => c.path === "/settle").length, settleCalls);
  });

  it("initialize with SmitheryBot user-agent is not 403", async () => {
    const res = await request(
      "POST",
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "SmitheryBot", version: "1.0" },
        },
      },
      { "User-Agent": "SmitheryBot/1.0", Accept: "application/json, text/event-stream" }
    );
    assert.notEqual(res.status, 403);
    assert.ok(res.status >= 200 && res.status < 400, `got ${res.status}`);
  });

  it("tools/list works without an API key", async () => {
    const init = await mcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "crawler", version: "1.0" },
    });
    assert.notEqual(init.status, 403);
    const listed = await mcpCall("tools/list", {}, undefined, init.sessionId);
    assert.notEqual(listed.status, 403);
    assert.equal(listed.status, 200);
    const tools = listed.body?.result?.tools || listed.body?.tools;
    const names = (tools || []).map((t: any) => t.name);
    assert.ok(names.includes("verify_xrp_payment"));
    assert.ok(names.includes("get_server_info"));
  });

  it("unauthenticated verify_xrp_payment is a tool error, never HTTP 403", async () => {
    const init = await mcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent", version: "1.0" },
    });
    const txHash = generateTestTxHash("MCP402");
    const call = await mcpCall(
      "tools/call",
      { name: "verify_xrp_payment", arguments: { txHash } },
      undefined,
      init.sessionId
    );
    assert.notEqual(call.status, 403);
    assert.equal(call.status, 200);
    const result = call.body.result || call.body;
    assert.equal(result.isError, true);
    const text = result.content?.[0]?.text || "";
    assert.ok(/api key|payment|x402|402/i.test(text), text.slice(0, 300));
  });

  it("invalid API key on /mcp is not 403", async () => {
    const init = await mcpCall(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent", version: "1.0" },
      },
      { "X-API-Key": "sk_live_not_a_real_key" }
    );
    assert.notEqual(init.status, 403);
    const call = await mcpCall(
      "tools/call",
      { name: "get_server_info", arguments: {} },
      { "X-API-Key": "sk_live_not_a_real_key" },
      init.sessionId
    );
    assert.notEqual(call.status, 403);
    assert.equal(call.status, 200);
  });
});
