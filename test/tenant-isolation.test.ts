/**
 * PR 1 tenant isolation: webhooks bound to owning key, SSRF, MCP ALS,
 * public status subset, health liveness, MCP resources metadata-only.
 */
import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32-chars-min!!";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.FLARE_NETWORK = "flare";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "xrplink-tenant-"));
process.env.X402_ENABLED = "false";
delete process.env.X402_PAY_TO_ADDRESS;
delete process.env.DATABASE_URL;
delete process.env.ADMIN_API_KEY;

function generateTestTxHash(suffix: string): string {
  const timestamp = Date.now().toString(16).toUpperCase();
  const random = Math.random().toString(16).slice(2).toUpperCase();
  const suffixHex = Buffer.from(suffix).toString("hex").toUpperCase();
  return (timestamp + random + suffixHex).padEnd(64, "0").slice(0, 64);
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { body?: any; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    const headers: Record<string, string> = {
      Connection: "close",
      ...opts.headers,
    };
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
          resolve({ status: res.statusCode!, body, headers: res.headers, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function parseSseOrJson(data: any): any {
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  const text = String(data);
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        /* continue */
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return data;
  }
}

const MCP_ACCEPT = "application/json, text/event-stream";

const SAMPLE_PROOF = {
  response: {
    attestationType: "0x",
    sourceId: "0x",
    votingRound: "42",
    lowestUsedTimestamp: "0",
    requestBody: { transactionId: "0x00", proofOwner: "0x00" },
    responseBody: {
      blockNumber: "1",
      blockTimestamp: "1",
      sourceAddress: "rOwner",
      sourceAddressHash: "0x00",
      receivingAddressHash: "0x00",
      intendedReceivingAddressHash: "0x00",
      spentAmount: "1",
      intendedSpentAmount: "1",
      receivedAmount: "1000000",
      intendedReceivedAmount: "1000000",
      hasMemoData: false,
      firstMemoData: "",
      hasDestinationTag: false,
      destinationTag: "0",
      status: "0",
    },
  },
  proof: ["aa".repeat(32), "bb".repeat(32)],
};

describe("Webhook URL SSRF hardening", () => {
  afterEach(async () => {
    const { setWebhookDnsLookupForTests } = await import("../src/webhook-url.js");
    setWebhookDnsLookupForTests(null);
  });

  it("rejects http, loopback, private, decimal, mapped, and metadata hosts", async () => {
    const { assertSafeWebhookUrl, setWebhookDnsLookupForTests } = await import("../src/webhook-url.js");
    setWebhookDnsLookupForTests(async () => ["8.8.8.8"]);

    const blocked = [
      "http://example.com/hook",
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://10.0.0.1/hook",
      "https://192.168.1.8/hook",
      "https://172.16.0.1/hook",
      "https://169.254.169.254/latest",
      "https://2130706433/hook",
      "https://0x7f000001/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://metadata.google.internal/hook",
    ];
    for (const url of blocked) {
      await assert.rejects(() => assertSafeWebhookUrl(url), /Webhook URL/, url);
    }
  });

  it("rejects hosts that resolve to private addresses", async () => {
    const { assertSafeWebhookUrl, setWebhookDnsLookupForTests } = await import("../src/webhook-url.js");
    setWebhookDnsLookupForTests(async () => ["127.0.0.1"]);
    await assert.rejects(() => assertSafeWebhookUrl("https://evil.example/hook"));
  });

  it("allows https on a public resolved address", async () => {
    const { assertSafeWebhookUrl, setWebhookDnsLookupForTests } = await import("../src/webhook-url.js");
    setWebhookDnsLookupForTests(async () => ["8.8.8.8"]);
    await assertSafeWebhookUrl("https://hooks.example/xrp");
  });

  it("rejects non-canonical IPv4 and CGNAT ranges", async () => {
    const { assertSafeWebhookUrl, setWebhookDnsLookupForTests } = await import("../src/webhook-url.js");
    setWebhookDnsLookupForTests(async () => ["8.8.8.8"]);
    for (const url of ["https://127.1/hook", "https://0177.0.0.1/hook", "https://100.64.0.1/hook", "https://198.18.0.1/hook"]) {
      await assert.rejects(() => assertSafeWebhookUrl(url), /Webhook URL/, url);
    }
  });
});

describe("sanitizeWebhookRecord disables global hooks", () => {
  it("marks null attestationId or missing apiKeyId inactive", async () => {
    const { sanitizeWebhookRecord } = await import("../src/store.js");
    const global = sanitizeWebhookRecord({
      id: "w1",
      url: "https://attacker.example/hook",
      attestationId: null,
      createdAt: new Date().toISOString(),
    });
    assert.equal(global.active, false);

    const noKey = sanitizeWebhookRecord({
      id: "w2",
      url: "https://attacker.example/hook",
      attestationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      createdAt: new Date().toISOString(),
    });
    assert.equal(noKey.active, false);

    const ok = sanitizeWebhookRecord({
      id: "w3",
      url: "https://hooks.example/hook",
      attestationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      apiKeyId: "ab".repeat(32),
      createdAt: new Date().toISOString(),
      active: true,
    });
    assert.equal(ok.active, true);
  });
});

describe("Tenant isolation", () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: typeof import("../src/store.js").store;
  let hashApiKey: typeof import("../src/api-keys.js").hashApiKey;
  let deliverWebhooks: typeof import("../src/webhook-service.js").deliverWebhooks;
  let setWebhookDnsLookupForTests: typeof import("../src/webhook-url.js").setWebhookDnsLookupForTests;
  let MAX_WEBHOOKS_PER_KEY: typeof import("../src/store.js").MAX_WEBHOOKS_PER_KEY;
  const origFetch = globalThis.fetch;

  before(async () => {
    const { default: app } = await import("../src/app.js");
    store = (await import("../src/store.js")).store;
    MAX_WEBHOOKS_PER_KEY = (await import("../src/store.js")).MAX_WEBHOOKS_PER_KEY;
    hashApiKey = (await import("../src/api-keys.js")).hashApiKey;
    deliverWebhooks = (await import("../src/webhook-service.js")).deliverWebhooks;
    setWebhookDnsLookupForTests = (await import("../src/webhook-url.js")).setWebhookDnsLookupForTests;

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
    globalThis.fetch = origFetch;
    setWebhookDnsLookupForTests(null);
    if (!server) return;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    setWebhookDnsLookupForTests(null);
  });

  async function mcpToolCall(toolName: string, args: Record<string, unknown>, apiKey?: string) {
    const headers: Record<string, string> = { Accept: MCP_ACCEPT };
    if (apiKey) headers["X-API-Key"] = apiKey;
    const init = await request(port, "POST", "/mcp", {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tenant-test", version: "1.0" },
        },
      },
      headers,
    });
    const sessionId = init.headers["mcp-session-id"] as string | undefined;
    const tool = await request(port, "POST", "/mcp", {
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      },
      headers: {
        ...headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    });
    return { status: tool.status, result: parseSseOrJson(tool.body) };
  }

  it("GET /health is liveness-only", async () => {
    const res = await request(port, "GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(Object.keys(res.body).join(","), "status");
    assert.ok(!("fdcHub" in res.body));
    assert.ok(!("storage" in res.body));
    assert.ok(!("paymentVerifier" in res.body));
  });

  it("GET /mcp/resources lists metadata without bodies or wallet balance", async () => {
    const res = await request(port, "GET", "/mcp/resources");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    for (const item of res.body) {
      assert.ok(item.uri);
      assert.ok(item.name);
      assert.equal(item.content, undefined);
      assert.ok(item.uri !== "xrplink://network/status");
      const blob = JSON.stringify(item).toLowerCase();
      assert.ok(!blob.includes("wallet balance"));
      assert.ok(!blob.includes("flr"));
    }

    const init = await request(port, "POST", "/mcp", {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tenant-test", version: "1.0" },
        },
      },
      headers: { Accept: MCP_ACCEPT },
    });
    const sessionId = init.headers["mcp-session-id"] as string | undefined;
    const listed = await request(port, "POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
      headers: {
        Accept: MCP_ACCEPT,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    });
    const payload = JSON.stringify(parseSseOrJson(listed.body)).toLowerCase();
    assert.ok(!payload.includes("xrplink://network/status"));
    assert.ok(!payload.includes("wallet balance"));
  });

  it("public /receipt/:hash still returns HTML", async () => {
    const hash = generateTestTxHash("receipt");
    await store.createAttestation(hash, "owner-not-used");
    await store.updateAttestation((await store.getByTxHash(hash))!.id, {
      status: "verified",
      proof: SAMPLE_PROOF as any,
    });
    const res = await request(port, "GET", `/receipt/${hash}`);
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "string" && res.body.includes("<!DOCTYPE html"));
    assert.ok(res.body.includes("Verified") || res.body.includes("Receipt"));
  });

  it("rejects webhook register without attestationId, on another key's attestation, and SSRF URLs", async () => {
    const keyA = await store.createApiKey("tenant-A", "paid");
    const keyB = await store.createApiKey("tenant-B", "paid");
    const hashB = generateTestTxHash("ownB");
    const attB = await store.createAttestation(hashB, hashApiKey(keyB.key));

    const missing = await request(port, "POST", "/api/v1/webhooks", {
      body: { url: "https://hooks.example/a" },
      headers: { "X-API-Key": keyA.key },
    });
    assert.equal(missing.status, 400);

    setWebhookDnsLookupForTests(async () => ["8.8.8.8"]);
    const stolen = await request(port, "POST", "/api/v1/webhooks", {
      body: { url: "https://hooks.example/a", attestationId: attB.id },
      headers: { "X-API-Key": keyA.key },
    });
    assert.equal(stolen.status, 404, JSON.stringify(stolen.body));

    const ssrf = await request(port, "POST", "/api/v1/webhooks", {
      body: { url: "http://127.0.0.1/steal", attestationId: attB.id },
      headers: { "X-API-Key": keyB.key },
    });
    assert.equal(ssrf.status, 400);
  });

  it("does not deliver A's webhook when B's attestation completes", async () => {
    const keyA = await store.createApiKey("deliver-A", "paid");
    const keyB = await store.createApiKey("deliver-B", "paid");
    const hashA = generateTestTxHash("delA");
    const hashB = generateTestTxHash("delB");
    const attA = await store.createAttestation(hashA, hashApiKey(keyA.key));
    const attB = await store.createAttestation(hashB, hashApiKey(keyB.key));

    setWebhookDnsLookupForTests(async () => ["8.8.8.8"]);
    const registered = await request(port, "POST", "/api/v1/webhooks", {
      body: { url: "https://hooks.example/a-only", attestationId: attA.id },
      headers: { "X-API-Key": keyA.key },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const delivered: string[] = [];
    globalThis.fetch = (async (input: any) => {
      delivered.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await deliverWebhooks(attB.id);
    assert.equal(delivered.length, 0, `B's attestation must not notify A: ${delivered.join(",")}`);

    await deliverWebhooks(attA.id);
    assert.ok(
      delivered.some((u) => u.includes("hooks.example/a-only")),
      `expected A's hook, got ${delivered.join(",")}`
    );
  });

  it("does not follow webhook redirects", async () => {
    const key = await store.createApiKey("redir-key", "paid");
    const att = await store.createAttestation(generateTestTxHash("redir"), hashApiKey(key.key));
    setWebhookDnsLookupForTests(async () => ["8.8.8.8"]);
    const registered = await request(port, "POST", "/api/v1/webhooks", {
      body: { url: "https://hooks.example/redir", attestationId: att.id },
      headers: { "X-API-Key": key.key },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const fetchCalls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), redirect: init?.redirect });
      return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/steal" } });
    }) as typeof fetch;

    await deliverWebhooks(att.id);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].redirect, "manual");
    assert.ok(!fetchCalls.some((c) => c.url.includes("127.0.0.1")));
  });

  it("caps active webhooks per key", async () => {
    const key = await store.createApiKey("cap-key", "paid");
    const hashed = hashApiKey(key.key);
    setWebhookDnsLookupForTests(async () => ["8.8.8.8"]);
    for (let i = 0; i < MAX_WEBHOOKS_PER_KEY; i++) {
      const att = await store.createAttestation(generateTestTxHash(`cap${i}`), hashed);
      const res = await request(port, "POST", "/api/v1/webhooks", {
        body: { url: `https://hooks.example/c${i}`, attestationId: att.id },
        headers: { "X-API-Key": key.key },
      });
      assert.equal(res.status, 201, `hook ${i}: ${JSON.stringify(res.body)}`);
    }
    const extraAtt = await store.createAttestation(generateTestTxHash("capX"), hashed);
    const extra = await request(port, "POST", "/api/v1/webhooks", {
      body: { url: "https://hooks.example/overflow", attestationId: extraAtt.id },
      headers: { "X-API-Key": key.key },
    });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error, "WEBHOOK_LIMIT");
  });

  it("REST status returns full proof to owner and public subset to another key", async () => {
    const keyA = await store.createApiKey("status-A", "paid");
    const keyB = await store.createApiKey("status-B", "paid");
    const hash = generateTestTxHash("stat");
    const att = await store.createAttestation(hash, hashApiKey(keyA.key));
    await store.updateAttestation(att.id, { status: "ready", proof: SAMPLE_PROOF as any });

    const owner = await request(port, "GET", `/api/v1/status/${att.id}`, {
      headers: { "X-API-Key": keyA.key },
    });
    assert.equal(owner.status, 200);
    assert.ok(Array.isArray(owner.body.proof?.proof), "owner should receive merkle proof array");

    const other = await request(port, "GET", `/api/v1/status/${att.id}`, {
      headers: { "X-API-Key": keyB.key },
    });
    assert.equal(other.status, 200);
    assert.equal(other.body.proof?.merkleProofLength, 2);
    assert.equal(other.body.proof?.proof, undefined);
    assert.equal(other.body.abiEncodedRequest, undefined);

    const byTx = await request(port, "GET", `/api/v1/status-by-tx/${hash}`, {
      headers: { "X-API-Key": keyB.key },
    });
    assert.equal(byTx.status, 200);
    assert.equal(byTx.body.proof?.proof, undefined);
  });

  it("MCP get_attestation_status is public without a key; owning key gets full proof; keys do not mix under concurrency", async () => {
    const keyA = await store.createApiKey("mcp-A", "paid");
    const keyB = await store.createApiKey("mcp-B", "paid");
    const hashA = generateTestTxHash("mcpA");
    const hashB = generateTestTxHash("mcpB");
    const attA = await store.createAttestation(hashA, hashApiKey(keyA.key));
    const attB = await store.createAttestation(hashB, hashApiKey(keyB.key));
    await store.updateAttestation(attA.id, { status: "ready", proof: SAMPLE_PROOF as any });
    await store.updateAttestation(attB.id, { status: "ready", proof: SAMPLE_PROOF as any });

    const anon = await mcpToolCall("get_attestation_status", { id: attA.id });
    assert.equal(anon.status, 200);
    const anonText = JSON.stringify(anon.result);
    assert.ok(!anonText.toLowerCase().includes("api key required"));
    assert.ok(!anonText.includes('"aabbcc"') && !anonText.includes(SAMPLE_PROOF.proof[0]));

    const rounds = 12;
    const jobs: Promise<{ who: string; text: string }>[] = [];
    for (let i = 0; i < rounds; i++) {
      jobs.push(
        mcpToolCall("get_attestation_status", { id: attA.id }, keyA.key).then((r) => ({
          who: "A",
          text: r.result?.content?.[0]?.text || JSON.stringify(r.result),
        }))
      );
      jobs.push(
        mcpToolCall("get_attestation_status", { id: attA.id }, keyB.key).then((r) => ({
          who: "B",
          text: r.result?.content?.[0]?.text || JSON.stringify(r.result),
        }))
      );
    }
    const results = await Promise.all(jobs);
    for (const row of results) {
      if (row.who === "A") {
        assert.ok(row.text.includes(SAMPLE_PROOF.proof[0]), `owner A missing full proof: ${row.text.slice(0, 200)}`);
      } else {
        assert.ok(!row.text.includes(SAMPLE_PROOF.proof[0]), `key B leaked A's merkle path: ${row.text.slice(0, 200)}`);
        assert.ok(row.text.includes("merkleProofLength"), `key B should get public subset: ${row.text.slice(0, 200)}`);
      }
    }
  });

  it("removes get_attestation_by_round from MCP", async () => {
    const listed = await request(port, "POST", "/mcp", {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tenant-test", version: "1.0" },
        },
      },
      headers: { Accept: MCP_ACCEPT },
    });
    const sessionId = listed.headers["mcp-session-id"] as string | undefined;
    const tools = await request(port, "POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      headers: {
        Accept: MCP_ACCEPT,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    });
    const payload = parseSseOrJson(tools.body);
    const names = JSON.stringify(payload);
    assert.ok(!names.includes("get_attestation_by_round"), names.slice(0, 400));

    const call = await mcpToolCall("get_attestation_by_round", { roundId: 1 });
    assert.equal(call.status, 200);
    const text = JSON.stringify(call.result).toLowerCase();
    assert.ok(text.includes("unknown") || call.result?.isError, text.slice(0, 300));
  });
});
