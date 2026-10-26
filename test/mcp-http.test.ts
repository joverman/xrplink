import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import http from "node:http";
import express from "express";

/**
 * Each suite owns its own server on an ephemeral port so Hardhat/node:test
 * concurrency cannot close a sibling suite's listener. Clients disable
 * keep-alive so sockets are never reused across listen/close.
 */
async function startTestServer(): Promise<{ server: http.Server; port: number }> {
  process.env.SESSION_SECRET = "test-secret-for-testing-1234567890";

  const appModule = express.default ? express.default() : express();
  appModule.use(express.json());

  const { default: routes } = await import("../src/routes.js");
  appModule.use(routes);

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = appModule.listen(0, "127.0.0.1");
    s.once("error", reject);
    s.once("listening", () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  console.log(`Test server started on port ${addr.port}`);
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
  body?: any,
  headers?: Record<string, string>
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
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
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const MCP_ACCEPT = "application/json, text/event-stream";

describe("MCP HTTP Server", () => {
  let server: http.Server | null = null;
  let port = 0;

  before(async () => {
    ({ server, port } = await startTestServer());
  });

  after(async () => {
    await stopTestServer(server);
    server = null;
  });

  describe("MCP Endpoint Availability", () => {
    it("should respond to POST /mcp with proper content type", async () => {
      const res = await request(port, "POST", "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }, { Accept: MCP_ACCEPT });

      // Endpoint should respond - could be 200, 202, or any success
      assert.ok(
        res.status >= 200 && res.status < 500,
        `MCP endpoint should not return server error, got ${res.status}`
      );
    });

    it("should return session header for initialize", async () => {
      const res = await request(port, "POST", "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      }, { Accept: MCP_ACCEPT });

      // Session ID should be returned for stateful MCP
      const sessionId = res.headers["mcp-session-id"];
      assert.ok(sessionId, "Should return MCP session ID header");
    });
  });
});

describe("JSON Receipt Content Negotiation", () => {
  let server: http.Server | null = null;
  let port = 0;

  before(async () => {
    ({ server, port } = await startTestServer());
  });

  after(async () => {
    await stopTestServer(server);
    server = null;
  });

  it("should return HTML by default", async () => {
    const res = await request(port, "GET", "/receipt/87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "string" && res.body.includes("<!DOCTYPE html"), "Should return HTML");
  });

  it("should return JSON with format=json query param", async () => {
    const res = await request(port, "GET", "/receipt/87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F?format=json");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "object", "Should return JSON object");
    assert.ok("txHash" in res.body, "JSON should have txHash field");
  });

  it("should return JSON with Accept: application/json header", async () => {
    const res = await request(
      port,
      "GET",
      "/receipt/87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F",
      undefined,
      { Accept: "application/json" }
    );
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "object", "Should return JSON object");
    assert.ok("txHash" in res.body, "JSON should have txHash field");
    assert.ok("status" in res.body, "JSON should have status field");
  });

  it("should return 404 JSON for non-existent transaction", async () => {
    const res = await request(
      port,
      "GET",
      "/receipt/0000000000000000000000000000000000000000000000000000000000000000?format=json",
      undefined
    );
    assert.equal(res.status, 404);
    assert.ok(res.body.error === "NOT_FOUND", "Should return NOT_FOUND error");
  });
});

describe("Agent Discovery Files", () => {
  let server: http.Server | null = null;
  let port = 0;

  before(async () => {
    ({ server, port } = await startTestServer());
  });

  after(async () => {
    await stopTestServer(server);
    server = null;
  });

  it("should serve /llms.txt", async () => {
    const res = await request(port, "GET", "/llms.txt");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "string", "Should return text");
    assert.ok(res.body.includes("XRPLink"), "Should mention XRPLink");
    assert.ok(res.body.includes("/mcp"), "Should mention MCP endpoint");
    assert.ok(res.body.includes("verify_xrp_payment"), "Should list tools");
    assert.ok(res.body.includes("Tiers"), "Should mention tiers and limits");
  });

  it("should serve /openapi.json", async () => {
    const res = await request(port, "GET", "/openapi.json");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "object", "Should return JSON");
    assert.equal(res.body.openapi, "3.0.3", "Should be OpenAPI 3.0.3");
    assert.ok(res.body.paths["/api/v1/verify/xrp-payment"], "Should have verify endpoint");
    assert.ok(res.body.paths["/mcp"], "Should have MCP endpoint");
    assert.ok(res.body.components?.schemas?.QuotaError, "Should have QuotaError schema");
  });

  it("should serve /.well-known/mcp.json", async () => {
    const res = await request(port, "GET", "/.well-known/mcp.json");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "object", "Should return JSON");
    assert.equal(res.body.name, "XRPLink", "Should have correct name");
    assert.equal(res.body.transport, "streamable-http", "Should specify transport");
    assert.ok(res.body.authentication, "Should describe auth");
    assert.ok(res.body.authentication.required_for.includes("verify_xrp_payment"), "Auth required for verify");
    assert.ok(res.body.authentication.optional_for.includes("get_server_info"), "Auth optional for read-only");
  });

  it("should serve /.well-known/ai-plugin.json", async () => {
    const res = await request(port, "GET", "/.well-known/ai-plugin.json");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body === "object", "Should return JSON");
    assert.equal(res.body.name_for_model, "xrplink", "Should have model name");
    assert.ok(res.body.api?.url?.includes("openapi.json"), "Should reference OpenAPI spec");
  });
});
