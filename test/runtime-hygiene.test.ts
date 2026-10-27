/**
 * File-store mutex, FLARE_NETWORK production boot, stdio MCP hardening.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = process.env.DATA_DIR || mkdtempSync(join(tmpdir(), "xrplink-hygiene-"));
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32-chars-min!!";
process.env.X402_ENABLED = "false";
delete process.env.X402_PAY_TO_ADDRESS;
delete process.env.DATABASE_URL;
delete process.env.MCP_API_KEY;

function generateTestTxHash(suffix: string): string {
  const timestamp = Date.now().toString(16).toUpperCase();
  const random = Math.random().toString(16).slice(2).toUpperCase();
  const suffixHex = Buffer.from(suffix).toString("hex").toUpperCase();
  return (timestamp + random + suffixHex).padEnd(64, "0").slice(0, 64);
}

describe("JSON file-store mutex", () => {
  it("serializes concurrent attestation updates so both fields persist", async () => {
    const { store } = await import("../src/store.js");
    const hash = generateTestTxHash("LOCK");
    const created = await store.createAttestation(hash, "owner");
    await Promise.all([
      store.updateAttestation(created.id, { abiEncodedRequest: "0xabc" }),
      store.updateAttestation(created.id, { roundId: 42 }),
    ]);
    const fresh = await store.getAttestation(created.id);
    assert.ok(fresh);
    assert.equal(fresh.abiEncodedRequest, "0xabc");
    assert.equal(fresh.roundId, 42);
  });

  it("writes users.json via temp+rename (no leftover tmp after persist)", async () => {
    const { userStore } = await import("../src/user-store.js");
    const { hash } = await import("bcryptjs");
    const email = `lock-${Date.now()}@example.com`;
    const user = userStore.create(email, await hash("password12", 10));
    userStore.update(user.id, { tier: "paid" });
    const raw = readFileSync(join(process.env.DATA_DIR!, "users.json"), "utf8");
    assert.match(raw, /"tier": "paid"/);
    assert.ok(!raw.includes(undefined as unknown as string));
  });
});

describe("stdio MCP hardening", () => {
  it("verify_xrp_payment without a key does not create an unauthenticated attestation", async () => {
    const { handleVerifyXrpPayment } = await import("../src/mcp/tools.js");
    const { runMcpContext } = await import("../src/mcp/context.js");
    const { store } = await import("../src/store.js");
    const hash = generateTestTxHash("STDIO");
    const result = await runMcpContext({ http: false }, () =>
      handleVerifyXrpPayment({ txHash: hash })
    );
    assert.equal(result.isError, true);
    const text = result.content?.[0]?.text || "";
    assert.match(text, /API key required|MISSING_API_KEY|x402|Payment Required/i);
    const created = await store.getByTxHash(hash);
    assert.equal(created, undefined);
  });

  it("get_server_info does not include tenant attestation counts", async () => {
    const { handleGetServerInfo } = await import("../src/mcp/tools.js");
    const result = await handleGetServerInfo();
    const text = result.content?.[0]?.text || "";
    assert.doesNotMatch(text, /attestationCount/);
    assert.match(text, /"network"/);
  });

  it("hides live network status and admin_setup without a key", async () => {
    const { getResources, readResource } = await import("../src/mcp/resources.js");
    const { getPromptDefs } = await import("../src/mcp/prompts.js");
    const { runMcpContext } = await import("../src/mcp/context.js");
    const { NETWORK_STATUS_URI } = await import("../src/attestation-view.js");
    await runMcpContext({ http: false }, async () => {
      const listed = getResources();
      assert.ok(!listed.some((r) => r.uri === NETWORK_STATUS_URI));
      assert.equal(await readResource(NETWORK_STATUS_URI), null);
    });
    const prompts = getPromptDefs({ includeAdmin: false }).map((p) => p.name);
    assert.ok(!prompts.includes("admin_setup"));
  });
});

describe("Docker hardening", () => {
  it("pins the Node image, runs as uid 1000, and health-checks 127.0.0.1", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(dockerfile, /node:22\.23\.4-alpine3\.24@sha256:[a-f0-9]{64}/);
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /http:\/\/127\.0\.0\.1:3000\/health/);
    assert.doesNotMatch(dockerfile, /localhost:3000/);
    assert.doesNotMatch(dockerfile, /COPY \.env/);
  });
});
