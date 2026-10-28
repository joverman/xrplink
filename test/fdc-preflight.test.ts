/**
 * FDC XRPPayment preflight, verifier error mapping, and quota safety.
 *
 * The hosted Flare verifier returns INVALID: TRANSACTION DOES NOT EXIST for
 * Payments older than ~14 days (IXRPPayment lutlimit 0x127500). Failed
 * prepares must not consume monthly attestation quota.
 */
import assert from "node:assert/strict";
import { describe, it, before, afterEach } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLARE_NETWORK = "flare";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "xrplink-fdc-"));
process.env.SESSION_SECRET = "test-secret-for-testing-1234567890";
process.env.X402_ENABLED = "false";
delete process.env.X402_PAY_TO_ADDRESS;

import {
  FDC_XRP_PAYMENT_LUT_LIMIT_SECONDS,
  FDC_XRP_PAYMENT_LUT_LIMIT_DAYS,
  RIPPLE_EPOCH,
  preflightXrplPayment,
  setXrplLookupForTests,
  setXrplNowForTests,
  type XrplTxResult,
} from "../src/xrpl-tx.js";
import { formatError } from "../src/mcp/errors.js";

const { networkConfigs, config } = await import("../src/config.js");
const { FdcVerifierError } = await import("../src/fdc-service.js");
const { attestXrpPayment, setFdcMocksForTests } = await import("../src/attest.js");
const { store } = await import("../src/store.js");
const { getFallbackBillingPeriod, getBillingPeriodKey } = await import("../src/attestation-quota.js");

const FIXED_NOW_MS = Date.UTC(2026, 9, 27, 12, 0, 0); // 2026-10-27

function rippleDateDaysAgo(days: number, nowMs = FIXED_NOW_MS): number {
  return Math.floor(nowMs / 1000) - RIPPLE_EPOCH - Math.round(days * 86400);
}

function nativePayment(daysAgo: number): XrplTxResult {
  return {
    Account: "rSourceAccountXXXXXXXXXXXXXXXXXXX",
    Destination: "rDestAccountXXXXXXXXXXXXXXXXXXXXX",
    Amount: "1000000",
    TransactionType: "Payment",
    date: rippleDateDaysAgo(daysAgo),
    meta: { TransactionResult: "tesSUCCESS" },
    validated: true,
  };
}

function generateTestTxHash(suffix: string): string {
  const timestamp = Date.now().toString(16).toUpperCase();
  const random = Math.random().toString(16).slice(2).toUpperCase();
  const suffixHex = Buffer.from(suffix).toString("hex").toUpperCase();
  return (timestamp + random + suffixHex).padEnd(64, "0").slice(0, 64);
}

describe("FDC XRPPayment lookback and mainnet defaults", () => {
  it("uses IXRPPayment lutlimit 0x127500 (14 days)", () => {
    assert.equal(FDC_XRP_PAYMENT_LUT_LIMIT_SECONDS, 0x127500);
    assert.equal(FDC_XRP_PAYMENT_LUT_LIMIT_SECONDS, 1_209_600);
    assert.equal(FDC_XRP_PAYMENT_LUT_LIMIT_DAYS, 14);
  });

  it("points flare at the mainnet XRP verifier, not Coston/testXRP", () => {
    assert.equal(config.network, "flare");
    assert.equal(networkConfigs.flare.sourceId, "XRP");
    assert.equal(networkConfigs.flare.chainId, 14);
    assert.equal(networkConfigs.flare.verifierBaseUrl, "https://fdc-verifiers-mainnet.flare.network");
    assert.equal(networkConfigs.flare.fdcHub, "0xc25c749DC27Efb1864Cb3DADa8845B7687eB2d44");
    assert.equal(networkConfigs.flare.fdcVerification, "0x9394c7A36b3Da8de1b4F27cdD0a554dA4Fa7132d");
    assert.equal(networkConfigs.coston2.fdcVerification, "0x906507E0B64bcD494Db73bd0459d1C667e14B933");
    assert.equal(networkConfigs.coston2.sourceId, "testXRP");
    assert.equal(networkConfigs.coston2.verifierBaseUrl, "https://fdc-verifiers-testnet.flare.network");
  });
});

describe("preflightXrplPayment", () => {
  before(() => {
    setXrplNowForTests(() => FIXED_NOW_MS);
  });

  afterEach(() => {
    setXrplLookupForTests(null);
    setXrplNowForTests(() => FIXED_NOW_MS);
  });

  it("returns TX_NOT_ON_LEDGER when XRPL has no such hash", async () => {
    setXrplLookupForTests(async () => ({ status: "not_found" }));
    const result = await preflightXrplPayment(generateTestTxHash("MISSING"));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "TX_NOT_ON_LEDGER");
      assert.equal(result.httpStatus, 404);
    }
  });

  it("skips rejection when every XRPL RPC is down", async () => {
    setXrplLookupForTests(async () => ({ status: "unavailable" }));
    const result = await preflightXrplPayment(generateTestTxHash("DOWN"));
    assert.equal(result.ok, true);
  });

  it("returns TX_NOT_PAYMENT for OfferCreate", async () => {
    setXrplLookupForTests(async () => ({
      status: "found",
      tx: { ...nativePayment(1), TransactionType: "OfferCreate" },
    }));
    const result = await preflightXrplPayment(generateTestTxHash("OFFER"));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "TX_NOT_PAYMENT");
      assert.equal(result.transactionType, "OfferCreate");
    }
  });

  it("returns TX_NOT_NATIVE_XRP for issued-currency Payments", async () => {
    setXrplLookupForTests(async () => ({
      status: "found",
      tx: {
        ...nativePayment(1),
        Amount: { currency: "USD", issuer: "rIssuer", value: "10" },
      },
    }));
    const result = await preflightXrplPayment(generateTestTxHash("IOU"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "TX_NOT_NATIVE_XRP");
  });

  it("returns TX_TOO_OLD for a Payment older than 14 days", async () => {
    setXrplLookupForTests(async () => ({ status: "found", tx: nativePayment(19.37) }));
    const result = await preflightXrplPayment("30817D99F29CB9D75F577EDD3898AF95C20E6AF452C5A04D508C8C0813CE8714");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "TX_TOO_OLD");
      assert.equal(result.windowDays, 14);
      assert.ok((result.ageDays || 0) > 14);
    }
  });

  it("accepts a native XRP Payment inside the 14-day window", async () => {
    setXrplLookupForTests(async () => ({ status: "found", tx: nativePayment(13.9) }));
    const result = await preflightXrplPayment(generateTestTxHash("RECENT"));
    assert.equal(result.ok, true);
  });
});

