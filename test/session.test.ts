import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import http from "node:http";
import { SESSION_COOKIE, SESSION_MAX_AGE_MS } from "../src/session.js";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32-chars-min!!";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

async function startApp(): Promise<{ server: http.Server; port: number }> {
  const { default: app } = await import("../src/app.js");
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1");
    s.once("error", reject);
    s.once("listening", () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("test server did not bind");
  return { server, port: addr.port };
}

async function stopApp(server: http.Server | null): Promise<void> {
  if (!server) return;
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
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

function sessionSetCookie(setCookie: string | string[] | undefined): string | undefined {
  return cookiePairs(setCookie).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

function sessionCookieHeader(setCookie: string | string[] | undefined): string {
  const line = sessionSetCookie(setCookie);
  if (!line) return "";
  return line.split(";")[0];
}

describe("Session cookies and nav", () => {
  let server: http.Server | null = null;
  let port = 0;
  const email = `session-${Date.now()}@example.com`;
  const password = "password12";

  before(async () => {
    const started = await startApp();
    server = started.server;
    port = started.port;
  });

  after(async () => {
    await stopApp(server);
  });

  it("sets an httpOnly SameSite=Lax 30-day session cookie on login", async () => {
    const signup = await request(port, "POST", "/auth/signup", {
      body: { email, password },
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const line = sessionSetCookie(signup.headers["set-cookie"]);
    assert.ok(line, "expected Set-Cookie for xrplink_session");
    assert.match(line!, /HttpOnly/i);
    assert.match(line!, /SameSite=Lax/i);
    assert.doesNotMatch(line!, /SameSite=None/i);
    assert.match(line!, new RegExp(`Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`));
  });

  it("authenticates /me and /auth/session with the cookie alone", async () => {
    const login = await request(port, "POST", "/auth/login", {
      body: { email, password },
    });
    assert.equal(login.status, 200);
    const cookie = sessionCookieHeader(login.headers["set-cookie"]);
    assert.ok(cookie);

    const me = await request(port, "GET", "/me", { cookie });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.user.email, email);

    const session = await request(port, "GET", "/auth/session", { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.user.email, email);
    assert.equal(session.body.user.tier, "free");
    assert.ok(sessionSetCookie(session.headers["set-cookie"]), "rolling session should refresh the cookie");
  });

  it("keeps the session after a follow-up request (cookie round-trip)", async () => {
    const login = await request(port, "POST", "/auth/login", {
      body: { email, password },
    });
    const cookie = sessionCookieHeader(login.headers["set-cookie"]);
    const first = await request(port, "GET", "/auth/session", { cookie });
    const refreshed = sessionCookieHeader(first.headers["set-cookie"]) || cookie;
    const second = await request(port, "GET", "/me", { cookie: refreshed });
    assert.equal(second.status, 200);
    assert.equal(second.body.user.email, email);
  });

  it("redirects /login to /dashboard when already logged in", async () => {
    const login = await request(port, "POST", "/auth/login", {
      body: { email, password },
    });
    const cookie = sessionCookieHeader(login.headers["set-cookie"]);
    const page = await request(port, "GET", "/login", { cookie });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, "/dashboard");
  });

  it("returns user:null for /auth/session without a cookie", async () => {
    const session = await request(port, "GET", "/auth/session");
    assert.equal(session.status, 200);
    assert.equal(session.body.user, null);
  });

  it("clears the session cookie on logout", async () => {
    const login = await request(port, "POST", "/auth/login", {
      body: { email, password },
    });
    const cookie = sessionCookieHeader(login.headers["set-cookie"]);
    const logout = await request(port, "POST", "/auth/logout", { cookie });
    assert.equal(logout.status, 200);
    const cleared = sessionSetCookie(logout.headers["set-cookie"]);
    assert.ok(cleared);
    assert.match(cleared!, /Max-Age=0|Max-Age=-|Expires=Thu, 01 Jan 1970/i);
    const me = await request(port, "GET", "/me");
    assert.equal(me.status, 401);
  });

  it("includes shared nav hooks on public pages", async () => {
    for (const path of ["/", "/docs", "/contact", "/dashboard"]) {
      const page = await request(port, "GET", path);
      assert.equal(page.status, 200, path);
      assert.match(page.raw, /id="authNav"/, path);
      assert.match(page.raw, /session-nav\.js/, path);
    }
  });

  it("exposes pricing CTA hooks on the landing page", async () => {
    const page = await request(port, "GET", "/");
    assert.match(page.raw, /data-pricing-cta="free"/);
    assert.match(page.raw, /data-pricing-cta="paid"/);
    assert.match(page.raw, /data-pricing-cta="pro"/);
  });
});

describe("Session cookie options", () => {
  it("uses Lax in production (not None)", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { sessionCookieOptions } = await import("../src/session.js");
      const opts = sessionCookieOptions();
      assert.equal(opts.sameSite, "lax");
      assert.equal(opts.httpOnly, true);
      assert.equal(opts.secure, true);
      assert.equal(opts.maxAge, SESSION_MAX_AGE_MS);
      assert.equal(opts.path, "/");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("does not set Secure outside production", async () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    delete process.env.FLY_APP_NAME;
    try {
      const { sessionCookieOptions } = await import("../src/session.js");
      const opts = sessionCookieOptions();
      assert.equal(opts.secure, false);
      assert.equal(opts.sameSite, "lax");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
