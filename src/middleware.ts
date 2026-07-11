import { Request, Response, NextFunction } from "express";
import { store } from "./store.js";
import { config } from "./config.js";
import { formatError } from "./mcp/errors.js";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"] as string;
  if (!key) {
    return res.status(401).json(formatError("MISSING_API_KEY"));
  }

  const apiKey = store.getApiKey(key);
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

const rateLimitWindows = new Map<string, number>();
