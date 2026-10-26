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
 * Billing period information for quota calculation.
 */
export interface BillingPeriod {
  /** Period start as Unix timestamp (seconds) */
  start: number;
  /** Period end as Unix timestamp (seconds) */
  end: number;
}

/**
 * Get the billing period key for storage.
 * Uses the period start timestamp to uniquely identify the period.
 */
export function getBillingPeriodKey(period: BillingPeriod): string {
  return String(period.start);
}

/**
 * Calculate a fallback billing period for accounts without Stripe subscription data.
 * Uses 30-day rolling periods anchored to the account creation date.
 * 
 * For example, if account was created on the 15th:
 * - Period 1: 15th of month N to 14th of month N+1
 * - Period 2: 15th of month N+1 to 14th of month N+2
 * etc.
 * 
 * @param accountCreatedAt - ISO string or Date of account creation
 * @returns Current billing period based on account creation anchor
 */
export function getFallbackBillingPeriod(accountCreatedAt: string | Date): BillingPeriod {
  const created = new Date(accountCreatedAt);
  const now = new Date();
  
  // Get the day of month when account was created (1-31)
  const anchorDay = created.getUTCDate();
  
  // Find the current period start
  let periodStart = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    anchorDay,
    0, 0, 0, 0
  ));
  
  // If we haven't reached the anchor day this month, go back to previous month
  if (now < periodStart) {
    periodStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - 1,
      anchorDay,
      0, 0, 0, 0
    ));
  }
  
  // Period end is the same day next month
  const periodEnd = new Date(Date.UTC(
    periodStart.getUTCFullYear(),
    periodStart.getUTCMonth() + 1,
    anchorDay,
    0, 0, 0, 0
  ));
  
  return {
    start: Math.floor(periodStart.getTime() / 1000),
    end: Math.floor(periodEnd.getTime() / 1000),
  };
}

/**
 * Format a Unix timestamp as YYYY-MM-DD for display.
 */
export function formatResetDate(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toISOString().split("T")[0];
}

export interface QuotaCheckResult {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetDate: string;
  tier: Tier;
  periodKey: string;
}

/**
 * Check if an attestation is allowed for the given tier and current usage.
 * 
 * @param tier - User's subscription tier
 * @param currentUsage - Number of attestations used in the current billing period
 * @param billingPeriod - The user's current billing period
 */
export function checkQuota(
  tier: Tier,
  currentUsage: number,
  billingPeriod: BillingPeriod
): QuotaCheckResult {
  const limit = ATTESTATION_LIMITS[tier];
  const resetDate = formatResetDate(billingPeriod.end);
  const remaining = Math.max(0, limit - currentUsage);
  const periodKey = getBillingPeriodKey(billingPeriod);
  
  return {
    allowed: currentUsage < limit,
    used: currentUsage,
    limit,
    remaining,
    resetDate,
    tier,
    periodKey,
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
    message: `Monthly attestation limit reached. Your ${tierName} plan allows ${result.limit} mainnet attestation${result.limit === 1 ? "" : "s"} per billing period. Limit resets on ${result.resetDate}. Upgrade to ${nextTier} for a higher limit.`,
    tier: result.tier,
    limit: result.limit,
    used: result.used,
    resetDate: result.resetDate,
    upgradeUrl: "/pricing",
  };
}

// Legacy function for backward compatibility (deprecated)
export function getCurrentMonthKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
