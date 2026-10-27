import { Response, Request } from "express";

export const SESSION_COOKIE = "xrplink_session";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_TTL = "30d";

function isProdCookie(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.FLY_APP_NAME;
}

/**
 * First-party session cookie options.
 *
 * SameSite=Lax is correct for xrp-link.com: the cookie is sent on same-site
 * fetches and on top-level GET navigations (including the return from Stripe
 * Checkout). SameSite=None is for third-party cookies; Chrome's third-party
 * cookie deprecation and Safari ITP can drop those, which made sessions look
 * like they vanished after leaving the dashboard.
 */
export function sessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    secure: isProdCookie(),
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  };
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(res: Response) {
  const { maxAge: _maxAge, ...opts } = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE, opts);
}

export function getSessionToken(req: Request): string {
  const header = req.headers.cookie || "";
  if (!header) return "";
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName !== SESSION_COOKIE) continue;
    const raw = rest.join("=");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return "";
}

export function getRequestToken(req: Request): string {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return getSessionToken(req);
}
