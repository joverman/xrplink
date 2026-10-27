/**
 * Admin lockdown, hashed API keys, session key rotation, and dashboard verify.
 *
 * ADMIN_API_KEY + X-Admin-Key are required for /api/v1/admin/*.
 * Customer keys of any tier never grant admin. Dashboard verify uses the
 * session cookie (same CSRF/same-origin rules as rotation) and counts
 * against monthly attestation quota.
 */
import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_SECRET = "test-admin-lockdown-secret-not-a-customer-key";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32-chars-min!!";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.FLARE_NETWORK = "flare";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "xrplink-admin-"));
process.env.X402_ENABLED = "false";
process.env.ADMIN_API_KEY = ADMIN_SECRET;
delete process.env.X402_PAY_TO_ADDRESS;
delete process.env.DATABASE_URL;

const ROUTES_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/routes.ts");

const ADMIN_ROUTES: { method: string; path: string; body?: Record<string, unknown> }[] = [
  { method: "GET", path: "/api/v1/admin/white-label" },
  { method: "PUT", path: "/api/v1/admin/white-label", body: { companyName: "nope" } },
  { method: "POST", path: "/api/v1/admin/keys", body: { name: "x", tier: "free" } },
  { method: "GET", path: "/api/v1/admin/keys" },
  { method: "GET", path: "/api/v1/admin/x402-margin" },
  { method: "DELETE", path: "/api/v1/admin/keys/sk_live_nonexistent" },
];

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
  opts: { body?: any; headers?: Record<string, string>; cookie?: string } = {}
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    const headers: Record<string, string> = {
      Connection: "close",
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.cookie) headers.Cookie = opts.cookie;
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

function cookiePairs(setCookie: string | string[] | undefined): string[] {
  if (!setCookie) return [];
  return Array.isArray(setCookie) ? setCookie : [setCookie];
}

function sessionCookieHeader(setCookie: string | string[] | undefined): string {
  const line = cookiePairs(setCookie).find((c) => c.startsWith("xrplink_session="));
  if (!line) return "";
  return line.split(";")[0];
}

function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function isMaskedKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^sk_live_[a-f0-9]{32,}$/i.test(value)) return false;
  return value.includes("…") || value.includes("...");
}

