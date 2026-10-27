import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { ApiKey } from "./types.js";
import { isEffectivelyUnset } from "./env-validation.js";

const PLAINTEXT_PREFIX = "sk_live_";

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isPlaintextApiKey(value: string): boolean {
  return value.startsWith(PLAINTEXT_PREFIX) && value.length > 20;
}

export function isApiKeyHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/** Normalize a presented or stored key id to the SHA-256 lookup id. */
export function apiKeyLookupId(value: string): string {
  if (isApiKeyHash(value)) return value;
  if (isPlaintextApiKey(value)) return hashApiKey(value);
  return value;
}

export function apiKeyDisplayParts(plaintext: string): { keyPrefix: string; keyLast4: string } {
  return {
    keyPrefix: plaintext.slice(0, 12),
    keyLast4: plaintext.slice(-4),
  };
}

export function maskApiKey(prefix: string, last4: string): string {
  return `${prefix}…${last4}`;
}

export function generateApiKeyPlaintext(): string {
  return PLAINTEXT_PREFIX + randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

export function toPublicApiKey(
  record: ApiKey,
  opts?: { includeId?: boolean }
): Record<string, unknown> {
  const prefix = record.keyPrefix || PLAINTEXT_PREFIX;
  const last4 = record.keyLast4 || "****";
  const body: Record<string, unknown> = {
    key: maskApiKey(prefix, last4),
    keyPrefix: prefix,
    keyLast4: last4,
    name: record.name,
    tier: record.tier,
    active: record.active,
    usageCount: record.usageCount,
    createdAt: record.createdAt,
  };
  if (opts?.includeId && isApiKeyHash(record.key)) {
    body.id = record.key;
  }
  return body;
}

export function getAdminApiKey(): string {
  const value = process.env.ADMIN_API_KEY;
  if (isEffectivelyUnset(value)) return "";
  return value as string;
}

export function isAdminApiKeyConfigured(): boolean {
  return getAdminApiKey().length > 0;
}

/** Constant-time compare of two strings (hashes first so lengths do not short-circuit). */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
