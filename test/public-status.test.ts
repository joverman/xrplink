import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import http from "node:http";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESSION_SECRET = "test-secret-for-testing-1234567890";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "xrplink-public-status-"));

const LEAK_PATTERNS = [
  /wallet\s*balance/i,
  /walletBalance/i,
  /walletAddress/i,
  /apiKeyCount/i,
  /api keys/i,
  /attestationCount/i,
  /attestations\s*\|/i,
  /uptime/i,
  /"storage"\s*:/,
  /PRIVATE_KEY/,
  /VERIFIER_API_KEY/,
  /DATABASE_URL/,
  /data\//,
];

const PUBLIC_STATUS_KEYS = ["status", "network", "chainId", "brand", "attestationsAvailable"];

async function startTestServer(): Promise<{ server: http.Server; port: number }> {
  const app = express.default ? express.default() : express();
  app.use(express.json());
  const { default: routes } = await import("../src/routes.js");
  app.use(routes);

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1");
    s.once("error", reject);
    s.once("listening", () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return { server, port: addr.port };
}

async function stopTestServer(server: http.Server | null): Promise<void> {
  if (!server) return;
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function request(
  port: number,
  method: string,
  path: string,
  headers?: Record<string, string>
): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        agent: new http.Agent({ keepAlive: false }),
        headers: {
          "Content-Type": "application/json",
          Connection: "close",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({ status: res.statusCode!, body, raw: data });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function assertNoOperationalLeaks(payload: unknown, label: string) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const pattern of LEAK_PATTERNS) {
    assert.equal(pattern.test(text), false, `${label} leaked ${pattern}: ${text.slice(0, 400)}`);
  }
}

describe("Public status surfaces hide operational details", () => {
  let server: http.Server | null = null;
  let port = 0;

  before(async () => {
    ({ server, port } = await startTestServer());
  });

  after(async () => {
    await stopTestServer(server);
    server = null;
  });

  it("GET /health returns only agent-safe fields", async () => {
    const res = await request(port, "GET", "/health");
    assert.ok(res.status === 200 || res.status === 503, `unexpected ${res.status}`);
    assert.equal(typeof res.body, "object");
    assert.deepEqual(Object.keys(res.body).sort(), [...PUBLIC_STATUS_KEYS].sort());
    assert.ok(res.body.status === "online" || res.body.status === "degraded");
    assert.equal(typeof res.body.network, "string");
    assert.equal(typeof res.body.chainId, "number");
    assert.equal(typeof res.body.brand, "string");
    assert.equal(typeof res.body.attestationsAvailable, "boolean");
    assertNoOperationalLeaks(res.body, "GET /health");
  });

  it("GET /mcp/resources public status and config omit balances, counts, uptime, and secret env names", async () => {
    const res = await request(port, "GET", "/mcp/resources");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));

    const status = res.body.find((r: { uri: string }) => r.uri === "xrplink://network/status");
    assert.ok(status, "network/status resource missing");
    assert.ok(String(status.content).includes("Attestations available"));
    assertNoOperationalLeaks(status.content, "xrplink://network/status");

    const configDoc = res.body.find((r: { uri: string }) => r.uri === "xrplink://docs/config");
    assert.ok(configDoc, "docs/config resource missing");
    assertNoOperationalLeaks(configDoc.content, "xrplink://docs/config");

    const networkDoc = res.body.find((r: { uri: string }) => r.uri === "xrplink://docs/network");
    assert.ok(networkDoc, "docs/network resource missing");
    assertNoOperationalLeaks(networkDoc.content, "xrplink://docs/network");

    assertNoOperationalLeaks(res.body, "GET /mcp/resources");
  });

  it("get_server_info omits balance, key count, attestation count, and uptime", async () => {
    const { handleGetServerInfo } = await import("../src/mcp/tools.js");
    const result = await handleGetServerInfo();
    const text = result.content[0].text;
    const info = JSON.parse(text);
    assert.ok(info.status === "online" || info.status === "degraded");
    assert.equal(typeof info.attestationsAvailable, "boolean");
    assert.equal("uptime" in info, false);
    assert.equal("attestationCount" in info, false);
    assert.equal("apiKeyCount" in info, false);
    assert.equal("walletBalanceFlr" in info, false);
    assert.equal("rpc" in info, false);
    assertNoOperationalLeaks(info, "get_server_info");
  });

  it("GET /llms.txt and /openapi.json do not publish operational internals", async () => {
    const llms = await request(port, "GET", "/llms.txt");
    assert.equal(llms.status, 200);
    assert.ok(llms.raw.includes("attestationsAvailable") || llms.raw.includes("attestations available"));
    assert.equal(/PRIVATE_KEY|VERIFIER_API_KEY|DATABASE_URL/.test(llms.raw), false);

    const spec = await request(port, "GET", "/openapi.json");
    assert.equal(spec.status, 200);
    assert.ok(spec.body.paths["/api/v1/admin/status"]);
    assert.ok(spec.body.components.schemas.PublicStatus);
    assertNoOperationalLeaks(spec.body.paths["/health"], "openapi /health");
  });

  it("error catalog does not mention storage paths or operator wallet balance", async () => {
    const { formatError } = await import("../src/mcp/errors.js");
    const notFound = JSON.stringify(formatError("NOT_FOUND"));
    const submitFailed = JSON.stringify(formatError("SUBMIT_FAILED"));
    assert.equal(/data\//.test(notFound), false);
    assert.equal(/wallet/i.test(submitFailed), false);
  });
});

describe("GET /api/v1/admin/status requires a pro key", () => {
  let server: http.Server | null = null;
  let port = 0;

  before(async () => {
    ({ server, port } = await startTestServer());
  });

  after(async () => {
    await stopTestServer(server);
    server = null;
  });

  it("rejects missing, paid, and accepts pro keys with operational fields", async () => {
    const { store } = await import("../src/store.js");
    const paid = await store.createApiKey("status-paid", "paid");
    const pro = await store.createApiKey("status-pro", "pro");

    const unauth = await request(port, "GET", "/api/v1/admin/status");
    assert.equal(unauth.status, 401);

    const forbidden = await request(port, "GET", "/api/v1/admin/status", { "X-API-Key": paid.key });
    assert.equal(forbidden.status, 403);

    const ok = await request(port, "GET", "/api/v1/admin/status", { "X-API-Key": pro.key });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.status === "online" || ok.body.status === "degraded");
    assert.ok("walletBalanceFlr" in ok.body);
    assert.equal(typeof ok.body.attestationCount, "number");
    assert.equal(typeof ok.body.apiKeyCount, "number");
    assert.equal(typeof ok.body.uptime, "number");
    assert.ok(ok.body.storage);
    assert.ok(typeof ok.body.storage.ok === "boolean");
    assert.ok(ok.body.storage.type === "json" || ok.body.storage.type === "postgres");
  });
});
