import { Response, Request } from "express";

export const SESSION_COOKIE = "xrplink_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

export function setSessionCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === "production" || !!process.env.FLY_APP_NAME;
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    // In production use SameSite=None so the cookie survives the cross-site
    // Stripe Checkout redirect back to /dashboard?upgraded=... (Lax would be
    // dropped). Requires Secure, which is true in production. In local dev
    // (HTTP), fall back to Lax since None+!Secure is rejected by browsers.
    sameSite: isProd ? "none" : "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionToken(req: Request): string {
  const header = req.headers.cookie || "";
  if (!header) return "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return "";
}
