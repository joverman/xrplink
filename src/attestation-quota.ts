import { Tier } from "./types.js";

/**
 * Monthly mainnet attestation limits per tier.
 * Override via environment variables:
 *   ATTESTATION_LIMIT_FREE=0
 *   ATTESTATION_LIMIT_PAID=5
 *   ATTESTATION_LIMIT_PRO=25
 */
export const ATTESTATION_LIMITS: Record<Tier, number> = {
  free: parseInt(process.env.ATTESTATION_LIMIT_FREE || "0", 10),
  paid: parseInt(process.env.ATTESTATION_LIMIT_PAID || "5", 10),
  pro: parseInt(process.env.ATTESTATION_LIMIT_PRO || "25", 10),
};

/**
 * Returns the current billing month key in format "YYYY-MM" (UTC).
 * Using calendar month since we don't track Stripe billing anchors locally.
 */
export function getCurrentMonthKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Returns the UTC timestamp when the current billing month resets.
 */
export function getMonthResetDate(): Date {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  
  return new Date(Date.UTC(nextYear, nextMonth, 1, 0, 0, 0));
}

/**
 * Format reset date for user display.
 */
export function formatResetDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export interface QuotaCheckResult {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetDate: string;
  tier: Tier;
}

/**
 * Check if an attestation is allowed for the given tier and current usage.
 */
export function checkQuota(tier: Tier, currentUsage: number): QuotaCheckResult {
  const limit = ATTESTATION_LIMITS[tier];
  const resetDate = formatResetDate(getMonthResetDate());
  const remaining = Math.max(0, limit - currentUsage);
  
  return {
    allowed: currentUsage < limit,
    used: currentUsage,
    limit,
    remaining,
    resetDate,
    tier,
  };
}

/**
 * Error details for quota exceeded response.
 */
export interface QuotaExceededError {
  code: "QUOTA_EXCEEDED";
  message: string;
  tier: Tier;
  limit: number;
  used: number;
  resetDate: string;
  upgradeUrl: string;
}

/**
 * Build a quota exceeded error response.
 */
export function buildQuotaExceededError(result: QuotaCheckResult): QuotaExceededError {
  const tierName = result.tier.charAt(0).toUpperCase() + result.tier.slice(1);
  const nextTier = result.tier === "free" ? "Paid ($29/mo)" : "Pro ($99/mo)";
  
  return {
    code: "QUOTA_EXCEEDED",
    message: `Monthly attestation limit reached. Your ${tierName} plan allows ${result.limit} mainnet attestation${result.limit === 1 ? "" : "s"} per month. Limit resets on ${result.resetDate} (UTC). Upgrade to ${nextTier} for a higher limit.`,
    tier: result.tier,
    limit: result.limit,
    used: result.used,
    resetDate: result.resetDate,
    upgradeUrl: "/pricing",
  };
}
