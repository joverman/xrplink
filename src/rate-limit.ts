/**
 * Small in-memory fixed-window limiter keyed on req.ip (TRUST_PROXY + CF-Connecting-IP).
 * Used for verify, auth, contact, 402 quoting, and receipt XRPL lookups.
 */
import { Request, Response, NextFunction } from "express";
import { formatError } from "./mcp/errors.js";

interface WindowHit {
  count: number;
  resetAt: number;
}

const windows = new Map<string, WindowHit>();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return fallback;
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Production limits are tight; tests get headroom so existing suites stay green. */
export const LIMITS = {
  verifyIp: envInt("RL_VERIFY_IP", isTestEnv() ? 500 : 20),
  verifyKey: envInt("RL_VERIFY_KEY", isTestEnv() ? 500 : 30),
  signupIp: envInt("RL_SIGNUP_IP", isTestEnv() ? 80 : 8),
  loginIp: envInt("RL_LOGIN_IP", isTestEnv() ? 80 : 15),
  resetIp: envInt("RL_RESET_IP", isTestEnv() ? 40 : 5),
  resetEmail: envInt("RL_RESET_EMAIL", isTestEnv() ? 20 : 3),
  contactIp: envInt("RL_CONTACT_IP", isTestEnv() ? 40 : 5),
  contactEmail: envInt("RL_CONTACT_EMAIL", isTestEnv() ? 20 : 3),
  receiptIp: envInt("RL_RECEIPT_IP", isTestEnv() ? 200 : 30),
};

export const WINDOW_MS = {
  minute: 60_000,
  hour: 60 * 60_000,
};

export function authWindowMs(): number {
  return isTestEnv() ? WINDOW_MS.minute : WINDOW_MS.hour;
}

export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  if (Array.isArray(cf) && cf[0]) return String(cf[0]).trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; retryAfterSec: number; remaining: number } {
  const now = Date.now();
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSec: Math.ceil(windowMs / 1000), remaining: Math.max(0, limit - 1) };
  }
  if (existing.count >= limit) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  existing.count += 1;
  return {
    allowed: true,
    retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    remaining: Math.max(0, limit - existing.count),
  };
}

export function resetRateLimitsForTests(): void {
  windows.clear();
}

export function rateLimit(opts: {
  name: string;
  limit: number;
  windowMs: number;
  key?: (req: Request) => string;
}): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const id = opts.key ? opts.key(req) : `${opts.name}:${clientIp(req)}`;
    const result = consumeRateLimit(id, opts.limit, opts.windowMs);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSec));
      return res.status(429).json(formatError("RATE_LIMITED", { limit: String(opts.limit), window: opts.name }));
    }
    next();
  };
}

export function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

/** Combined IP + optional email buckets; fails closed on the first exhausted window. */
export function rateLimitIpAndEmail(opts: {
  name: string;
  ipLimit: number;
  emailLimit: number;
  windowMs: number;
  emailFrom: (req: Request) => unknown;
}): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const ip = clientIp(req);
    const ipHit = consumeRateLimit(`${opts.name}-ip:${ip}`, opts.ipLimit, opts.windowMs);
    if (!ipHit.allowed) {
      res.setHeader("Retry-After", String(ipHit.retryAfterSec));
      return res.status(429).json(formatError("RATE_LIMITED", { limit: String(opts.ipLimit), window: opts.name }));
    }
    const email = normalizeEmail(opts.emailFrom(req));
    if (email) {
      const emailHit = consumeRateLimit(`${opts.name}-email:${email}`, opts.emailLimit, opts.windowMs);
      if (!emailHit.allowed) {
        res.setHeader("Retry-After", String(emailHit.retryAfterSec));
        return res.status(429).json(formatError("RATE_LIMITED", { limit: String(opts.emailLimit), window: opts.name }));
      }
    }
    next();
  };
}

export function checkVerifyRateLimit(ip: string, apiKey?: string): { allowed: boolean; retryAfterSec: number } {
  const ipHit = consumeRateLimit(`verify-ip:${ip}`, LIMITS.verifyIp, WINDOW_MS.minute);
  if (!ipHit.allowed) return ipHit;
  if (apiKey) {
    const keyHit = consumeRateLimit(`verify-key:${apiKey}`, LIMITS.verifyKey, WINDOW_MS.minute);
    if (!keyHit.allowed) return keyHit;
  }
  return { allowed: true, retryAfterSec: 0 };
}
