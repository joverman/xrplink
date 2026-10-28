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
    process.env.FLARE_NETWORK = "flare";
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
    process.env.FLARE_NETWORK = "flare";
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

  it("should warn when ADMIN_API_KEY is unset", async () => {
    process.env.NODE_ENV = "production";
    process.env.FLARE_NETWORK = "flare";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    delete process.env.ADMIN_API_KEY;

    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();

    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((w) => w.includes("ADMIN_API_KEY")));
    assert.ok(result.warnings.some((w) => w.includes("X-Admin-Key")));
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

  it("refuses NODE_ENV=production unless FLARE_NETWORK is flare", async () => {
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    process.env.FLARE_NETWORK = "coston2";
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("FLARE_NETWORK") && e.includes("flare")));
  });

  it("allows coston2 when NODE_ENV is staging", async () => {
    process.env.NODE_ENV = "staging";
    process.env.SESSION_SECRET = "valid-secret-32-chars-minimum!!!";
    process.env.FLARE_NETWORK = "coston2";
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_REGION;
    const { validateEnv } = await import("../src/env-validation.js");
    const result = validateEnv();
    assert.equal(result.valid, true, result.errors.join(", "));
    assert.ok(!result.errors.some((e) => e.includes("FLARE_NETWORK")));
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
    assert.equal(user.sessionVersion, 1);
    
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
  it("should have default limits matching spec (free=0, paid=20, pro=100)", async () => {
    const { ATTESTATION_LIMITS } = await import("../src/attestation-quota.js");
    
    assert.equal(ATTESTATION_LIMITS.free, 0);
    assert.equal(ATTESTATION_LIMITS.paid, 20);
    assert.equal(ATTESTATION_LIMITS.pro, 100);
  });

  it("should generate billing period key from period start timestamp", async () => {
    const { getBillingPeriodKey } = await import("../src/attestation-quota.js");
    
    const period = { start: 1698796800, end: 1701388800 }; // Nov 1 - Dec 1, 2023
    const key = getBillingPeriodKey(period);
    assert.equal(key, "1698796800");
  });

  it("should calculate fallback billing period based on account creation date", async () => {
    const { getFallbackBillingPeriod } = await import("../src/attestation-quota.js");
    
    // Test with account created on the 15th
    const created = new Date("2023-03-15T10:00:00Z");
    const period = getFallbackBillingPeriod(created);
    
    // Period should be anchored to day 15
    const periodStartDate = new Date(period.start * 1000);
    assert.equal(periodStartDate.getUTCDate(), 15);
    
    // Period end should be ~30 days later (same day next month)
    const periodEndDate = new Date(period.end * 1000);
    assert.equal(periodEndDate.getUTCDate(), 15);
    
    // Start and end should be roughly 30 days apart
    const durationDays = (period.end - period.start) / 86400;
    assert.ok(durationDays >= 28 && durationDays <= 31, `Duration was ${durationDays} days`);
  });

  it("should handle mid-month signup correctly", async () => {
    const { getFallbackBillingPeriod, getBillingPeriodKey } = await import("../src/attestation-quota.js");
    
    // User signs up on Oct 28
    const signupDate = new Date("2023-10-28T14:30:00Z");
    const period = getFallbackBillingPeriod(signupDate);
    
    const startDate = new Date(period.start * 1000);
    assert.equal(startDate.getUTCDate(), 28);
    
    // The period key should be stable for the whole period
    const key1 = getBillingPeriodKey(period);
    
    // Simulate checking again later in the same period
    const period2 = getFallbackBillingPeriod(signupDate);
    const key2 = getBillingPeriodKey(period2);
    
    assert.equal(key1, key2, "Period key should be stable within the same billing period");
  });

  it("should allow attestation when under quota with billing period", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const period = { start: 1698796800, end: 1701388800 };
    const result = checkQuota("paid", 3, period);
    
    assert.equal(result.allowed, true);
    assert.equal(result.used, 3);
    assert.equal(result.limit, 20);
    assert.equal(result.remaining, 17);
    assert.ok(result.periodKey);
  });

  it("should deny attestation when at quota limit", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const period = { start: 1698796800, end: 1701388800 };
    const result = checkQuota("paid", 20, period);
    
    assert.equal(result.allowed, false);
    assert.equal(result.used, 20);
    assert.equal(result.limit, 20);
    assert.equal(result.remaining, 0);
  });

  it("should always deny free tier (limit=0)", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const period = { start: 1698796800, end: 1701388800 };
    const result = checkQuota("free", 0, period);
    
    assert.equal(result.allowed, false);
    assert.equal(result.limit, 0);
  });

  it("should allow up to 100 for pro tier", async () => {
    const { checkQuota } = await import("../src/attestation-quota.js");
    
    const period = { start: 1698796800, end: 1701388800 };
    
    const atLimit = checkQuota("pro", 99, period);
    assert.equal(atLimit.allowed, true);
    
    const overLimit = checkQuota("pro", 100, period);
    assert.equal(overLimit.allowed, false);
  });

  it("should show customer reset date in error message", async () => {
    const { checkQuota, buildQuotaExceededError, formatResetDate } = await import("../src/attestation-quota.js");
    
    // Customer billing period ends on Nov 28, 2023
    const period = { start: 1698451200, end: 1701129600 }; // Oct 28 - Nov 28
    const result = checkQuota("paid", 20, period);
    const error = buildQuotaExceededError(result);
    
    assert.equal(error.code, "QUOTA_EXCEEDED");
    assert.ok(error.message.includes("Paid"));
    assert.ok(error.message.includes("20"));
    assert.ok(error.message.includes("Upgrade to Pro"), "Paid over-quota should prompt upgrade to Pro");
    assert.ok(error.message.toLowerCase().includes("pay-per-use"), "Should mention buying an extra attestation");
    assert.equal(error.resetDate, formatResetDate(period.end));
    assert.ok(error.message.includes(error.resetDate), "Error message should include customer's reset date");
    assert.equal(error.upgradeUrl, "/pricing");
  });

  it("should handle upgrade from paid to pro mid-period (usage carries over)", async () => {
    const { checkQuota, ATTESTATION_LIMITS } = await import("../src/attestation-quota.js");
    
    const period = { start: 1698796800, end: 1701388800 };
    
    // User was on paid, used 3 attestations
    const beforeUpgrade = checkQuota("paid", 3, period);
    assert.equal(beforeUpgrade.allowed, true);
    assert.equal(beforeUpgrade.remaining, 17); // 20 - 3 = 17
    
    // User upgrades to pro - same period, same usage count, but higher limit
    const afterUpgrade = checkQuota("pro", 3, period);
    assert.equal(afterUpgrade.allowed, true);
    assert.equal(afterUpgrade.remaining, 97); // 100 - 3 = 97
    assert.equal(afterUpgrade.limit, ATTESTATION_LIMITS.pro);
    
    // The new higher limit applies immediately
    assert.ok(afterUpgrade.remaining > beforeUpgrade.remaining);
  });
});

