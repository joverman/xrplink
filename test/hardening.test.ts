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

  it("should report error only for SESSION_SECRET in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SESSION_SECRET;
    delete process.env.VERIFIER_API_KEY;
    delete process.env.PRIVATE_KEY_FLARE;
    delete process.env.PRIVATE_KEY;
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    // Only SESSION_SECRET is a hard requirement
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("SESSION_SECRET")));
    // VERIFIER_API_KEY and PRIVATE_KEY are now warnings, not errors
    assert.ok(!result.errors.some(e => e.includes("VERIFIER_API_KEY")));
    assert.ok(!result.errors.some(e => e.includes("PRIVATE_KEY")));
    assert.ok(result.warnings.some(w => w.includes("VERIFIER_API_KEY")));
    assert.ok(result.warnings.some(w => w.includes("PRIVATE_KEY")));
  });

  it("should accept Flare public API key (all-zeros UUID) in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    process.env.VERIFIER_API_KEY = "00000000-0000-0000-0000-000000000000";
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    // App should start with the public API key
    assert.equal(result.valid, true, `Expected valid=true but got errors: ${result.errors.join(", ")}`);
    // Should warn but not error
    assert.ok(result.warnings.some(w => w.includes("VERIFIER_API_KEY")));
    assert.ok(result.warnings.some(w => w.includes("public")));
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

  // Regression test for production incident: string "undefined" was written to
  // process.env when assigning undefined, which then failed Ethereum address validation
  it("should treat string 'undefined' as unset (regression: Fly v29 crash)", async () => {
    process.env.NODE_ENV = "production";
    process.env.FLARE_NETWORK = "flare";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    process.env.VERIFIER_API_KEY = "valid-api-key-uuid";
    process.env.PRIVATE_KEY_FLARE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    // Simulate the bug: assigning undefined to process.env creates string "undefined"
    process.env.PAYMENT_VERIFIER_ADDRESS = "undefined";
    process.env.PAYMENT_VERIFIER_ADDRESS_FLARE = "undefined";
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    // Should be valid (warning only, not error) - app should start
    assert.equal(result.valid, true, `Expected valid=true but got errors: ${result.errors.join(", ")}`);
    assert.ok(result.warnings.some(w => w.includes("PAYMENT_VERIFIER_ADDRESS")),
      `Expected warning about PAYMENT_VERIFIER_ADDRESS`);
    assert.ok(!result.errors.some(e => e.includes("PAYMENT_VERIFIER_ADDRESS")),
      `Should NOT error on string "undefined", got: ${result.errors.join(", ")}`);
  });

  it("should treat empty string as unset for PAYMENT_VERIFIER_ADDRESS", async () => {
    process.env.NODE_ENV = "production";
    process.env.FLARE_NETWORK = "flare";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    process.env.VERIFIER_API_KEY = "valid-api-key-uuid";
    process.env.PRIVATE_KEY_FLARE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    process.env.PAYMENT_VERIFIER_ADDRESS = "";
    process.env.PAYMENT_VERIFIER_ADDRESS_FLARE = "";
    
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    
    assert.equal(result.valid, true, `Expected valid=true but got errors: ${result.errors.join(", ")}`);
  });

  it("isEffectivelyUnset should detect undefined-like values", async () => {
    const { isEffectivelyUnset } = await import("../src/env-validation.js");
    
    assert.equal(isEffectivelyUnset(undefined), true);
    assert.equal(isEffectivelyUnset(""), true);
    assert.equal(isEffectivelyUnset("undefined"), true);
    assert.equal(isEffectivelyUnset("0x1234567890AbcdEF1234567890abcdef12345678"), false);
    assert.equal(isEffectivelyUnset("some-value"), false);
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

describe("User Store", () => {
  it("should support subscription status fields", async () => {
    const { userStore } = await import("../src/user-store.js");
    const { hash } = await import("bcryptjs");
    
    const email = `test-${Date.now()}@example.com`;
    const passwordHash = await hash("password", 10);
    const user = userStore.create(email, passwordHash);
    
    assert.equal(user.tier, "free");
    assert.equal(user.subscriptionStatus, "none");
    assert.equal(user.stripeSubscriptionId, "");
    
    userStore.update(user.id, {
      tier: "paid",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_test123",
      stripeSubscriptionId: "sub_test123",
    });
    
    const updated = userStore.findById(user.id);
    assert.ok(updated);
    assert.equal(updated.tier, "paid");
    assert.equal(updated.subscriptionStatus, "active");
    assert.equal(updated.stripeCustomerId, "cus_test123");
    assert.equal(updated.stripeSubscriptionId, "sub_test123");
    
    // Test findByStripeCustomerId
    const found = userStore.findByStripeCustomerId("cus_test123");
    assert.ok(found);
    assert.equal(found.id, user.id);
    
    // Cleanup
    userStore.delete(user.id);
  });

  it("should downgrade user on subscription deletion", async () => {
    const { userStore } = await import("../src/user-store.js");
    const { hash } = await import("bcryptjs");
    
    const email = `test-downgrade-${Date.now()}@example.com`;
    const passwordHash = await hash("password", 10);
    const user = userStore.create(email, passwordHash);
    
    // Simulate active subscription
    userStore.update(user.id, {
      tier: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_downgrade_test",
      stripeSubscriptionId: "sub_downgrade_test",
    });
    
    // Simulate cancellation
    userStore.update(user.id, {
      tier: "free",
      subscriptionStatus: "canceled",
      stripeSubscriptionId: "",
    });
    
    const downgraded = userStore.findById(user.id);
    assert.ok(downgraded);
    assert.equal(downgraded.tier, "free");
    assert.equal(downgraded.subscriptionStatus, "canceled");
    
    // Cleanup
    userStore.delete(user.id);
  });

  it("should handle past_due status", async () => {
    const { userStore } = await import("../src/user-store.js");
    const { hash } = await import("bcryptjs");
    
    const email = `test-pastdue-${Date.now()}@example.com`;
    const passwordHash = await hash("password", 10);
    const user = userStore.create(email, passwordHash);
    
    userStore.update(user.id, {
      tier: "paid",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_pastdue_test",
    });
    
    // Simulate payment failure
    userStore.update(user.id, { subscriptionStatus: "past_due" });
    
    let updated = userStore.findById(user.id);
    assert.ok(updated);
    assert.equal(updated.tier, "paid"); // Tier preserved during grace period
    assert.equal(updated.subscriptionStatus, "past_due");
    
    // Simulate successful payment
    userStore.update(user.id, { subscriptionStatus: "active" });
    
    updated = userStore.findById(user.id);
    assert.ok(updated);
    assert.equal(updated.subscriptionStatus, "active");
    
    // Cleanup
    userStore.delete(user.id);
  });
});

describe("Billing Configuration", () => {
  it("should export TIER_PRODUCTS with correct lookup keys", async () => {
    const { TIER_PRODUCTS } = await import("../src/billing.js");
    
    assert.ok(TIER_PRODUCTS.paid);
    assert.ok(TIER_PRODUCTS.pro);
    assert.equal(TIER_PRODUCTS.paid.lookupKey, "xrplink_paid");
    assert.equal(TIER_PRODUCTS.pro.lookupKey, "xrplink_pro");
    assert.equal(TIER_PRODUCTS.paid.unitAmount, 2900);
    assert.equal(TIER_PRODUCTS.pro.unitAmount, 9900);
  });

  it("should report automatic tax setting", async () => {
    const { isAutomaticTaxEnabled } = await import("../src/billing.js");
    
    // Default is false
    assert.equal(isAutomaticTaxEnabled(), false);
  });
});

describe("Attestation Quota", () => {
  it("should have default limits matching spec (free=0, paid=5, pro=25)", async () => {
    const { ATTESTATION_LIMITS } = await import("../src/attestation-quota.js");
    
    assert.equal(ATTESTATION_LIMITS.free, 0);
    assert.equal(ATTESTATION_LIMITS.paid, 5);
    assert.equal(ATTESTATION_LIMITS.pro, 25);
  });

  it("should generate correct month key format YYYY-MM", async () => {
    const { getCurrentMonthKey } = await import("../src/attestation-quota.js");
    
    const monthKey = getCurrentMonthKey();
    assert.match(monthKey, /^\d{4}-\d{2}$/);
    
    const now = new Date();
    const expectedYear = now.getUTCFullYear();
    const expectedMonth = String(now.getUTCMonth() + 1).padStart(2, "0");
    assert.equal(monthKey, `${expectedYear}-${expectedMonth}`);
  });

  it("should calculate reset date as first of next month UTC", async () => {
    const { getMonthResetDate } = await import("../src/attestation-quota.js");
    
    const resetDate = getMonthResetDate();
    assert.equal(resetDate.getUTCDate(), 1);
    assert.equal(resetDate.getUTCHours(), 0);
    assert.equal(resetDate.getUTCMinutes(), 0);
    
    const now = new Date();
    if (now.getUTCMonth() === 11) {
      assert.equal(resetDate.getUTCMonth(), 0);
      assert.equal(resetDate.getUTCFullYear(), now.getUTCFullYear() + 1);
    } else {
      assert.equal(resetDate.getUTCMonth(), now.getUTCMonth() + 1);
      assert.equal(resetDate.getUTCFullYear(), now.getUTCFullYear());
    }
  });

  it("should allow attestation when under quota", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const result = checkQuota("paid", 3);
    assert.equal(result.allowed, true);
    assert.equal(result.used, 3);
    assert.equal(result.limit, 5);
    assert.equal(result.remaining, 2);
  });

  it("should deny attestation when at quota limit", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const result = checkQuota("paid", 5);
    assert.equal(result.allowed, false);
    assert.equal(result.used, 5);
    assert.equal(result.limit, 5);
    assert.equal(result.remaining, 0);
  });

  it("should deny attestation when over quota limit", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const result = checkQuota("paid", 10);
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
  });

  it("should always deny free tier (limit=0)", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const result = checkQuota("free", 0);
    assert.equal(result.allowed, false);
    assert.equal(result.limit, 0);
  });

  it("should allow up to 25 for pro tier", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const atLimit = checkQuota("pro", 24);
    assert.equal(atLimit.allowed, true);
    
    const overLimit = checkQuota("pro", 25);
    assert.equal(overLimit.allowed, false);
  });

  it("should build error with correct message and upgrade URL", async () => {
    const { checkQuota, buildQuotaExceededError } = await import("../src/attestation-quota.js");
    
    const result = checkQuota("paid", 5);
    const error = buildQuotaExceededError(result);
    
    assert.equal(error.code, "QUOTA_EXCEEDED");
    assert.ok(error.message.includes("Paid"));
    assert.ok(error.message.includes("5"));
    assert.ok(error.message.includes("Pro"));
    assert.equal(error.upgradeUrl, "/pricing");
    assert.equal(error.tier, "paid");
    assert.equal(error.limit, 5);
    assert.equal(error.used, 5);
    assert.ok(error.resetDate);
  });
});

describe("Attestation Usage Tracking", () => {
  it("should track and increment usage per API key", async () => {
    const { store } = await import("../src/store.js");
    
    const testKey = "test_quota_" + Date.now();
    
    const initial = await store.getAttestationUsage(testKey);
    assert.equal(initial, 0);
    
    const after1 = await store.incrementAttestationUsage(testKey);
    assert.equal(after1, 1);
    
    const after2 = await store.incrementAttestationUsage(testKey);
    assert.equal(after2, 2);
    
    const current = await store.getAttestationUsage(testKey);
    assert.equal(current, 2);
  });

  it("should track usage separately per API key", async () => {
    const { store } = await import("../src/store.js");
    
    const key1 = "test_key1_" + Date.now();
    const key2 = "test_key2_" + Date.now();
    
    await store.incrementAttestationUsage(key1);
    await store.incrementAttestationUsage(key1);
    await store.incrementAttestationUsage(key2);
    
    const usage1 = await store.getAttestationUsage(key1);
    const usage2 = await store.getAttestationUsage(key2);
    
    assert.equal(usage1, 2);
    assert.equal(usage2, 1);
  });
});
