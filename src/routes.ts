import { Router, Request, Response } from "express";
import express from "express";
import { store } from "./store.js";
import { config, activeNetwork } from "./config.js";
import { requireApiKey, requireAuth } from "./middleware.js";
import { getRequestToken, setSessionCookie, clearSessionCookie } from "./session.js";
import { getUserFromToken, issueSessionToken } from "./auth.js";
import { whiteLabel } from "./white-label.js";
import { formatError } from "./mcp/errors.js";
import { getPromptDefs, getPromptContent } from "./mcp/prompts.js";
import { getResources, readResource } from "./mcp/resources.js";
import {
  StatusResponse,
  RegisterWebhookBody, Tier,
} from "./types.js";
import { attestXrpPayment } from "./attest.js";
import { ATTESTATION_LIMITS } from "./attestation-quota.js";

const router = Router();

function isHexTxHash(v: string): boolean {
  return /^[0-9A-Fa-f]{64}$/.test(v);
}

function publicNavHtml(): string {
  return `<nav>
  <a href="/" class="logo">XRPL<span>ink</span></a>
  <div class="nav-links">
    <a href="/">Home</a>
    <a href="/docs">API Docs</a>
    <a href="/#pricing">Pricing</a>
    <a href="/contact">Contact</a>
  </div>
  <span id="authNav"></span>
</nav>
<script src="/session-nav.js" defer></script>`;
}

const PUBLIC_NAV_CSS = `
nav{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:2.5rem;flex-wrap:wrap}
nav .logo{font-weight:700;font-size:1.25rem;color:#f1f5f9;text-decoration:none}
nav .logo span{color:#818cf8}
nav .nav-links{display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap}
nav .nav-links a,#authNav a{text-decoration:none;color:#94a3b8;font-size:0.85rem;font-weight:500}
nav .nav-links a:hover,#authNav a:hover{color:#e2e8f0}
#authNav{display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap}
#authNav .auth-email{color:#94a3b8;font-size:0.8rem}
.btn{display:inline-block;padding:0.6rem 1.5rem;border-radius:8px;font-weight:600;font-size:0.9rem;text-decoration:none;cursor:pointer;border:none}
.btn-primary{background:#818cf8;color:#0f172a}
#authNav .btn{padding:0.45rem 1rem;font-size:0.8rem;width:auto;display:inline-block}
#authNav .auth-signup{color:#0f172a}
`;

function requestUser(req: Request) {
  const token = getRequestToken(req);
  return token ? getUserFromToken(token) : null;
}

// --- Auth endpoints ---

router.post("/auth/signup", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  const result = await import("./auth.js").then((m) => m.signup(email, password));
  if (!result.ok) {
    return res.status(400).json(formatError("AUTH_FAILED", { message: result.error || "Signup failed" }));
  }
  setSessionCookie(res, result.token!);
  return res.status(201).json({ token: result.token, apiKey: result.apiKey });
});

router.post("/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  const result = await import("./auth.js").then((m) => m.login(email, password));
  if (!result.ok) {
    return res.status(401).json(formatError("AUTH_FAILED", { message: result.error || "Login failed" }));
  }
  setSessionCookie(res, result.token!);
  return res.json({ token: result.token, apiKey: result.apiKey });
});

router.post("/auth/logout", (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/auth/session", (req: Request, res: Response) => {
  const user = requestUser(req);
  if (!user) return res.json({ user: null });
  setSessionCookie(res, issueSessionToken(user));
  return res.json({ user: { id: user.id, email: user.email, tier: user.tier } });
});
