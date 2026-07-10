import { Request, Response, NextFunction } from "express";
import { store } from "./store.js";
import { config } from "./config.js";
import { ApiError } from "./types.js";

/** Require a valid API key on the request. */
export function requireApiKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"] as string;
  if (!key) {
    return _res.status(401).json({ error: "X-API-Key header required", code: "MISSING_API_KEY" } satisfies ApiError);
  }

  const apiKey = store.getApiKey(key);
  if (!apiKey || !apiKey.active) {
    return _res.status(403).json({ error: "Invalid or deactivated API key", code: "INVALID_API_KEY" } satisfies ApiError);
  }

  (req as any).apiKey = apiKey;
  store.incrementApiKeyUsage(key);

  const limit = config.rateLimits[apiKey.tier];
  if (limit !== Infinity) {
    const windowKey = `rl:${key}:${Math.floor(Date.now() / 60000)}`;
    const hits = rateLimitWindows.get(windowKey) || 0;
    if (hits >= limit) {
      return _res.status(429).json({ error: "Rate limit exceeded", code: "RATE_LIMITED", details: `Limit: ${limit} req/min (${apiKey.tier} tier)` } satisfies ApiError);
    }
    rateLimitWindows.set(windowKey, hits + 1);
    setTimeout(() => rateLimitWindows.delete(windowKey), 60000).unref();
  }

  next();
}

const rateLimitWindows = new Map<string, number>();
