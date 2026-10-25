import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

describe("Environment Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should detect production environment via NODE_ENV", async () => {
    const { isProduction } = await import("../src/env-validation.js");
    
    process.env.NODE_ENV = "production";
    assert.equal(isProduction(), true);
    
    process.env.NODE_ENV = "development";
    assert.equal(isProduction(), false);
  });

  it("should detect production environment via FLY_APP_NAME", async () => {
    const { isProduction } = await import("../src/env-validation.js");
    
    process.env.NODE_ENV = "";
    process.env.FLY_APP_NAME = "xrp-link";
    assert.equal(isProduction(), true);
  });

  it("should report errors for missing required secrets in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SESSION_SECRET;
    delete process.env.VERIFIER_API_KEY;
    delete process.env.PRIVATE_KEY_FLARE;
    delete process.env.PRIVATE_KEY;
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("SESSION_SECRET")));
    assert.ok(result.errors.some(e => e.includes("VERIFIER_API_KEY")));
    assert.ok(result.errors.some(e => e.includes("PRIVATE_KEY")));
  });

  it("should warn but not error for missing PAYMENT_VERIFIER_ADDRESS", async () => {
    process.env.NODE_ENV = "production";
    process.env.FLARE_NETWORK = "flare";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    process.env.VERIFIER_API_KEY = "valid-api-key-uuid";
    process.env.PRIVATE_KEY_FLARE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    delete process.env.PAYMENT_VERIFIER_ADDRESS_FLARE;
    delete process.env.PAYMENT_VERIFIER_ADDRESS;
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    assert.equal(result.valid, true, `Expected valid=true but got errors: ${result.errors.join(", ")}`);
    assert.ok(result.warnings.some(w => w.includes("PAYMENT_VERIFIER_ADDRESS")));
    assert.ok(result.warnings.some(w => w.includes("On-chain proof verification is disabled")));
  });

  it("should error for malformed PAYMENT_VERIFIER_ADDRESS", async () => {
    process.env.NODE_ENV = "production";
    process.env.FLARE_NETWORK = "flare";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    process.env.VERIFIER_API_KEY = "valid-api-key-uuid";
    process.env.PRIVATE_KEY_FLARE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    process.env.PAYMENT_VERIFIER_ADDRESS_FLARE = "invalid-address";
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    assert.equal(result.valid, false, `Expected valid=false but got no errors`);
    assert.ok(result.errors.some(e => e.includes("PAYMENT_VERIFIER_ADDRESS")), `Expected error about PAYMENT_VERIFIER_ADDRESS, got: ${result.errors.join(", ")}`);
    assert.ok(result.errors.some(e => e.includes("valid Ethereum address")), `Expected error about valid Ethereum address, got: ${result.errors.join(", ")}`);
  });

  it("should accept well-formed PAYMENT_VERIFIER_ADDRESS", async () => {
    process.env.NODE_ENV = "production";
    process.env.FLARE_NETWORK = "flare";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    process.env.VERIFIER_API_KEY = "valid-api-key-uuid";
    process.env.PRIVATE_KEY_FLARE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    process.env.PAYMENT_VERIFIER_ADDRESS_FLARE = "0x1234567890AbcdEF1234567890abcdef12345678";
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    assert.ok(!result.errors.some(e => e.includes("PAYMENT_VERIFIER_ADDRESS")), `Unexpected error about PAYMENT_VERIFIER_ADDRESS: ${result.errors.join(", ")}`);
  });

  it("should report warnings in development for missing secrets", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.SESSION_SECRET;
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => w.includes("SESSION_SECRET")));
  });
});

describe("Webhook Security", () => {
  it("should generate valid HMAC signatures", async () => {
    const { validateWebhookSignature } = await import("../src/webhook-service.js");
    const { createHmac } = await import("crypto");
    
    const payload = '{"event":"test"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = "test-secret-key";
    
    const signedPayload = `${timestamp}.${payload}`;
    const signature = createHmac("sha256", secret).update(signedPayload).digest("hex");
    
    const isValid = validateWebhookSignature(payload, `sha256=${signature}`, timestamp, secret);
    assert.equal(isValid, true);
  });

  it("should reject expired signatures", async () => {
    const { validateWebhookSignature } = await import("../src/webhook-service.js");
    const { createHmac } = await import("crypto");
    
    const payload = '{"event":"test"}';
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
    const secret = "test-secret-key";
    
    const signedPayload = `${oldTimestamp}.${payload}`;
    const signature = createHmac("sha256", secret).update(signedPayload).digest("hex");
    
    const isValid = validateWebhookSignature(payload, `sha256=${signature}`, oldTimestamp, secret);
    assert.equal(isValid, false);
  });

  it("should reject invalid signatures", async () => {
    const { validateWebhookSignature } = await import("../src/webhook-service.js");
    
    const payload = '{"event":"test"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = "test-secret-key";
    
    const isValid = validateWebhookSignature(payload, "sha256=invalid", timestamp, secret);
    assert.equal(isValid, false);
  });
});

describe("Store Atomic Writes", () => {
  it("should create attestations with valid UUIDs", async () => {
    const { store } = await import("../src/store.js");
    
    const txHash = "TEST" + Math.random().toString(36).slice(2).toUpperCase().padEnd(60, "0");
    const attestation = await store.createAttestation(txHash);
    
    assert.ok(attestation.id);
    assert.match(attestation.id, /^[0-9a-f-]{36}$/);
    assert.equal(attestation.txHash, txHash);
    assert.equal(attestation.status, "pending");
  });

  it("should return existing attestation for duplicate txHash", async () => {
    const { store } = await import("../src/store.js");
    
    const txHash = "DUP" + Math.random().toString(36).slice(2).toUpperCase().padEnd(61, "0");
    const first = await store.createAttestation(txHash);
    const second = await store.createAttestation(txHash);
    
    assert.equal(first.id, second.id);
  });

  it("should update attestation status", async () => {
    const { store } = await import("../src/store.js");
    
    const txHash = "UPD" + Math.random().toString(36).slice(2).toUpperCase().padEnd(61, "0");
    const attestation = await store.createAttestation(txHash);
    
    const updated = await store.updateAttestation(attestation.id, { status: "verified" });
    assert.ok(updated);
    assert.equal(updated.status, "verified");
    
    const fetched = await store.getAttestation(attestation.id);
    assert.equal(fetched?.status, "verified");
  });
});

describe("Health Check", () => {
  it("should return store health status", async () => {
    const { getStoreHealth } = await import("../src/store.js");
    
    const health = getStoreHealth();
    assert.ok(typeof health.ok === "boolean");
    assert.ok(health.type === "json" || health.type === "postgres");
  });
});