describe("attestXrpPayment error mapping and quota", { concurrency: false }, () => {
  afterEach(() => {
    setXrplLookupForTests(null);
    setXrplNowForTests(null);
    setFdcMocksForTests(null);
  });

  async function newPaidKey(label: string): Promise<string> {
    const created = await store.createApiKey(label, "paid");
    return created.key;
  }

  async function usage(paidKey: string): Promise<number> {
    const key = await store.getApiKey(paidKey);
    assert.ok(key);
    const period = getFallbackBillingPeriod(key.createdAt);
    return store.getAttestationUsage(paidKey, getBillingPeriodKey(period));
  }

  it("returns TX_TOO_OLD without creating an attestation or consuming quota", async () => {
    const paidKey = await newPaidKey("fdc-too-old");
    setXrplNowForTests(() => FIXED_NOW_MS);
    setXrplLookupForTests(async () => ({ status: "found", tx: nativePayment(19) }));
    const before = await usage(paidKey);
    const txHash = generateTestTxHash("OLD");

    const result = await attestXrpPayment({ txHash, apiKeyHeader: paidKey });

    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.httpStatus, 400);
      assert.equal(result.body.error, "TX_TOO_OLD");
      assert.match(String(result.body.message), /14-day/i);
      assert.equal(result.body.windowDays, 14);
    }
    assert.equal(await store.getByTxHash(txHash.replace(/^0x/i, "").toUpperCase()), undefined);
    assert.equal(await usage(paidKey), before);
  });

  it("maps verifier INVALID to VERIFIER_ERROR, not SUBMIT_FAILED, and does not consume quota", async () => {
    const paidKey = await newPaidKey("fdc-verifier-invalid");
    const before = await usage(paidKey);
    const txHash = generateTestTxHash("INVALID");

    setFdcMocksForTests({
      prepareRequest: async () => {
        throw new FdcVerifierError("Verifier returned non-VALID status: INVALID: TRANSACTION DOES NOT EXIST", {
          verifierStatus: "INVALID: TRANSACTION DOES NOT EXIST",
        });
      },
      submitRequest: async () => {
        throw new Error("FdcHub should not be called");
      },
      isAlreadyVerified: async () => false,
    });

    const result = await attestXrpPayment({ txHash, apiKeyHeader: paidKey });

    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.body.error, "VERIFIER_ERROR");
      assert.notEqual(result.body.error, "SUBMIT_FAILED");
      assert.match(String(result.body.details), /TRANSACTION DOES NOT EXIST/);
      assert.match(String(result.body.suggestedAction), /14 days/i);
    }
    assert.equal(await usage(paidKey), before);
  });

  it("keeps SUBMIT_FAILED for actual FdcHub failures and does not consume quota", async () => {
    const paidKey = await newPaidKey("fdc-hub-fail");
    const before = await usage(paidKey);
    const txHash = generateTestTxHash("HUBFAIL");

    setFdcMocksForTests({
      prepareRequest: async () => "0xencoded",
      submitRequest: async () => {
        throw new Error("insufficient funds for gas");
      },
      isAlreadyVerified: async () => false,
    });

    const result = await attestXrpPayment({ txHash, apiKeyHeader: paidKey });

    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.body.error, "SUBMIT_FAILED");
      assert.equal(result.httpStatus, 500);
    }
    assert.equal(await usage(paidKey), before);
  });

  it("increments monthly quota only after a successful FDC submit", async () => {
    const paidKey = await newPaidKey("fdc-success");
    const before = await usage(paidKey);
    const txHash = generateTestTxHash("OK");

    setFdcMocksForTests({
      prepareRequest: async () => "0xencoded",
      submitRequest: async () => ({ roundId: 42, txHash: "0xfdc" }),
      isAlreadyVerified: async () => false,
    });

    const result = await attestXrpPayment({ txHash, apiKeyHeader: paidKey });

    assert.equal(result.kind, "ok");
    assert.equal(await usage(paidKey), before + 1);
  });
});

describe("error catalog copy", () => {
  it("describes the 14-day window on TX_TOO_OLD and VERIFIER_ERROR", () => {
    const tooOld = formatError("TX_TOO_OLD");
    assert.match(tooOld.message, /14-day/);
    assert.match(String(tooOld.suggestedAction), /14 days/);

    const verifier = formatError("VERIFIER_ERROR");
    assert.match(String(verifier.suggestedAction), /14 days/);

    const submit = formatError("SUBMIT_FAILED");
    assert.match(submit.message, /FdcHub/);
    assert.doesNotMatch(String(submit.suggestedAction), /transaction exists on the XRP Ledger/i);
  });
});