describe("Attestation Usage Tracking", () => {
  it("should track and increment usage per API key per billing period", async () => {
    const { store } = await import("../src/store.js");
    
    const testKey = "test_quota_" + Date.now();
    const periodKey = "1698796800"; // Example billing period start
    
    const initial = await store.getAttestationUsage(testKey, periodKey);
    assert.equal(initial, 0);
    
    const after1 = await store.incrementAttestationUsage(testKey, periodKey);
    assert.equal(after1, 1);
    
    const after2 = await store.incrementAttestationUsage(testKey, periodKey);
    assert.equal(after2, 2);
    
    const current = await store.getAttestationUsage(testKey, periodKey);
    assert.equal(current, 2);
  });

  it("should track usage separately per API key", async () => {
    const { store } = await import("../src/store.js");
    
    const key1 = "test_key1_" + Date.now();
    const key2 = "test_key2_" + Date.now();
    const periodKey = "1698796800";
    
    await store.incrementAttestationUsage(key1, periodKey);
    await store.incrementAttestationUsage(key1, periodKey);
    await store.incrementAttestationUsage(key2, periodKey);
    
    const usage1 = await store.getAttestationUsage(key1, periodKey);
    const usage2 = await store.getAttestationUsage(key2, periodKey);
    
    assert.equal(usage1, 2);
    assert.equal(usage2, 1);
  });

  it("should track usage separately per billing period (period rollover)", async () => {
    const { store } = await import("../src/store.js");
    
    const testKey = "test_period_rollover_" + Date.now();
    const period1 = "1698796800"; // Nov 1
    const period2 = "1701388800"; // Dec 1 (new billing period)
    
    // Use quota in first period
    await store.incrementAttestationUsage(testKey, period1);
    await store.incrementAttestationUsage(testKey, period1);
    await store.incrementAttestationUsage(testKey, period1);
    
    const usagePeriod1 = await store.getAttestationUsage(testKey, period1);
    assert.equal(usagePeriod1, 3);
    
    // New period should start fresh (quota reset)
    const usagePeriod2 = await store.getAttestationUsage(testKey, period2);
    assert.equal(usagePeriod2, 0, "New billing period should have zero usage");
    
    // Usage in new period
    await store.incrementAttestationUsage(testKey, period2);
    const usagePeriod2After = await store.getAttestationUsage(testKey, period2);
    assert.equal(usagePeriod2After, 1);
    
    // Old period usage should be unchanged
    const usagePeriod1After = await store.getAttestationUsage(testKey, period1);
    assert.equal(usagePeriod1After, 3, "Old period usage should be preserved");
  });
});
