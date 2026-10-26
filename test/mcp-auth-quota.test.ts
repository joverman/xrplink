/**
 * Safety-critical tests for MCP verify_xrp_payment authentication and quota enforcement.
 * 
 * These tests verify that:
 * 1. Missing/invalid API keys are rejected BEFORE any FDC call
 * 2. Free-tier keys (limit=0) are rejected BEFORE any FDC call
 * 3. Paid keys over quota are rejected BEFORE any FDC call
 * 
 * Verification approach: If FDC was called, an attestation record would be created
 * in the store. We verify no attestation is created for our test txHash.
 */
import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import http from "node:http";
import express from "express";

const PORT = 3458;
let server: http.Server | null = null;
let storeModule: typeof import("../src/store.js");

async function startTestServer() {
  if (server) return;
  
  process.env.PORT = String(PORT);
  process.env.SESSION_SECRET = "test-secret-for-testing-1234567890";
  process.env.FLARE_NETWORK = "flare"; // Mainnet to enable quota checks
  
  storeModule = await import("../src/store.js");
  
  const appModule = express.default ? express.default() : express();
  appModule.use(express.json());
  
  const { default: routes } = await import("../src/routes.js");
  appModule.use(routes);
  
  return new Promise<void>((resolve, reject) => {
    server = appModule.listen(PORT, "127.0.0.1", () => {
      console.log(`Test server started on port ${PORT}`);
      resolve();
    });
    server.on("error", reject);
  });
}

