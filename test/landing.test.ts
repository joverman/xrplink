import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = join(ROOT, "public", "index.html");
const APP_PATH = join(ROOT, "src", "app.ts");
const ROUTES_PATH = join(ROOT, "src", "routes.ts");

describe("Landing page pricing helpers", () => {
  it("formats floor-style amounts with two decimals and whole-dollar caps without them", async () => {
    const { formatLandingUsd } = await import("../src/landing.js");
    assert.equal(formatLandingUsd(2.5), "2.50");
    assert.equal(formatLandingUsd(10), "10");
    assert.equal(formatLandingUsd(10.0), "10");
    assert.equal(formatLandingUsd(3.75), "3.75");
  });

  it("interpolates configured floor and cap into the Pay as you go card", async () => {
    const { renderLandingPage } = await import("../src/landing.js");
    const html = renderLandingPage(readFileSync(INDEX_PATH, "utf8"), 4.25, 12);
    assert.match(html, /<h3>Pay as you go<\/h3>/);
    assert.match(html, /from<\/span> \$4\.25<span> per attestation<\/span>/);
    assert.match(html, /For AI agents and one-off checks/);
    assert.match(html, /No account or subscription/);
    assert.match(html, /Pay in RLUSD or XRP on the XRP Ledger \(x402\)/);
    assert.match(html, /Price tracks the Flare \(FLR\) fee, capped at \$12/);
    assert.match(html, /Built for agents: MCP at xrp-link\.com\/mcp/);
    assert.match(html, /href="\/docs#x402"/);
    assert.doesNotMatch(html, /\{\{X402_FLOOR_USD\}\}/);
    assert.doesNotMatch(html, /\{\{X402_CAP_USD\}\}/);
  });

  it("keeps Free, Paid, and Pro card copy unchanged", async () => {
    const { renderLandingPage } = await import("../src/landing.js");
    const html = renderLandingPage(readFileSync(INDEX_PATH, "utf8"), 2.5, 10);
    assert.match(html, /<h3>Free<\/h3>/);
    assert.match(html, /\$0<span>\/mo<\/span>/);
    assert.match(html, /Explore and test/);
    assert.match(html, /<h3>Paid<\/h3>/);
    assert.match(html, /\$29<span>\/mo<\/span>/);
    assert.match(html, /20 verified receipts per month/);
    assert.match(html, /<h3>Pro<\/h3>/);
    assert.match(html, /\$99<span>\/mo<\/span>/);
    assert.match(html, /100 verified receipts per month/);
  });

  it("serves the landing page from live X402_FLOOR_USD and X402_CAP_USD", () => {
    const appSrc = readFileSync(APP_PATH, "utf8");
    assert.match(appSrc, /loadLandingHtml/);
    assert.match(appSrc, /app\.get\(\["\/", "\/index\.html"\]/);
    const routesSrc = readFileSync(ROUTES_PATH, "utf8");
    assert.match(routesSrc, /id="x402"/);
    assert.match(routesSrc, /Pay as you go \(x402\)/);
    assert.match(routesSrc, /id="attestation"/);
  });

  it("renders a dedicated /pricing page from the same plan cards", async () => {
    const { loadPricingHtml, renderLandingPage } = await import("../src/landing.js");
    const html = loadPricingHtml();
    assert.match(html, /<h1>Pricing<\/h1>/);
    assert.match(html, /<h3>Free<\/h3>/);
    assert.match(html, /<h3>Paid<\/h3>/);
    assert.match(html, /<h3>Pro<\/h3>/);
    assert.match(html, /<h3>Pay as you go<\/h3>/);
    assert.match(html, /data-pricing-cta="paid"/);
    assert.match(html, /session-nav\.js/);
    assert.doesNotMatch(html, /\{\{PRICING_CARDS\}\}/);
    assert.doesNotMatch(html, /\{\{X402_FLOOR_USD\}\}/);
    const withCustom = renderLandingPage(
      readFileSync(join(ROOT, "public", "pricing.html"), "utf8"),
      4.25,
      12
    );
    assert.match(withCustom, /from<\/span> \$4\.25<span> per attestation<\/span>/);
    assert.match(withCustom, /capped at \$12/);
  });

  it("registers GET /pricing on the app", () => {
    const appSrc = readFileSync(APP_PATH, "utf8");
    assert.match(appSrc, /loadPricingHtml/);
    assert.match(appSrc, /app\.get\(\["\/pricing", "\/pricing\.html"\]/);
  });

  it("links /icon.png as the favicon on public HTML pages", () => {
    for (const file of ["index.html", "pricing.html"]) {
      const html = readFileSync(join(ROOT, "public", file), "utf8");
      assert.match(html, /<link rel="icon" href="\/icon\.png"/);
    }
  });

  it("commits a 256x256 PNG at public/icon.png", () => {
    const buf = readFileSync(join(ROOT, "public", "icon.png"));
    assert.equal(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
    assert.equal(buf.readUInt32BE(16), 256);
    assert.equal(buf.readUInt32BE(20), 256);
  });

  it("declares websiteUrl and icons in server.json", () => {
    const spec = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
    assert.equal(spec.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    assert.equal(spec.websiteUrl, "https://xrp-link.com");
    assert.deepEqual(spec.icons, [
      {
        src: "https://xrp-link.com/icon.png",
        mimeType: "image/png",
        sizes: ["256x256"],
      },
    ]);
    assert.equal(spec.version, "0.3.1");
  });
});

describe("GET /icon.png", () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32-chars-min!!";
  process.env.NODE_ENV = process.env.NODE_ENV || "test";

  let server: http.Server | null = null;
  let port = 0;

  async function startApp(): Promise<void> {
    const { default: app } = await import("../src/app.js");
    server = await new Promise<http.Server>((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1");
      s.once("error", reject);
      s.once("listening", () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("test server did not bind");
    port = addr.port;
  }

  async function stopApp(): Promise<void> {
    if (!server) return;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
  }

  function get(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: "GET",
          hostname: "127.0.0.1",
          port,
          path,
          agent: new http.Agent({ keepAlive: false }),
          headers: { Connection: "close" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("serves icon.png as image/png and favicon.ico without 404", async () => {
    await startApp();
    try {
      const icon = await get("/icon.png");
      assert.equal(icon.status, 200);
      assert.match(String(icon.headers["content-type"]), /^image\/png\b/i);
      assert.equal(
        icon.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        true
      );

      const favicon = await get("/favicon.ico");
      assert.equal(favicon.status, 200);
      assert.ok(favicon.body.length > 0);
    } finally {
      await stopApp();
    }
  });
});