describe("Admin auth, key rotation, and dashboard verify", () => {
  let server: http.Server | null = null;
  let port = 0;
  let store: typeof import("../src/store.js").store;
  let userStore: typeof import("../src/user-store.js").userStore;
  let setFdcMocksForTests: typeof import("../src/attest.js").setFdcMocksForTests;
  let getFallbackBillingPeriod: typeof import("../src/attestation-quota.js").getFallbackBillingPeriod;
  let getBillingPeriodKey: typeof import("../src/attestation-quota.js").getBillingPeriodKey;
  const password = "password12";

  before(async () => {
    const { default: app } = await import("../src/app.js");
    const storeMod = await import("../src/store.js");
    const userMod = await import("../src/user-store.js");
    const attestMod = await import("../src/attest.js");
    const quotaMod = await import("../src/attestation-quota.js");
    store = storeMod.store;
    userStore = userMod.userStore;
    setFdcMocksForTests = attestMod.setFdcMocksForTests;
    getFallbackBillingPeriod = quotaMod.getFallbackBillingPeriod;
    getBillingPeriodKey = quotaMod.getBillingPeriodKey;
    const { config } = await import("../src/config.js");
    assert.equal(config.network, "flare", "admin-auth tests require FLARE_NETWORK=flare for quota");

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
    setFdcMocksForTests(null);
    if (!server) return;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
  });

  afterEach(() => {
    setFdcMocksForTests(null);
    process.env.ADMIN_API_KEY = ADMIN_SECRET;
  });

  async function signup(email: string) {
    const res = await request(port, "POST", "/auth/signup", { body: { email, password } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const cookie = sessionCookieHeader(res.headers["set-cookie"]);
    assert.ok(cookie);
    const me = await request(port, "GET", "/me", { cookie });
    assert.equal(me.status, 200);
    return {
      cookie,
      plaintext: res.body.apiKey as string,
      token: res.body.token as string,
      userId: me.body.user.id as string,
      email,
    };
  }

  async function setTier(userId: string, tier: "free" | "paid" | "pro") {
    userStore.update(userId, { tier });
    const user = userStore.findById(userId);
    assert.ok(user);
    if (user.apiKeyIds[0]) await store.updateApiKeyTier(user.apiKeyIds[0], tier);
  }

  it("hashes API keys at rest and still authenticates the plaintext secret", async () => {
    const created = await store.createApiKey("hash-roundtrip", "paid");
    assert.match(created.key, /^sk_live_/);
    const stored = await store.getApiKey(created.key);
    assert.ok(stored);
    assert.notEqual(stored.key, created.key);
    assert.match(stored.key, /^[a-f0-9]{64}$/);
    assert.equal(stored.keyPrefix, created.key.slice(0, 12));
    assert.equal(stored.keyLast4, created.key.slice(-4));
  });

  it("rejects a pro customer key on every admin route", async () => {
    const pro = await store.createApiKey("pro-customer", "pro");
    for (const route of ADMIN_ROUTES) {
      const res = await request(port, route.method, route.path, {
        body: route.body,
        headers: { "X-API-Key": pro.key },
      });
      assert.equal(res.status, 403, `${route.method} ${route.path} => ${res.status} ${JSON.stringify(res.body)}`);
    }
  });

  it("rejects a missing or wrong X-Admin-Key with 403 while ADMIN_API_KEY is set", async () => {
    const missing = await request(port, "GET", "/api/v1/admin/keys");
    assert.equal(missing.status, 403);
    const wrong = await request(port, "GET", "/api/v1/admin/keys", {
      headers: { "X-Admin-Key": "definitely-not-the-admin-secret" },
    });
    assert.equal(wrong.status, 403);
  });

  it("allows a valid ADMIN_API_KEY and never lists full secrets", async () => {
    const created = await request(port, "POST", "/api/v1/admin/keys", {
      body: { name: "ops-key", tier: "paid" },
      headers: { "X-Admin-Key": ADMIN_SECRET },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.key, /^sk_live_/);
    assert.ok(created.body.key.length > 40);

    const listed = await request(port, "GET", "/api/v1/admin/keys", {
      headers: { "X-Admin-Key": ADMIN_SECRET },
    });
    assert.equal(listed.status, 200);
    assert.ok(Array.isArray(listed.body));
    assert.ok(listed.body.length >= 1);
    for (const item of listed.body) {
      assert.ok(isMaskedKey(item.key), `list leaked a secret: ${item.key}`);
      assert.equal(typeof item.keyPrefix, "string");
      assert.equal(typeof item.keyLast4, "string");
      assert.doesNotMatch(JSON.stringify(item), /sk_live_[a-f0-9]{20,}/i);
    }

    const wl = await request(port, "GET", "/api/v1/admin/white-label", {
      headers: { "X-Admin-Key": ADMIN_SECRET },
    });
    assert.equal(wl.status, 200);

    const margin = await request(port, "GET", "/api/v1/admin/x402-margin", {
      headers: { "X-Admin-Key": ADMIN_SECRET },
    });
    assert.equal(margin.status, 200);
    assert.equal(typeof margin.body.revenueUsd, "number");
  });

  it("disables every admin route with 404 when ADMIN_API_KEY is unset", async () => {
    const prev = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
      const pro = await store.createApiKey("pro-while-unset", "pro");
      for (const route of ADMIN_ROUTES) {
        const withAdmin = await request(port, route.method, route.path, {
          body: route.body,
          headers: { "X-Admin-Key": prev! },
        });
        assert.equal(withAdmin.status, 404, `admin header ${route.method} ${route.path}`);
        const withPro = await request(port, route.method, route.path, {
          body: route.body,
          headers: { "X-API-Key": pro.key },
        });
        assert.equal(withPro.status, 404, `pro key ${route.method} ${route.path}`);
      }
    } finally {
      process.env.ADMIN_API_KEY = prev;
    }
  });

  it("masks /me API keys and does not return the plaintext secret after login", async () => {
    const email = `me-mask-${Date.now()}@example.com`;
    const created = await signup(email);
    const login = await request(port, "POST", "/auth/login", { body: { email, password } });
    assert.equal(login.status, 200);
    assert.equal(login.body.apiKey, undefined);

    const me = await request(port, "GET", "/me", { cookie: created.cookie });
    assert.equal(me.status, 200);
    assert.ok(Array.isArray(me.body.apiKeys));
    assert.ok(me.body.apiKeys.length >= 1);
    assert.ok(isMaskedKey(me.body.apiKeys[0].key), me.body.apiKeys[0].key);
    assert.doesNotMatch(JSON.stringify(me.body), new RegExp(created.plaintext));
  });

  it("rotates the session user's key, keeps plan/quota, and invalidates the old secret", async () => {
    const email = `rotate-${Date.now()}@example.com`;
    const created = await signup(email);
    await setTier(created.userId, "paid");
    const user = userStore.findById(created.userId)!;
    const periodKey = getBillingPeriodKey(getFallbackBillingPeriod(user.createdAt));
    await store.setApiKeyUsageCount(created.plaintext, 7);
    await store.incrementAttestationUsage(created.plaintext, periodKey);

    const rotated = await request(port, "POST", "/api/v1/keys/rotate", {
      cookie: created.cookie,
      headers: { Origin: originFor(port) },
      body: {},
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.match(rotated.body.key, /^sk_live_/);
    assert.notEqual(rotated.body.key, created.plaintext);
    assert.ok(isMaskedKey(rotated.body.apiKey.key));

    const newRecord = await store.getApiKey(rotated.body.key);
    assert.ok(newRecord);
    assert.equal(newRecord.tier, "paid");
    assert.equal(newRecord.usageCount, 7);
    assert.equal(await store.getAttestationUsage(rotated.body.key, periodKey), 1);

    const oldAuth = await request(port, "GET", "/api/v1/status/not-a-real-id", {
      headers: { "X-API-Key": created.plaintext },
    });
    assert.equal(oldAuth.status, 403);

    const newAuth = await request(port, "GET", "/api/v1/status/not-a-real-id", {
      headers: { "X-API-Key": rotated.body.key },
    });
    assert.equal(newAuth.status, 404);
  });

  it("requires a session cookie for rotation (Bearer is not enough)", async () => {
    const email = `rotate-bearer-${Date.now()}@example.com`;
    const created = await signup(email);
    const noAuth = await request(port, "POST", "/api/v1/keys/rotate", {
      headers: { Origin: originFor(port) },
      body: {},
    });
    assert.equal(noAuth.status, 401);
    const bearer = await request(port, "POST", "/api/v1/keys/rotate", {
      headers: { Origin: originFor(port), Authorization: `Bearer ${created.token}` },
      body: {},
    });
    assert.equal(bearer.status, 401);
  });

  it("rejects cross-origin and Origin-less rotation POSTs", async () => {
    const email = `rotate-csrf-${Date.now()}@example.com`;
    const created = await signup(email);
    const cross = await request(port, "POST", "/api/v1/keys/rotate", {
      cookie: created.cookie,
      headers: { Origin: "https://evil.example" },
      body: {},
    });
    assert.equal(cross.status, 403);
    const noOrigin = await request(port, "POST", "/api/v1/keys/rotate", {
      cookie: created.cookie,
      body: {},
    });
    assert.equal(noOrigin.status, 403);
  });

  it("lets a logged-in paid user attest via the dashboard without pasting an API key", async () => {
    const email = `dash-paid-${Date.now()}@example.com`;
    const created = await signup(email);
    await setTier(created.userId, "paid");
    const txHash = generateTestTxHash("DASH");
    setFdcMocksForTests({
      prepareRequest: async () => "0xabi",
      submitRequest: async () => ({ roundId: 42, txHash: "0xfdc" }),
      isAlreadyVerified: async () => false,
    });

    const started = await request(port, "POST", "/api/v1/dashboard/verify", {
      cookie: created.cookie,
      headers: { Origin: originFor(port) },
      body: { txHash },
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.status, "pending");
    assert.equal(started.body.txHash, txHash);
    assert.ok(started.body.id);

    const status = await request(port, "GET", `/api/v1/dashboard/status/${started.body.id}`, {
      cookie: created.cookie,
    });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.status, "pending");
    assert.equal(status.body.txHash, txHash);

    const receipts = await request(port, "GET", "/receipts", { cookie: created.cookie });
    assert.equal(receipts.status, 200);
    assert.ok(receipts.body.some((r: { txHash: string }) => r.txHash === txHash));

    const user = userStore.findById(created.userId)!;
    const periodKey = getBillingPeriodKey(getFallbackBillingPeriod(user.createdAt));
    assert.equal(await store.getAttestationUsage(created.plaintext, periodKey), 1);
  });

  it("returns QUOTA_EXCEEDED for a free-plan dashboard verify of a new hash", async () => {
    const email = `dash-free-${Date.now()}@example.com`;
    const created = await signup(email);
    const txHash = generateTestTxHash("FREE");
    const res = await request(port, "POST", "/api/v1/dashboard/verify", {
      cookie: created.cookie,
      headers: { Origin: originFor(port) },
      body: { txHash },
    });
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.code, "QUOTA_EXCEEDED");
    assert.match(String(res.body.message), /upgrade|pay-per-use|x402|Paid/i);
    assert.equal(res.body.upgradeUrl, "/pricing");
  });

  it("lets a logged-in free user look up an existing receipt without consuming quota", async () => {
    const email = `dash-cached-${Date.now()}@example.com`;
    const created = await signup(email);
    const txHash = generateTestTxHash("CACHE");
    const att = await store.createAttestation(txHash);
    await store.updateAttestation(att.id, { status: "verified" });

    const res = await request(port, "POST", "/api/v1/dashboard/verify", {
      cookie: created.cookie,
      headers: { Origin: originFor(port) },
      body: { txHash },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "verified");
    assert.equal(res.body.cached, true);

    const user = userStore.findById(created.userId)!;
    const periodKey = getBillingPeriodKey(getFallbackBillingPeriod(user.createdAt));
    assert.equal(await store.getAttestationUsage(created.plaintext, periodKey), 0);

    const receipts = await request(port, "GET", "/receipts", { cookie: created.cookie });
    assert.ok(receipts.body.some((r: { txHash: string }) => r.txHash === txHash));
  });

  it("surfaces a failed attestation error such as TX_TOO_OLD on dashboard status", async () => {
    const email = `dash-fail-${Date.now()}@example.com`;
    const created = await signup(email);
    const txHash = generateTestTxHash("OLD");
    const att = await store.createAttestation(txHash);
    await store.updateAttestation(att.id, { status: "failed", error: "TX_TOO_OLD: payment is older than 14 days" });
    userStore.addReceipt(created.userId, txHash);

    const status = await request(port, "GET", `/api/v1/dashboard/status/${att.id}`, {
      cookie: created.cookie,
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "failed");
    assert.match(String(status.body.error), /TX_TOO_OLD/);
  });

  it("does not leak another user's receipts or dashboard status", async () => {
    const a = await signup(`recv-a-${Date.now()}@example.com`);
    const b = await signup(`recv-b-${Date.now()}@example.com`);
    const txHash = generateTestTxHash("ISO");
    const att = await store.createAttestation(txHash);
    await store.updateAttestation(att.id, { status: "verified" });
    userStore.addReceipt(a.userId, txHash);

    const receiptsB = await request(port, "GET", "/receipts", { cookie: b.cookie });
    assert.equal(receiptsB.status, 200);
    assert.ok(!receiptsB.body.some((r: { txHash: string }) => r.txHash === txHash));

    const statusB = await request(port, "GET", `/api/v1/dashboard/status/${att.id}`, { cookie: b.cookie });
    assert.equal(statusB.status, 404);

    const receiptsA = await request(port, "GET", "/receipts", { cookie: a.cookie });
    assert.ok(receiptsA.body.some((r: { txHash: string }) => r.txHash === txHash));
  });

  it("requires a same-origin session cookie for dashboard verify", async () => {
    const created = await signup(`dash-csrf-${Date.now()}@example.com`);
    await setTier(created.userId, "paid");
    const txHash = generateTestTxHash("CSRF");
    const noAuth = await request(port, "POST", "/api/v1/dashboard/verify", {
      headers: { Origin: originFor(port) },
      body: { txHash },
    });
    assert.equal(noAuth.status, 401);
    const bearer = await request(port, "POST", "/api/v1/dashboard/verify", {
      headers: { Origin: originFor(port), Authorization: `Bearer ${created.token}` },
      body: { txHash },
    });
    assert.equal(bearer.status, 401);
    const cross = await request(port, "POST", "/api/v1/dashboard/verify", {
      cookie: created.cookie,
      headers: { Origin: "https://evil.example" },
      body: { txHash },
    });
    assert.equal(cross.status, 403);
  });

  it("lets a logged-out visitor look up an existing public receipt", async () => {
    const txHash = generateTestTxHash("PUB");
    const att = await store.createAttestation(txHash);
    await store.updateAttestation(att.id, { status: "verified" });
    const page = await request(port, "GET", `/receipt/${txHash}?format=json`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.txHash, txHash);
    assert.equal(page.body.status, "verified");
  });

  it("embeds a complete dashboard Quick Start curl and session verify wiring", async () => {
    const src = readFileSync(ROUTES_PATH, "utf8");
    assert.match(src, /\/api\/v1\/dashboard\/verify/);
    assert.match(src, /\/api\/v1\/dashboard\/status\//);
    assert.match(src, /\/api\/v1\/keys\/rotate/);
    assert.match(src, /Regenerate API key/);
    assert.match(src, /sk_live_YOUR_API_KEY/);
    assert.match(src, /X-API-Key/);
    assert.match(src, /Content-Type: application\/json/);
    assert.match(src, /87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F/);
    assert.match(src, /lookupExisting/);
    assert.match(src, /Quota reached/);
    assert.match(src, /docs#x402/);

    const page = await request(port, "GET", "/dashboard");
    assert.equal(page.status, 200);
    assert.match(page.raw, /sk_live_YOUR_API_KEY/);
    assert.match(page.raw, /X-API-Key/);
    assert.match(page.raw, /Content-Type: application\/json/);
    assert.match(page.raw, /87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F/);
    assert.match(page.raw, /\/api\/v1\/dashboard\/verify/);
    assert.match(page.raw, /Regenerate API key/);
    assert.match(page.raw, /Look up an existing receipt/);
  });
});
