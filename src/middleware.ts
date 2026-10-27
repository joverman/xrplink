import { Request, Response, NextFunction } from "express";
import { store } from "./store.js";
import { config } from "./config.js";
import { formatError } from "./mcp/errors.js";
import { getUserFromToken } from "./auth.js";
import { getRequestToken, getSessionToken } from "./session.js";
import { getAdminApiKey, isAdminApiKeyConfigured, timingSafeEqualString } from "./api-keys.js";

export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"] as string;
  if (!key) {
    return res.status(401).json(formatError("MISSING_API_KEY"));
  }

  const apiKey = await store.getApiKey(key);
  if (!apiKey || !apiKey.active) {
    return res.status(403).json(formatError("INVALID_API_KEY"));
  }

  (req as any).apiKey = apiKey;
  store.incrementApiKeyUsage(key);

  const limit = config.rateLimits[apiKey.tier];
  if (limit !== Infinity) {
    const windowKey = `rl:${key}:${Math.floor(Date.now() / 60000)}`;
    const hits = rateLimitWindows.get(windowKey) || 0;
    if (hits >= limit) {
      return res.status(429).json(formatError("RATE_LIMITED", { tier: apiKey.tier, limit: String(limit) }));
    }
    rateLimitWindows.set(windowKey, hits + 1);
    setTimeout(() => rateLimitWindows.delete(windowKey), 60000).unref();
  }

  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = getRequestToken(req);
  if (!token) {
    return res.status(401).json(formatError("MISSING_AUTH"));
  }
  const user = getUserFromToken(token);
  if (!user) {
    return res.status(401).json(formatError("INVALID_AUTH"));
  }
  (req as any).user = user;
  next();
}

/** Cookie session only — Bearer tokens are not enough for CSRF-sensitive POSTs. */
export function requireSessionCookie(req: Request, res: Response, next: NextFunction) {
  const token = getSessionToken(req);
  if (!token) {
    return res.status(401).json(formatError("MISSING_AUTH"));
  }
  const user = getUserFromToken(token);
  if (!user) {
    return res.status(401).json(formatError("INVALID_AUTH"));
  }
  (req as any).user = user;
  next();
}

export function optionalUser(req: Request, _res: Response, next: NextFunction) {
  const token = getRequestToken(req);
  if (token) {
    const user = getUserFromToken(token);
    if (user) (req as any).user = user;
  }
  next();
}

/**
 * Dedicated operator credential. Customer API keys of any tier never pass.
 * Unset ADMIN_API_KEY: admin routes are hidden (404). Wrong/missing header: 403.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminApiKeyConfigured()) {
    return res.status(404).json(formatError("NOT_FOUND"));
  }
  const provided = req.headers["x-admin-key"];
  if (typeof provided !== "string" || !timingSafeEqualString(provided, getAdminApiKey())) {
    return res.status(403).json(formatError("FORBIDDEN"));
  }
  next();
}

function forwardedHost(req: Request): string {
  const xf = req.headers["x-forwarded-host"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim().toLowerCase();
  return (req.headers.host || "").toLowerCase();
}

export function isSameOriginRequest(req: Request): boolean {
  const host = forwardedHost(req);
  if (!host) return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin) {
    try {
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  const referer = req.headers.referer;
  if (typeof referer === "string" && referer) {
    try {
      return new URL(referer).host.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  return false;
}

/** CSRF defense-in-depth for cookie-authenticated state changes (SameSite=Lax). */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json(formatError("FORBIDDEN"));
  }
  next();
}

const rateLimitWindows = new Map<string, number>();
