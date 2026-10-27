import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
});
