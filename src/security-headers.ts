import { Request, Response, NextFunction } from "express";

/**
 * CSP allows same-origin plus inline script/style used by the dashboard,
 * docs, login, signup, landing, and pricing pages. Checkout is a top-level
 * redirect to Stripe, not an embedded script.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.removeHeader("X-Powered-By");
  next();
}
