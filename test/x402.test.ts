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

process.env.PORT = "3459";
process.env.SESSION_SECRET = "test-secret-for-testing-1234567890";
process.env.FLARE_NETWORK = "flare";
process.env.X402_ENABLED = "true";
process.env.X402_PAY_TO_ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
process.env.X402_FLOOR_USD = "0.50";
process.env.X402_MARKUP = "3";
process.env.ATTESTATION_FEE_FLR = "20";
process.env.X402_RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

const PORT = 3459;
let server: http.Server | null = null;
let storeModule: typeof import("../src/store.js");
let priceModule: typeof import("../src/price-service.js");
let x402Module: typeof import("../src/x402-service.js");
let attestModule: typeof import("../src/attest.js");

const TEST_PAY_TO = process.env.X402_PAY_TO_ADDRESS!;

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
    // 20 FLR × $0.007 = $0.14 × 3 = $0.42 → floor $0.50 (mid-Oct 2026 FLR cost)
    const p = calculateAttestationPrice({
      flrUsd: 0.007,
      xrpUsd: 2,
      feeFlr: 20,
      markup: 3,
      floorUsd: 0.5,
    });
    assert.equal(p.usd, 0.5);
    assert.equal(p.floorApplied, true);
    assert.equal(p.xrpDrops, "250000");
    assert.equal(p.rlusd, "0.5");
  });

  it("uses marked-up cost when it exceeds the floor", async () => {
    const { calculateAttestationPrice } = await import("../src/price-service.js");
    const p = calculateAttestationPrice({
      flrUsd: 0.2,
      xrpUsd: 2,
      feeFlr: 20,
      markup: 3,
      floorUsd: 0.5,
    });
    assert.equal(p.usd, 12);
    assert.equal(p.floorApplied, false);
    assert.equal(p.xrpDrops, "6000000");
  });

  it("fails closed on non-positive feed values", async () => {
    const { calculateAttestationPrice } = await import("../src/price-service.js");
    assert.throws(() =>
      calculateAttestationPrice({ flrUsd: 0, xrpUsd: 2, feeFlr: 20, markup: 3, floorUsd: 0.5 })
    );
  });
});

describe("x402 REST and MCP", () => {
  const facilitatorCalls: Array<{ path: string }> = [];
  let fdcSubmitCount = 0;
  let failVerify = false;
  let failFdc = false;

  before(async () => {
    priceModule = await import("../src/price-service.js");
    x402Module = await import("../src/x402-service.js");
    attestModule = await import("../src/attest.js");
    storeModule = await import("../src/store.js");

    priceModule.setMockPrices(0.007, 2);

    x402Module.setFacilitatorMockForTests(async (path) => {
      facilitatorCalls.push({ path });
      if (path === "/verify") {
        if (failVerify) {
          return { ok: true, status: 200, json: { isValid: false, invalidReason: "bad signature" } };
        }
        return { ok: true, status: 200, json: { isValid: true } };
      }
      return {
        ok: true,
        status: 200,
        json: { success: true, transaction: "TESTSETTLETX", network: "xrpl:0", payer: "rPayerTest" },
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
  });

  beforeEach(() => {
    facilitatorCalls.length = 0;
    fdcSubmitCount = 0;
    failVerify = false;
    failFdc = false;
    priceModule.setMockPrices(0.007, 2);
  });

  it("returns a spec-shaped 402 when no API key is provided", async () => {
    const txHash = generateTestTxHash("NOKEY");
    const res = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    assert.equal(res.status, 402);
    assert.equal(res.body.code, "PAYMENT_REQUIRED");
    assert.ok(res.headers["payment-required"], "PAYMENT-REQUIRED header");
    const pr = res.body.paymentRequired;
    assert.equal(pr.x402Version, 2);
    assert.ok(Array.isArray(pr.accepts) && pr.accepts.length >= 1);
    const xrp = pr.accepts.find((a: any) => a.asset === "XRP");
    assert.ok(xrp);
    assert.equal(xrp.scheme, "exact");
    assert.equal(xrp.network, "xrpl:0");
    assert.equal(xrp.payTo, TEST_PAY_TO);
    assert.equal(xrp.amount, "250000");
    assert.equal(xrp.extra.areFeesSponsored, false);
    assert.ok(xrp.extra.invoiceId);
    assert.equal(res.body.priceUsd, 0.5);
    const after = await storeModule.store.getByTxHash(txHash);
    assert.equal(after, undefined);
    assert.equal(fdcSubmitCount, 0);
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
    // Cached attestation (same txHash) is returned without a second FDC submit
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

  it("fails closed when the price feed is down", async () => {
    priceModule.setPriceFeedFailureForTests(true);
    priceModule.clearPriceCache();
    const txHash = generateTestTxHash("NOPRICE");
    const res = await request("POST", "/api/v1/verify/xrp-payment", { txHash });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "PRICE_UNAVAILABLE");
    assert.equal(fdcSubmitCount, 0);
    priceModule.setMockPrices(0.007, 2);
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