async function stopTestServer() {
  return new Promise<void>((resolve) => {
    if (server) {
      server.close(() => {
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function parseSseResponse(data: string): any {
  // SSE format: "event: message\ndata: {...json...}\n\n"
  const lines = data.split("\n");
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        // Not JSON, continue
      }
    }
  }
  // Fall back to trying to parse the whole thing as JSON
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
    const finalHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...headers,
    };
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: finalHeaders,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const body = parseSseResponse(data);
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function mcpToolCall(
  toolName: string,
  args: Record<string, unknown>,
  apiKey?: string
): Promise<{ status: number; result: any; sessionId?: string }> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  
  // Initialize session
  const initRes = await request("POST", "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  }, headers);
  
  const sessionId = initRes.headers["mcp-session-id"] as string | undefined;
  
  // Call tool
  const toolRes = await request("POST", "/mcp", {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  }, {
    ...headers,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });
  
  return {
    status: toolRes.status,
    result: toolRes.body.result || toolRes.body,
    sessionId,
  };
}

// Generate unique test txHash for each test to avoid interference
// Prefix is converted to hex-like string to ensure valid hash format
function generateTestTxHash(suffix: string): string {
  // Use timestamp + random to create unique hex-only hash
  const timestamp = Date.now().toString(16).toUpperCase();
  const random = Math.random().toString(16).slice(2).toUpperCase();
  const suffixHex = Buffer.from(suffix).toString("hex").toUpperCase();
  return (timestamp + random + suffixHex).padEnd(64, "0").slice(0, 64);
}

describe("MCP verify_xrp_payment Safety-Critical Auth/Quota Tests", () => {
  let testFreeKey: string;
  let testPaidKey: string;
  let testPaidKeyOverQuota: string;
  
  before(async () => {
    await startTestServer();
    
    // Create test API keys with specific tiers
    const { store } = storeModule;
    
    // Free tier key (limit = 0)
    const freeKey = await store.createApiKey("test-free-tier", "free");
    testFreeKey = freeKey.key;
    
    // Paid tier key (default limit = 20, fresh)
    const paidKey = await store.createApiKey("test-paid-tier", "paid");
    testPaidKey = paidKey.key;
    
    // Paid tier key that's already at quota
    const paidKeyOverQuota = await store.createApiKey("test-paid-over-quota", "paid");
    testPaidKeyOverQuota = paidKeyOverQuota.key;
    
    const { getFallbackBillingPeriod, getBillingPeriodKey, ATTESTATION_LIMITS } = await import("../src/attestation-quota.js");
    const period = getFallbackBillingPeriod(new Date().toISOString());
    const periodKey = getBillingPeriodKey(period);
    
    for (let i = 0; i < ATTESTATION_LIMITS.paid; i++) {
      await store.incrementAttestationUsage(testPaidKeyOverQuota, periodKey);
    }
    
    console.log(`Test keys created: free=${testFreeKey.slice(0, 20)}..., paid=${testPaidKey.slice(0, 20)}..., overQuota=${testPaidKeyOverQuota.slice(0, 20)}...`);
  });
  
  after(async () => {
    await stopTestServer();
  });
  
  describe("Missing API Key", () => {
    it("should reject verify_xrp_payment without API key and NOT create attestation", async () => {
      const testTxHash = generateTestTxHash("NOKEY");
      const { store } = storeModule;
      
      // Verify no attestation exists before
      const before = await store.getByTxHash(testTxHash);
      assert.equal(before, undefined, "Should have no attestation before test");
      
      const { status, result } = await mcpToolCall(
        "verify_xrp_payment",
        { txHash: testTxHash }
        // No API key
      );
      
      assert.equal(status, 200, "HTTP status should be 200 (JSON-RPC error is in result)");
      assert.ok(result?.isError, "Result should be an error");
      
      const text = result?.content?.[0]?.text || "";
      assert.ok(
        text.toLowerCase().includes("api key"),
        `Error should mention API key requirement: ${text.slice(0, 200)}`
      );
      
      // CRITICAL: Verify no attestation was created (meaning FDC was never called)
      const after = await store.getByTxHash(testTxHash);
      assert.equal(
        after,
        undefined,
        "No attestation should be created when API key is missing - this proves FDC was not called"
      );
    });
  });
  
  describe("Invalid API Key", () => {
    it("should reject verify_xrp_payment with non-existent API key and NOT create attestation", async () => {
      const testTxHash = generateTestTxHash("BADKEY");
      const { store } = storeModule;
      
      const before = await store.getByTxHash(testTxHash);
      assert.equal(before, undefined, "Should have no attestation before test");
      
      const { status, result } = await mcpToolCall(
        "verify_xrp_payment",
        { txHash: testTxHash },
        "sk_live_invalid_nonexistent_key_12345"
      );
      
      assert.equal(status, 200, "HTTP status should be 200 (JSON-RPC error is in result)");
      assert.ok(result?.isError, "Result should be an error");
      
      const text = result?.content?.[0]?.text || "";
      assert.ok(
        text.toLowerCase().includes("api key"),
        `Error should mention API key: ${text.slice(0, 200)}`
      );
      
      // CRITICAL: Verify no attestation was created
      const after = await store.getByTxHash(testTxHash);
      assert.equal(
        after,
        undefined,
        "No attestation should be created with invalid API key - this proves FDC was not called"
      );
    });
  });
  
  describe("Free Tier Key (Limit = 0)", () => {
    it("should reject verify_xrp_payment with free-tier key and NOT create attestation", async () => {
      const testTxHash = generateTestTxHash("FREE");
      const { store } = storeModule;
      
      const before = await store.getByTxHash(testTxHash);
      assert.equal(before, undefined, "Should have no attestation before test");
      
      const { status, result } = await mcpToolCall(
        "verify_xrp_payment",
        { txHash: testTxHash },
        testFreeKey
      );
      
      assert.equal(status, 200, "HTTP status should be 200 (JSON-RPC error is in result)");
      assert.ok(result?.isError, "Result should be an error");
      
      const text = result?.content?.[0]?.text || "";
      assert.ok(
        text.includes("QUOTA_EXCEEDED") || text.toLowerCase().includes("limit"),
        `Error should mention quota/limit: ${text.slice(0, 300)}`
      );
      
      // Verify error includes upgrade info
      assert.ok(
        text.toLowerCase().includes("upgrade") || text.toLowerCase().includes("free"),
        `Error should mention upgrade path or free tier: ${text.slice(0, 300)}`
      );
      
      // CRITICAL: Verify no attestation was created
      const after = await store.getByTxHash(testTxHash);
      assert.equal(
        after,
        undefined,
        "No attestation should be created for free tier - this proves FDC was not called and no FLR spent"
      );
    });
  });
  
  describe("Paid Key Over Quota", () => {
    it("should reject verify_xrp_payment when paid key is at quota limit and NOT create attestation", async () => {
      const testTxHash = generateTestTxHash("OVERQUOTA");
      const { store } = storeModule;
      
      const before = await store.getByTxHash(testTxHash);
      assert.equal(before, undefined, "Should have no attestation before test");
      
      const { status, result } = await mcpToolCall(
        "verify_xrp_payment",
        { txHash: testTxHash },
        testPaidKeyOverQuota
      );
      
      assert.equal(status, 200, "HTTP status should be 200 (JSON-RPC error is in result)");
      assert.ok(result?.isError, "Result should be an error");
      
      const text = result?.content?.[0]?.text || "";
      assert.ok(
        text.includes("QUOTA_EXCEEDED"),
        `Error should include QUOTA_EXCEEDED code: ${text.slice(0, 300)}`
      );
      
      // Verify error includes limit and usage info
      assert.ok(
        text.includes("Limit:") && text.includes("Used:"),
        `Error should show limit and used counts: ${text.slice(0, 300)}`
      );
      
      // Verify error includes reset date
      assert.ok(
        text.includes("Reset:"),
        `Error should show reset date: ${text.slice(0, 300)}`
      );
      
      // CRITICAL: Verify no attestation was created
      const after = await store.getByTxHash(testTxHash);
      assert.equal(
        after,
        undefined,
        "No attestation should be created when over quota - this proves FDC was not called and no FLR spent"
      );
    });
    
    it("should include upgrade suggestion in quota error", async () => {
      const testTxHash = generateTestTxHash("UPGRADE");
      
      const { result } = await mcpToolCall(
        "verify_xrp_payment",
        { txHash: testTxHash },
        testPaidKeyOverQuota
      );
      
      const text = result?.content?.[0]?.text || "";
      assert.ok(
        text.toLowerCase().includes("pro") || text.toLowerCase().includes("upgrade"),
        `Error should suggest upgrading to Pro: ${text.slice(0, 300)}`
      );
    });
  });
  
  describe("Read-Only Tools Should Work Without Auth", () => {
    it("should allow get_server_info without API key", async () => {
      const { status, result } = await mcpToolCall(
        "get_server_info",
        {}
        // No API key
      );
      
      assert.equal(status, 200);
      assert.ok(!result?.isError, "get_server_info should succeed without API key");
      
      const text = result?.content?.[0]?.text || "";
      assert.ok(
        text.includes("network") || text.includes("brand"),
        `Should return server info: ${text.slice(0, 100)}`
      );
    });
    
    it("should allow get_attestation_status without API key", async () => {
      const { status, result } = await mcpToolCall(
        "get_attestation_status",
        { id: "00000000-0000-0000-0000-000000000000" }
        // No API key
      );
      
      assert.equal(status, 200);
      // This may return "not found" error, but that's expected for non-existent ID
      // The key point is it doesn't require auth
      const text = result?.content?.[0]?.text || "";
      assert.ok(
        !text.toLowerCase().includes("api key required"),
        "Should not require API key for read-only tool"
      );
    });
    
    it("should allow lookup_attestation_by_tx without API key", async () => {
      const { status, result } = await mcpToolCall(
        "lookup_attestation_by_tx",
        { txHash: "0000000000000000000000000000000000000000000000000000000000000000" }
        // No API key
      );
      
      assert.equal(status, 200);
      const text = result?.content?.[0]?.text || "";
      assert.ok(
        !text.toLowerCase().includes("api key required"),
        "Should not require API key for read-only tool"
      );
    });
  });
});
