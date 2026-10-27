/**
 * Session revocation, purpose-bound reset tokens, Stripe price-derived
 * upgrade tiers, and security headers.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";

const SESSION_SECRET = "test-session-secret-32-chars-min!!";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || SESSION_SECRET;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "xrplink-sess-"));
process.env.X402_ENABLED = "false";
delete process.env.X402_PAY_TO_ADDRESS;
delete process.env.DATABASE_URL;
delete process.env.STRIPE_SECRET_KEY;

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

function sessionCookieHeader(setCookie: string | string[] | undefined): string {
  const pairs = !setCookie ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  const line = pairs.find((c) => c.startsWith("xrplink_session="));
  if (!line) return "";
  return line.split(";")[0];
}

function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

describe("Session revocation and reset tokens", () => {
  let server: http.Server | null = null;
  let port = 0;
  let userStore: typeof import("../src/user-store.js").userStore;
  let generateResetToken: typeof import("../src/auth.js").generateResetToken;
  let resetPassword: typeof import("../src/auth.js").resetPassword;
  let getUserFromToken: typeof import("../src/auth.js").getUserFromToken;
  let hashResetToken: typeof import("../src/auth.js").hashResetToken;
  const password = "password12";

  before(async () => {
    const { default: app } = await import("../src/app.js");
    const userMod = await import("../src/user-store.js");
    const authMod = await import("../src/auth.js");
    userStore = userMod.userStore;
    generateResetToken = authMod.generateResetToken;
    resetPassword = authMod.resetPassword;
    getUserFromToken = authMod.getUserFromToken;
    hashResetToken = authMod.hashResetToken;

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
    if (!server) return;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
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
      token: res.body.token as string,
      userId: me.body.user.id as string,
      email,
    };
  }

  it("stores a sessionVersion on new users and embeds sv in the JWT", async () => {
    const created = await signup(`sv-${Date.now()}@example.com`);
    const user = userStore.findById(created.userId)!;
    assert.equal(user.sessionVersion, 1);
    const payload = jwt.verify(created.token, SESSION_SECRET) as { sv?: number; purpose?: string };
    assert.equal(payload.sv, 1);
    assert.equal(payload.purpose, "session");
  });

  it("accepts a legacy cookie without sv while sessionVersion is still 1", async () => {
    const created = await signup(`legacy-${Date.now()}@example.com`);
    const user = userStore.findById(created.userId)!;
    const legacy = jwt.sign({ userId: user.id, email: user.email }, SESSION_SECRET, { expiresIn: "30d" });
    assert.ok(getUserFromToken(legacy));
    const me = await request(port, "GET", "/me", { headers: { Authorization: `Bearer ${legacy}` } });
    assert.equal(me.status, 200);
  });

  it("rejects a legacy cookie after sessionVersion is bumped", async () => {
    const created = await signup(`legacy-bump-${Date.now()}@example.com`);
    const user = userStore.findById(created.userId)!;
    const legacy = jwt.sign({ userId: user.id, email: user.email }, SESSION_SECRET, { expiresIn: "30d" });
    userStore.bumpSessionVersion(user.id);
    assert.equal(getUserFromToken(legacy), null);
    const me = await request(port, "GET", "/me", { cookie: created.cookie });
    assert.equal(me.status, 401);
  });

  it("invalidates the presented session on logout (cookie still sent is rejected)", async () => {
    const created = await signup(`logout-${Date.now()}@example.com`);
    const logout = await request(port, "POST", "/auth/logout", { cookie: created.cookie });
    assert.equal(logout.status, 200);
    const me = await request(port, "GET", "/me", { cookie: created.cookie });
    assert.equal(me.status, 401);
    assert.equal(getUserFromToken(created.token), null);
  });

  it("stores reset tokens hashed, purpose-bound, single-use, and invalidates the previous one", async () => {
    const created = await signup(`reset-${Date.now()}@example.com`);
    const first = generateResetToken(created.email);
    assert.ok(first);
    const userAfterFirst = userStore.findById(created.userId)!;
    assert.ok(userAfterFirst.resetTokenHash);
    assert.match(userAfterFirst.resetTokenHash!, /^[a-f0-9]{64}$/);
    assert.equal(userAfterFirst.resetTokenHash, hashResetToken(first!));
    assert.ok(!JSON.stringify(userAfterFirst).includes(first!));
    assert.ok(userAfterFirst.resetTokenExpiresAt && userAfterFirst.resetTokenExpiresAt > Date.now());

    const second = generateResetToken(created.email);
    assert.ok(second);
    assert.notEqual(second, first);

    const reuseFirst = resetPassword(first!, "newpassword99");
    assert.equal(reuseFirst.ok, false);

    const sessionAsReset = resetPassword(created.token, "newpassword99");
    assert.equal(sessionAsReset.ok, false);

    const resetJwt = jwt.sign(
      { userId: created.userId, purpose: "reset" },
      SESSION_SECRET,
      { expiresIn: "1h" }
    );
    assert.equal(resetPassword(resetJwt, "newpassword99").ok, false);
    assert.equal(getUserFromToken(resetJwt), null);

    const confirm = await request(port, "POST", "/auth/reset-password/confirm", {
      body: { token: second, password: "newpassword99" },
    });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

    const reuseSecond = resetPassword(second!, "anotherpass99");
    assert.equal(reuseSecond.ok, false);

    const after = userStore.findById(created.userId)!;
    assert.equal(after.resetTokenHash, undefined);
    assert.ok((after.sessionVersion || 1) > 1);

    const oldSession = await request(port, "GET", "/me", { cookie: created.cookie });
    assert.equal(oldSession.status, 401);

    const login = await request(port, "POST", "/auth/login", {
      body: { email: created.email, password: "newpassword99" },
    });
    assert.equal(login.status, 200);
  });

  it("rejects an expired reset token", async () => {
    const created = await signup(`reset-exp-${Date.now()}@example.com`);
    const token = generateResetToken(created.email);
    assert.ok(token);
    userStore.update(created.userId, { resetTokenExpiresAt: Date.now() - 1000 });
    const result = resetPassword(token!, "newpassword99");
    assert.equal(result.ok, false);
  });

  it("rotates the API key and revokes other sessions while keeping the current one", async () => {
    const created = await signup(`rotate-sv-${Date.now()}@example.com`);
    const otherLogin = await request(port, "POST", "/auth/login", {
      body: { email: created.email, password },
    });
    const otherCookie = sessionCookieHeader(otherLogin.headers["set-cookie"]);
    assert.ok(otherCookie);

    const rotated = await request(port, "POST", "/api/v1/keys/rotate", {
      cookie: created.cookie,
      headers: { Origin: originFor(port) },
      body: {},
    });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.ok(rotated.body.token);
    const newCookie = sessionCookieHeader(rotated.headers["set-cookie"]);
    assert.ok(newCookie);

    const other = await request(port, "GET", "/me", { cookie: otherCookie });
    assert.equal(other.status, 401);
    const oldSelf = await request(port, "GET", "/me", { cookie: created.cookie });
    assert.equal(oldSelf.status, 401);
    const current = await request(port, "GET", "/me", { cookie: newCookie });
    assert.equal(current.status, 200);
  });
});

describe("Stripe checkout tier is derived from price ID", () => {
  it("maps known lookup keys and ignores unknown prices", async () => {
    const { lookupKeyToTier, resolveCheckoutTier, TIER_PRODUCTS, handleCheckoutCompleted } =
      await import("../src/billing.js");
    const { userStore } = await import("../src/user-store.js");
    const { hash } = await import("bcryptjs");

    assert.equal(lookupKeyToTier("xrplink_paid"), "paid");
    assert.equal(lookupKeyToTier("xrplink_pro"), "pro");
    assert.equal(lookupKeyToTier("xrplink_enterprise"), null);
    assert.equal(lookupKeyToTier(""), null);

    const prevPaid = TIER_PRODUCTS.paid.priceId;
    const prevPro = TIER_PRODUCTS.pro.priceId;
    TIER_PRODUCTS.paid.priceId = "price_test_paid";
    TIER_PRODUCTS.pro.priceId = "price_test_pro";
    try {
      const paid = await resolveCheckoutTier(
        { metadata: { tier: "pro" }, line_items: { data: [{ price: { id: "price_test_paid" } }] } },
        null
      );
      assert.equal(paid, "paid");

      const fromSub = await resolveCheckoutTier(
        { metadata: { tier: "paid" } },
        { items: { data: [{ price: { id: "price_test_pro", lookup_key: "xrplink_pro" } }] } }
      );
      assert.equal(fromSub, "pro");

      const unknown = await resolveCheckoutTier(
        { metadata: { tier: "pro" }, line_items: { data: [{ price: { id: "price_unknown" } }] } },
        null
      );
      assert.equal(unknown, null);

      const missing = await resolveCheckoutTier({ metadata: { userId: "x", tier: "pro" } }, null);
      assert.equal(missing, null);

      const email = `stripe-tier-${Date.now()}@example.com`;
      const user = userStore.create(email, await hash("password12", 10));

      await handleCheckoutCompleted({
        metadata: { userId: user.id, tier: "pro" },
        customer: "cus_test_paid",
        subscription: "sub_test_paid",
        line_items: { data: [{ price: { id: "price_test_paid" } }] },
      } as any);
      const upgraded = userStore.findById(user.id)!;
      assert.equal(upgraded.tier, "paid");
      assert.equal(upgraded.subscriptionStatus, "active");

      await handleCheckoutCompleted({
        metadata: { userId: user.id, tier: "pro" },
        customer: "cus_ignored",
        line_items: { data: [{ price: { id: "price_not_a_plan" } }] },
      } as any);
      assert.equal(userStore.findById(user.id)!.tier, "paid");

      userStore.delete(user.id);
    } finally {
      TIER_PRODUCTS.paid.priceId = prevPaid;
      TIER_PRODUCTS.pro.priceId = prevPro;
    }
  });
});

describe("Security headers", () => {
  let server: http.Server | null = null;
  let port = 0;

  before(async () => {
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
    if (!server) return;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("sets HSTS, nosniff, frame deny, referrer, CSP, and removes X-Powered-By", async () => {
    const { CONTENT_SECURITY_POLICY } = await import("../src/security-headers.js");
    for (const path of ["/", "/pricing", "/docs", "/dashboard", "/health", "/login"]) {
      const res = await request(port, "GET", path);
      assert.ok(res.status < 500, path);
      assert.equal(res.headers["strict-transport-security"], "max-age=31536000; includeSubDomains", path);
      assert.equal(res.headers["x-content-type-options"], "nosniff", path);
      assert.equal(res.headers["x-frame-options"], "DENY", path);
      assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin", path);
      assert.equal(res.headers["content-security-policy"], CONTENT_SECURITY_POLICY, path);
      assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
      assert.equal(res.headers["x-powered-by"], undefined, path);
    }
  });
});
