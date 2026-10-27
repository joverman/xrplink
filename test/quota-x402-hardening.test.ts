/**
 * PR 2: atomic quota reservation, persisted x402 replay, settlement XRPL checks,
 * contact HTML escape, and verify-path rate limits.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, before, after, beforeEach } from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32-chars-min!!";
process.env.NODE_ENV = "test";
process.env.FLARE_NETWORK = "flare";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "xrplink-quota-"));
process.env.X402_ENABLED = "true";
process.env.X402_PAY_TO_ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
process.env.X402_FLOOR_USD = "2.50";
process.env.X402_CAP_USD = "10";
process.env.X402_PRICE_STEP_USD = "0.25";
process.env.X402_MARKUP = "3";
process.env.X402_XRP_BUFFER = "0.01";
process.env.ATTESTATION_FEE_FLR = "20";
process.env.X402_QUOTE_TTL_MS = "120000";
delete process.env.DATABASE_URL;
delete process.env.X402_RLUSD_ISSUER;
delete process.env.PAYMENT_VERIFIER_ADDRESS;
delete process.env.PAYMENT_VERIFIER_ADDRESS_FLARE;

function generateTestTxHash(suffix: string): string {
  const timestamp = Date.now().toString(16).toUpperCase();
  const random = Math.random().toString(16).slice(2).toUpperCase();
  const suffixHex = Buffer.from(suffix).toString("hex").toUpperCase();
  return (timestamp + random + suffixHex).padEnd(64, "0").slice(0, 64);
}

function settleHashFor(invoiceId: string): string {
  return createHash("sha256").update(`settle:${invoiceId}`).digest("hex").toUpperCase();
}

function encodePayment(invoiceId: string, asset = "XRP"): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "exact", network: "xrpl:0", asset, extra: { invoiceId } },
      payload: { signedTxBlob: "00" },
    })
  ).toString("base64");
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { body?: any; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    const headers: Record<string, string> = { Connection: "close", ...opts.headers };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        agent: new http.Agent({ keepAlive: false }),
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let body: any;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

describe("Contact email HTML escape", () => {
  it("escapes angle brackets and quotes", async () => {
    const { escapeHtml } = await import("../src/email.js");
    assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    assert.equal(escapeHtml("a&b"), "a&amp;b");
  });
});

describe("Atomic quota and x402 integrity", () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: typeof import("../src/store.js").store;
  let x402: typeof import("../src/x402-service.js");
  let attest: typeof import("../src/attest.js");
  let xrpl: typeof import("../src/xrpl-tx.js");
  let price: typeof import("../src/price-service.js");
  let ATTESTATION_LIMITS: typeof import("../src/attestation-quota.js").ATTESTATION_LIMITS;
  let getFallbackBillingPeriod: typeof import("../src/attestation-quota.js").getFallbackBillingPeriod;
  let getBillingPeriodKey: typeof import("../src/attestation-quota.js").getBillingPeriodKey;
  let fdcSubmitCount = 0;
  let xrplMode: "match" | "partial" | "wrong-dest" = "match";
  const payTo = process.env.X402_PAY_TO_ADDRESS!;
  const installSettlementLookup = () => {
    xrpl.setXrplLookupForTests(async (hash) => {
      const quotes = x402.listStoredQuotesForTests();
      const quote = quotes.find((q) => settleHashFor(q.invoiceId) === hash.toUpperCase());
      const xrp = quote?.accepts.find((a) => a.asset === "XRP") || quote?.accepts[0];
      const dest = xrplMode === "wrong-dest" ? "rWrongDestinationxxxxxxxxxxxxxxxxxx" : payTo;
      const flags = xrplMode === "partial" ? xrpl.TF_PARTIAL_PAYMENT : 0;
      const amount = xrplMode === "partial" ? "1" : xrp?.amount || "1262500";
      return {
        status: "found",
        tx: {
          Account: "rPayer",
          Destination: dest,
          Amount: amount,
          TransactionType: "Payment",
          Flags: flags,
          InvoiceID: quote ? x402.invoiceBindingHash(quote.invoiceId) : "",
          validated: true,
          meta: { TransactionResult: "tesSUCCESS", delivered_amount: amount },
        },
      };
    });
  };

  before(async () => {
    price = await import("../src/price-service.js");
    x402 = await import("../src/x402-service.js");
    attest = await import("../src/attest.js");
    xrpl = await import("../src/xrpl-tx.js");
    store = (await import("../src/store.js")).store;
    const quota = await import("../src/attestation-quota.js");
    ATTESTATION_LIMITS = quota.ATTESTATION_LIMITS;
    getFallbackBillingPeriod = quota.getFallbackBillingPeriod;
    getBillingPeriodKey = quota.getBillingPeriodKey;

    price.setMockPrices(0.007, 2);
    price.setOnChainFeeFailureForTests(true);

    x402.setFacilitatorMockForTests(async (path, body) => {
      if (path === "/verify") return { ok: true, status: 200, json: { isValid: true } };
      const invoiceId = (body as any)?.paymentRequirements?.extra?.invoiceId || "unknown";
      return {
        ok: true,
        status: 200,
        json: { success: true, transaction: settleHashFor(invoiceId), network: "xrpl:0", payer: "rPayer" },
      };
    });

    installSettlementLookup();

    attest.setFdcMocksForTests({
      prepareRequest: async () => "0xencoded",
      submitRequest: async () => {
        fdcSubmitCount += 1;
        return { roundId: 7, txHash: "0xfdc" };
      },
      isAlreadyVerified: async () => false,
    });

    const { default: app } = await import("../src/app.js");
    server = await new Promise<http.Server>((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1");
      s.once("error", reject);
      s.once("listening", () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("test server did not bind");
    port = addr.port;
  });

  after(async () => {
    attest.setFdcMocksForTests(null);
    x402.resetX402ForTests();
    xrpl.setXrplLookupForTests(null);
    price.resetPriceServiceForTests();
    if (!server) return;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    process.env.X402_ENABLED = "true";
    process.env.X402_PAY_TO_ADDRESS = payTo;
    process.env.FLARE_NETWORK = "flare";
    fdcSubmitCount = 0;
    xrplMode = "match";
    price.resetPriceServiceForTests();
    price.setMockPrices(0.007, 2);
    price.setOnChainFeeFailureForTests(true);
  });

  async function usageFor(key: string): Promise<number> {
    const rec = await store.getApiKey(key);
    assert.ok(rec);
    const period = getFallbackBillingPeriod(rec.createdAt);
    return store.getAttestationUsage(key, getBillingPeriodKey(period));
  }

  it("50 parallel Paid verifies submit at most quota-remaining FDC requests", async () => {
    const paid = await store.createApiKey("parallel-paid", "paid");
    const limit = ATTESTATION_LIMITS.paid;
    assert.ok(limit > 0 && limit < 50);
    const hashes = Array.from({ length: 50 }, (_, i) => generateTestTxHash(`p${i}`));
    const results = await Promise.all(
      hashes.map((txHash) =>
        request(port, "POST", "/api/v1/verify/xrp-payment", {
          body: { txHash },
          headers: { "X-API-Key": paid.key },
        })
      )
    );
    const accepted = results.filter((r) => r.status === 202);
    const limited = results.filter((r) => r.status === 402 || r.status === 429);
    assert.equal(accepted.length, limit, `accepted=${accepted.length} ${results[0]?.body && JSON.stringify(results.find((r) => r.status !== 202 && r.status !== 402)?.body)}`);
    assert.ok(limited.length >= 50 - limit);
    assert.ok(fdcSubmitCount <= limit, `FDC submits ${fdcSubmitCount} > limit ${limit}`);
    assert.equal(await usageFor(paid.key), limit);
  });

  it("releases a reservation when preflight returns TX_TOO_OLD", async () => {
    const paid = await store.createApiKey("too-old-key", "paid");
    const before = await usageFor(paid.key);
    attest.setFdcMocksForTests(null);
    xrpl.setXrplNowForTests(() => Date.now());
    xrpl.setXrplLookupForTests(async () => ({
      status: "found",
      tx: {
        Account: "rFrom",
        Destination: payTo,
        Amount: "1000000",
        TransactionType: "Payment",
        date: Math.floor(Date.now() / 1000) - 946684800 - 20 * 86400,
        validated: true,
      },
    }));
    const res = await request(port, "POST", "/api/v1/verify/xrp-payment", {
      body: { txHash: generateTestTxHash("OLDQ") },
      headers: { "X-API-Key": paid.key },
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "TX_TOO_OLD");
    assert.equal(await usageFor(paid.key), before);

    attest.setFdcMocksForTests({
      prepareRequest: async () => "0xencoded",
      submitRequest: async () => {
        fdcSubmitCount += 1;
        return { roundId: 7, txHash: "0xfdc" };
      },
      isAlreadyVerified: async () => false,
    });
    xrpl.setXrplNowForTests(null);
    installSettlementLookup();
  });

  it("replays a PAYMENT-SIGNATURE after restart as 409", async () => {
    const txHash = generateTestTxHash("RESTART");
    const quote = await request(port, "POST", "/api/v1/verify/xrp-payment", { body: { txHash } });
    assert.equal(quote.status, 402, JSON.stringify(quote.body));
    const invoiceId = quote.body.paymentRequired.accepts[0].extra.invoiceId;
    const sig = encodePayment(invoiceId);
    const first = await request(port, "POST", "/api/v1/verify/xrp-payment", {
      body: { txHash },
      headers: { "PAYMENT-SIGNATURE": sig },
    });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const att = await store.getByTxHash(txHash);
    assert.ok(att);
    await store.updateAttestation(att.id, { status: "failed", error: "cleared for replay test" });

    x402.reloadX402StateFromDiskForTests();
    const replay = await request(port, "POST", "/api/v1/verify/xrp-payment", {
      body: { txHash },
      headers: { "PAYMENT-SIGNATURE": sig },
    });
    assert.equal(replay.status, 409, JSON.stringify(replay.body));
    assert.equal(replay.body.error, "PAYMENT_REPLAY");
    assert.equal(fdcSubmitCount, 1);
  });

  it("rejects a partial-payment settlement as 402", async () => {
    xrplMode = "partial";
    const txHash = generateTestTxHash("PART");
    const quote = await request(port, "POST", "/api/v1/verify/xrp-payment", { body: { txHash } });
    const invoiceId = quote.body.paymentRequired.accepts[0].extra.invoiceId;
    const paid = await request(port, "POST", "/api/v1/verify/xrp-payment", {
      body: { txHash },
      headers: { "PAYMENT-SIGNATURE": encodePayment(invoiceId) },
    });
    assert.equal(paid.status, 402, JSON.stringify(paid.body));
    assert.equal(paid.body.error, "PAYMENT_FAILED");
    assert.match(String(paid.body.message), /partial/i);
    assert.equal(fdcSubmitCount, 0);
  });

  it("rejects a wrong destination settlement as 402", async () => {
    xrplMode = "wrong-dest";
    const txHash = generateTestTxHash("WDEST");
    const quote = await request(port, "POST", "/api/v1/verify/xrp-payment", { body: { txHash } });
    const invoiceId = quote.body.paymentRequired.accepts[0].extra.invoiceId;
    const paid = await request(port, "POST", "/api/v1/verify/xrp-payment", {
      body: { txHash },
      headers: { "PAYMENT-SIGNATURE": encodePayment(invoiceId) },
    });
    assert.equal(paid.status, 402, JSON.stringify(paid.body));
    assert.equal(paid.body.error, "PAYMENT_FAILED");
    assert.match(String(paid.body.message), /destination/i);
    assert.equal(fdcSubmitCount, 0);
  });

  it("does not fall back to accepts[0] when the payload asset is unknown", async () => {
    const txHash = generateTestTxHash("NOFB");
    const { paymentRequired } = await x402.buildPaymentRequired(txHash);
    const invoiceId = paymentRequired.accepts[0].extra.invoiceId;
    const sig = encodePayment(invoiceId, "USD");
    const result = await x402.processX402Payment(sig, txHash);
    assert.equal(result.outcome, "failed");
    if (result.outcome === "failed") {
      assert.match(result.error, /not accepted/i);
    }
  });
});
