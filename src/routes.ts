import { Router, Request, Response } from "express";
import express from "express";
import { store } from "./store.js";
import { config, activeNetwork } from "./config.js";
import * as fdc from "./fdc-service.js";
import { deliverWebhooks } from "./webhook-service.js";
import { requireApiKey, requireAuth } from "./middleware.js";
import { whiteLabel } from "./white-label.js";
import { formatError } from "./mcp/errors.js";
import { getPromptDefs, getPromptContent } from "./mcp/prompts.js";
import { getResources, readResource } from "./mcp/resources.js";
import {
  AttestationStatus, VerifyResponse, StatusResponse,
  RegisterWebhookBody, ApiError, Tier,
} from "./types.js";

const router = Router();

function isHexTxHash(v: string): boolean {
  return /^[0-9A-Fa-f]{64}$/.test(v);
}

// --- Auth endpoints ---

router.post("/auth/signup", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  const result = await import("./auth.js").then((m) => m.signup(email, password));
  if (!result.ok) {
    return res.status(400).json(formatError("AUTH_FAILED", { message: result.error }));
  }
  const { setSessionCookie } = await import("./session.js");
  setSessionCookie(res, result.token!);
  return res.status(201).json({ token: result.token, apiKey: result.apiKey });
});

router.post("/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  const result = await import("./auth.js").then((m) => m.login(email, password));
  if (!result.ok) {
    return res.status(401).json(formatError("AUTH_FAILED", { message: result.error }));
  }
  const { setSessionCookie } = await import("./session.js");
  setSessionCookie(res, result.token!);
  return res.json({ token: result.token, apiKey: result.apiKey });
});

router.post("/auth/logout", (_req: Request, res: Response) => {
  import("./session.js").then(({ clearSessionCookie }) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
});

router.post("/auth/reset-password", async (req: Request, res: Response) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json(formatError("MISSING_EMAIL"));
  await import("./auth.js").then((m) => m.generateResetToken(email));
  return res.json({ ok: true });
});

router.post("/auth/reset-password/confirm", async (req: Request, res: Response) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json(formatError("MISSING_PARAMS"));
  const result = await import("./auth.js").then((m) => m.resetPassword(token, password));
  if (!result.ok) return res.status(401).json(formatError("AUTH_FAILED", { message: result.error }));
  return res.json({ ok: true });
});

router.get("/me", requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user;
  const keys = store.listApiKeys().filter((k) => user.apiKeyIds.includes(k.key));
  res.json({ user: { id: user.id, email: user.email, tier: user.tier, createdAt: user.createdAt, usageCount: keys.reduce((s, k) => s + k.usageCount, 0) }, apiKeys: keys });
});

router.get("/receipts", requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user;
  const keys = store.listApiKeys().filter((k) => user.apiKeyIds.includes(k.key));
  // Attestations are currently global — return all for now (filter by user in future)
  const all = store.listAttestations();
  res.json(all.slice(0, 50));
});

// --- Billing endpoints ---

router.post("/billing/subscribe", requireAuth, async (req: Request, res: Response) => {
  const { tier } = req.body || {};
  if (!tier || !["paid", "pro"].includes(tier)) {
    return res.status(400).json(formatError("INVALID_TIER"));
  }
  const user = (req as any).user;
  const { createCheckoutSession } = await import("./billing.js");
  const session = await createCheckoutSession(user, tier);
  if (!session) return res.status(500).json(formatError("BILLING_ERROR"));
  return res.json({ url: session.url });
});

router.get("/billing/portal", requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { createPortalSession } = await import("./billing.js");
  const session = await createPortalSession(user);
  if (!session) return res.status(500).json(formatError("BILLING_ERROR"));
  return res.json({ url: session.url });
});

// --- Auth pages ---

const AUTH_PAGE_STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.6;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem 1rem}
.card{max-width:420px;width:100%;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2.5rem}
.card .logo{text-align:center;font-weight:700;font-size:1.25rem;color:#f1f5f9;margin-bottom:1.5rem}
.card .logo span{color:#818cf8}
.card h1{font-size:1.25rem;margin-bottom:0.25rem;text-align:center}
.card .subtitle{text-align:center;color:#64748b;font-size:0.85rem;margin-bottom:1.5rem}
.form-group{margin-bottom:1rem}
.form-group label{display:block;font-size:0.85rem;font-weight:600;color:#94a3b8;margin-bottom:0.35rem}
.form-group input{width:100%;padding:0.7rem 0.85rem;border:1px solid #334155;border-radius:6px;font-size:0.9rem;background:#0f172a;color:#e2e8f0;outline:none;font-family:inherit}
.form-group input:focus{border-color:#818cf8}
.btn{display:block;width:100%;padding:0.7rem;border-radius:8px;font-weight:600;font-size:0.9rem;cursor:pointer;border:none;text-align:center;text-decoration:none}
.btn-primary{background:#818cf8;color:#0f172a}
.btn-primary:hover{background:#6366f1}
.btn-primary:disabled{opacity:0.5;cursor:not-allowed}
.error{background:#7f1d1d;color:#fca5a5;padding:0.6rem 0.85rem;border-radius:6px;font-size:0.85rem;margin-bottom:1rem;display:none}
.footer{text-align:center;margin-top:1.5rem;font-size:0.85rem;color:#64748b}
.footer a{color:#818cf8;text-decoration:none}
`;

router.get("/signup", (_req: Request, res: Response) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Sign Up — XRPLink</title><style>${AUTH_PAGE_STYLE}</style></head>
<body>
<div class="card">
<div class="logo">XRPL<span>ink</span></div>
<h1>Create your account</h1>
<p class="subtitle">Get a free API key for receipt lookup</p>
<div class="error" id="error"></div>
<form id="signupForm" onsubmit="return handleSignup(event)">
<div class="form-group"><label>Email</label><input type="email" id="email" required autocomplete="email" placeholder="you@example.com"></div>
<div class="form-group"><label>Password</label><input type="password" id="password" required minlength="8" autocomplete="new-password" placeholder="At least 8 characters"></div>
<button type="submit" class="btn btn-primary" id="submitBtn">Create Account</button>
</form>
<div class="footer">Already have an account? <a href="/login">Log in</a></div>
</div>
<script>
async function handleSignup(e) {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const error = document.getElementById('error');
  const btn = document.getElementById('submitBtn');
  error.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Creating account...';
  try {
    const r = await fetch('/auth/signup', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password}) });
    const d = await r.json();
    if (!r.ok) { error.textContent = d.message || d.error || 'Signup failed'; error.style.display = 'block'; btn.disabled = false; btn.textContent = 'Create Account'; return; }
    localStorage.setItem('xrplink_token', d.token);
    localStorage.setItem('xrplink_api_key', d.apiKey);
    window.location.href = '/dashboard';
  } catch(e) { error.textContent = 'Network error'; error.style.display = 'block'; btn.disabled = false; btn.textContent = 'Create Account'; }
}
</script>
</body></html>`);
});

router.get("/login", (_req: Request, res: Response) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Log In — XRPLink</title><style>${AUTH_PAGE_STYLE}</style></head>
<body>
<div class="card">
<div class="logo">XRPL<span>ink</span></div>
<h1>Welcome back</h1>
<p class="subtitle">Log in to your account</p>
<div class="error" id="error"></div>
<form id="loginForm" onsubmit="return handleLogin(event)">
<div class="form-group"><label>Email</label><input type="email" id="email" required autocomplete="email" placeholder="you@example.com"></div>
<div class="form-group"><label>Password</label><input type="password" id="password" required autocomplete="current-password" placeholder="Your password"></div>
<button type="submit" class="btn btn-primary" id="submitBtn">Log In</button>
</form>
<div class="footer">No account? <a href="/signup">Sign up</a></div>
</div>
<script>
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const error = document.getElementById('error');
  const btn = document.getElementById('submitBtn');
  error.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Logging in...';
  try {
    const r = await fetch('/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password}) });
    const d = await r.json();
    if (!r.ok) { error.textContent = d.message || d.error || 'Login failed'; error.style.display = 'block'; btn.disabled = false; btn.textContent = 'Log In'; return; }
    localStorage.setItem('xrplink_token', d.token);
    localStorage.setItem('xrplink_api_key', d.apiKey);
    window.location.href = '/dashboard';
  } catch(e) { error.textContent = 'Network error'; error.style.display = 'block'; btn.disabled = false; btn.textContent = 'Log In'; }
}
</script>
</body></html>`);
});

// --- API Docs page ---

const DOCS_STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.7;padding:2rem 1rem}
.wrap{max-width:820px;margin:0 auto}
nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:2.5rem}
nav .logo{font-weight:700;font-size:1.25rem;color:#f1f5f9;text-decoration:none}
nav .logo span{color:#818cf8}
nav a.back{color:#94a3b8;text-decoration:none;font-size:0.85rem}
nav a.back:hover{color:#e2e8f0}
h1{font-size:1.75rem;margin-bottom:0.5rem;color:#f1f5f9}
.subtitle{color:#94a3b8;font-size:0.95rem;margin-bottom:2rem}
h2{font-size:1.15rem;margin:2.5rem 0 0.75rem;color:#f1f5f9;padding-top:1rem;border-top:1px solid #1e293b}
h3{font-size:0.95rem;margin:1.5rem 0 0.5rem;color:#cbd5e1}
p{color:#94a3b8;font-size:0.9rem;margin-bottom:0.75rem}
code{font-family:"SF Mono","Fira Code","JetBrains Mono",monospace;font-size:0.82rem;background:#1e293b;padding:0.15rem 0.4rem;border-radius:4px;color:#e2e8f0}
pre{background:#0b1220;border:1px solid #1e293b;border-radius:8px;padding:1rem 1.25rem;overflow-x:auto;margin:0.75rem 0 1.25rem}
pre code{background:none;padding:0;font-size:0.8rem;line-height:1.6;color:#cbd5e1}
.endpoint{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem 1.25rem;margin:0.75rem 0}
.endpoint .method{display:inline-block;font-weight:700;font-size:0.75rem;padding:0.15rem 0.5rem;border-radius:4px;margin-right:0.6rem;letter-spacing:0.03em}
.method.get{background:#1e3a5f;color:#60a5fa}
.method.post{background:#065f46;color:#6ee7b7}
.method.put{background:#5b3a1e;color:#fcd34d}
.method.delete{background:#7f1d1d;color:#fca5a5}
.endpoint .path{font-family:"SF Mono","Fira Code",monospace;font-size:0.85rem;color:#e2e8f0}
.endpoint .desc{font-size:0.8rem;color:#94a3b8;margin-top:0.35rem}
table{width:100%;border-collapse:collapse;font-size:0.85rem;margin:0.75rem 0 1.25rem}
th{text-align:left;padding:0.5rem 0.75rem;border-bottom:1px solid #334155;color:#64748b;font-weight:600;text-transform:uppercase;font-size:0.7rem;letter-spacing:0.05em}
td{padding:0.5rem 0.75rem;border-bottom:1px solid #1e293b;color:#cbd5e1}
.badge{display:inline-block;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.7rem;font-weight:600}
.badge.auth{background:#1e3a5f;color:#60a5fa}
.badge.pub{background:#1e293b;color:#94a3b8}
.badge.api-key{background:#3b1e5f;color:#c084fc}
.toc{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1.25rem 1.5rem;margin-bottom:2rem}
.toc a{display:block;color:#818cf8;text-decoration:none;font-size:0.85rem;padding:0.2rem 0}
.toc a:hover{color:#a5b4fc}
`;

router.get("/docs", (_req: Request, res: Response) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>API Docs — XRPLink</title><style>${DOCS_STYLE}</style></head>
<body>
<div class="wrap">
<nav>
  <a href="/" class="logo">XRPL<span>ink</span></a>
  <a href="/" class="back">← Back to home</a>
</nav>

<h1>XRPLink API Documentation</h1>
<p class="subtitle">Generate cryptographically verified receipts for XRP payments on the Flare Network.</p>

<div class="toc">
  <strong style="color:#f1f5f9;font-size:0.85rem">Contents</strong>
  <a href="#auth">Authentication</a>
  <a href="#receipts">Receipts</a>
  <a href="#attestation">Attestation</a>
  <a href="#billing">Billing</a>
  <a href="#mcp">MCP Server</a>
  <a href="#errors">Errors</a>
</div>

<h2 id="auth">Authentication</h2>
<p>XRPLink uses <strong>API keys</strong> for the attestation API and <strong>JWT bearer tokens</strong> for account and billing endpoints. Create an account to get a free API key.</p>

<h3>Create an account</h3>
<div class="endpoint"><span class="method post">POST</span><span class="path">/auth/signup</span><span class="badge pub" style="margin-left:0.5rem">public</span><div class="desc">Creates a user and returns a session token plus a free-tier API key.</div></div>
<pre><code>curl -X POST https://xrp-link.com/auth/signup \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","password":"yourpassword"}'

// Response
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "apiKey": "sk_live_..."
}</code></pre>

<h3>Log in</h3>
<div class="endpoint"><span class="method post">POST</span><span class="path">/auth/login</span><span class="badge pub" style="margin-left:0.5rem">public</span><div class="desc">Returns a session token and your API key.</div></div>
<pre><code>curl -X POST https://xrp-link.com/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","password":"yourpassword"}'</code></pre>

<h3>Current user</h3>
<div class="endpoint"><span class="method get">GET</span><span class="path">/me</span><span class="badge auth" style="margin-left:0.5rem">bearer token</span><div class="desc">Returns your user info, plan tier, and API keys.</div></div>
<pre><code>curl https://xrp-link.com/me \\
  -H "Authorization: Bearer &lt;your-token&gt;"</code></pre>

<h2 id="receipts">Receipts</h2>

<h3>View a receipt</h3>
<div class="endpoint"><span class="method get">GET</span><span class="path">/receipt/:txHash</span><span class="badge pub" style="margin-left:0.5rem">public</span><div class="desc">Returns an HTML receipt page for any XRP transaction. No API key required. If the transaction is already attested, the full cryptographic receipt is shown; otherwise the XRP Ledger data is displayed with instructions to attest.</div></div>
<pre><code>curl https://xrp-link.com/receipt/87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F</code></pre>

<h2 id="attestation">Attestation</h2>
<p>Attesting a payment generates the on-chain cryptographic proof. This requires an API key with a paid or pro plan. Proofs are ready in ~90-180 seconds (FDC voting round).</p>

<h3>Verify an XRP payment</h3>
<div class="endpoint"><span class="method post">POST</span><span class="path">/api/v1/verify/xrp-payment</span><span class="badge api-key" style="margin-left:0.5rem">API key</span><div class="desc">Submits a transaction hash for attestation. Returns an attestation ID and FDC round.</div></div>
<pre><code>curl -X POST https://xrp-link.com/api/v1/verify/xrp-payment \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: sk_live_..." \\
  -d '{"txHash":"87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F"}'

// Response (HTTP 202)
{
  "id": "3f0c8e2a-...",
  "txHash": "87AD359A0DB9E27260AAE29766DC858886C54DAC4733D43B1B72CBB90E29B95F",
  "roundId": 1393372,
  "status": "pending"
}</code></pre>

<h3>Check attestation status</h3>
<div class="endpoint"><span class="method get">GET</span><span class="path">/api/v1/status/:id</span><span class="badge api-key" style="margin-left:0.5rem">API key</span><div class="desc">Check the status of an attestation by UUID.</div></div>
<pre><code>curl https://xrp-link.com/api/v1/status/3f0c8e2a-... \\
  -H "X-API-Key: sk_live_..."

// Statuses: pending, ready, verified, failed, not_found</code></pre>

<h3>Look up by transaction</h3>
<div class="endpoint"><span class="method get">GET</span><span class="path">/api/v1/status-by-tx/:txHash</span><span class="badge api-key" style="margin-left:0.5rem">API key</span><div class="desc">Find an attestation by the original XRP transaction hash.</div></div>

<h3>Register a webhook</h3>
<div class="endpoint"><span class="method post">POST</span><span class="path">/api/v1/webhooks</span><span class="badge api-key" style="margin-left:0.5rem">API key</span><div class="desc">Register a URL to receive attestation completion callbacks.</div></div>
<pre><code>curl -X POST https://xrp-link.com/api/v1/webhooks \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: sk_live_..." \\
  -d '{"url":"https://your-app.com/hooks/xrp"}'</code></pre>

<h2 id="billing">Billing</h2>
<div class="endpoint"><span class="method post">POST</span><span class="path">/billing/subscribe</span><span class="badge auth" style="margin-left:0.5rem">bearer token</span><div class="desc">Create a Stripe Checkout session for a plan. Returns a redirect URL.</div></div>
<pre><code>curl -X POST https://xrp-link.com/billing/subscribe \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer &lt;your-token&gt;" \\
  -d '{"tier":"paid"}'

// Response
{ "url": "https://checkout.stripe.com/c/pay/..." }</code></pre>
<div class="endpoint"><span class="method get">GET</span><span class="path">/billing/portal</span><span class="badge auth" style="margin-left:0.5rem">bearer token</span><div class="desc">Get a link to manage or cancel your subscription.</div></div>

<h2 id="mcp">MCP Server</h2>
<p>XRPLink exposes an MCP server so AI agents can verify payments directly. Connect via stdio or the HTTP endpoint.</p>

<table>
<tr><th>Tool</th><th>Description</th></tr>
<tr><td><code>verify_xrp_payment</code></td><td>Submit a txHash for attestation</td></tr>
<tr><td><code>get_attestation_status</code></td><td>Check attestation by UUID</td></tr>
<tr><td><code>lookup_attestation_by_tx</code></td><td>Find attestation by txHash</td></tr>
<tr><td><code>get_attestation_by_round</code></td><td>List attestations by round ID</td></tr>
<tr><td><code>get_server_info</code></td><td>Server, network, and contract info</td></tr>
</table>

<pre><code># stdio transport (local agents)
npm run start:mcp

# HTTP/SSE endpoint
curl https://xrp-link.com/mcp</code></pre>

<h2 id="errors">Errors</h2>
<p>Errors are returned as JSON with a machine-readable <code>code</code> and a human-readable <code>message</code>:</p>
<pre><code>{
  "error": "INVALID_TX_HASH",
  "message": "Expected 64 hex characters for transaction hash",
  "suggestedAction": "Provide a valid XRP transaction hash..."
}</code></pre>

<table>
<tr><th>Code</th><th>Meaning</th></tr>
<tr><td><code>MISSING_API_KEY</code></td><td>X-API-Key header missing</td></tr>
<tr><td><code>INVALID_API_KEY</code></td><td>API key invalid or deactivated</td></tr>
<tr><td><code>RATE_LIMITED</code></td><td>Per-minute limit exceeded for your tier</td></tr>
<tr><td><code>INVALID_TX_HASH</code></td><td>Not a valid 64-hex transaction hash</td></tr>
<tr><td><code>SUBMIT_FAILED</code></td><td>Attestation submission to FdcHub failed</td></tr>
<tr><td><code>NOT_FOUND</code></td><td>Resource not found</td></tr>
<tr><td><code>FORBIDDEN</code></td><td>Requires a higher plan tier</td></tr>
<tr><td><code>AUTH_FAILED</code></td><td>Invalid email/password</td></tr>
<tr><td><code>MISSING_AUTH</code></td><td>Bearer token missing</td></tr>
<tr><td><code>INVALID_AUTH</code></td><td>Bearer token invalid or expired</td></tr>
</table>

</div>
</body></html>`);
});

// --- Contact page ---

const CONTACT_STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.6;padding:2rem 1rem}
.wrap{max-width:560px;margin:0 auto}
nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem}
nav .logo{font-weight:700;font-size:1.25rem;color:#f1f5f9;text-decoration:none}
nav .logo span{color:#818cf8}
nav a.back{color:#94a3b8;text-decoration:none;font-size:0.85rem}
nav a.back:hover{color:#e2e8f0}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2.5rem}
.card h1{font-size:1.25rem;margin-bottom:0.25rem}
.card .subtitle{color:#94a3b8;font-size:0.85rem;margin-bottom:1.5rem}
.form-group{margin-bottom:1rem}
.form-group label{display:block;font-size:0.85rem;font-weight:600;color:#94a3b8;margin-bottom:0.35rem}
.form-group input,.form-group textarea{width:100%;padding:0.7rem 0.85rem;border:1px solid #334155;border-radius:6px;font-size:0.9rem;background:#0f172a;color:#e2e8f0;outline:none;font-family:inherit}
.form-group input:focus,.form-group textarea:focus{border-color:#818cf8}
.form-group textarea{min-height:140px;resize:vertical}
.btn{display:block;width:100%;padding:0.7rem;border-radius:8px;font-weight:600;font-size:0.9rem;cursor:pointer;border:none;text-align:center;text-decoration:none}
.btn-primary{background:#818cf8;color:#0f172a}
.btn-primary:hover{background:#6366f1}
.btn-primary:disabled{opacity:0.5;cursor:not-allowed}
.msg{display:none;padding:0.6rem 0.85rem;border-radius:6px;font-size:0.85rem;margin-bottom:1rem}
.msg.success{display:block;background:#065f46;color:#6ee7b7}
.msg.error{display:block;background:#7f1d1d;color:#fca5a5}
`;

router.get("/contact", (_req: Request, res: Response) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Contact — XRPLink</title><style>${CONTACT_STYLE}</style></head>
<body>
<div class="wrap">
<nav>
  <a href="/" class="logo">XRPL<span>ink</span></a>
  <a href="/" class="back">← Back to home</a>
</nav>
<div class="card">
<h1>Contact us</h1>
<p class="subtitle">Questions, enterprise pricing, or partnerships — we'll get back to you.</p>
<div class="msg" id="msg"></div>
<form id="contactForm" onsubmit="return handleContact(event)">
<div class="form-group"><label>Name</label><input type="text" id="name" required placeholder="Your name"></div>
<div class="form-group"><label>Email</label><input type="email" id="email" required placeholder="you@example.com"></div>
<div class="form-group"><label>Message</label><textarea id="message" required placeholder="How can we help?"></textarea></div>
<button type="submit" class="btn btn-primary" id="submitBtn">Send Message</button>
</form>
</div>
</div>
<script>
async function handleContact(e) {
  e.preventDefault();
  const msg = document.getElementById('msg');
  const btn = document.getElementById('submitBtn');
  msg.className = 'msg';
  msg.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    const r = await fetch('/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('name').value,
        email: document.getElementById('email').value,
        message: document.getElementById('message').value
      })
    });
    const d = await r.json();
    if (r.ok) {
      msg.className = 'msg success';
      msg.textContent = 'Message sent! We will get back to you soon.';
      msg.style.display = 'block';
      document.getElementById('contactForm').reset();
    } else {
      msg.className = 'msg error';
      msg.textContent = d.message || 'Could not send message. Please try again.';
      msg.style.display = 'block';
    }
  } catch(err) {
    msg.className = 'msg error';
    msg.textContent = 'Could not send message. Please try again.';
    msg.style.display = 'block';
  }
  btn.disabled = false;
  btn.textContent = 'Send Message';
}
</script>
</body></html>`);
});

router.post("/contact", async (req: Request, res: Response) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json(formatError("MISSING_PARAMS", undefined, "Name, email, and message are required"));
  }
  try {
    const { sendContactEmail } = await import("./email.js");
    await sendContactEmail({ name: String(name).slice(0, 200), email: String(email).slice(0, 200), message: String(message).slice(0, 5000) });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Contact email failed:", err);
    return res.status(500).json(formatError("INTERNAL_ERROR"));
  }
});

// --- Public endpoints ---

router.get("/health", (_req: Request, res: Response) => {
  const wl = whiteLabel.get();
  res.json({
    status: "ok",
    brand: wl.brandName,
    companyUrl: wl.companyUrl,
    network: config.network,
    paymentVerifier: config.paymentVerifierAddress || "not configured",
    sourceId: activeNetwork.sourceId,
    chainId: activeNetwork.chainId,
    fdcHub: activeNetwork.fdcHub,
    uptime: process.uptime(),
  });
});

router.get("/dashboard", (req: Request, res: Response) => {
  // Check for auth via header or cookie
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Dashboard — XRPLink</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.6;padding:2rem 1rem}
.wrap{max-width:800px;margin:0 auto}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem}
.header .logo{font-weight:700;font-size:1.25rem;color:#f1f5f9;text-decoration:none}
.header .logo span{color:#818cf8}
.header .nav a{color:#94a3b8;text-decoration:none;font-size:0.85rem;margin-left:1.5rem}
.header .nav a:hover{color:#e2e8f0}
.api-card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem;position:relative}
.api-card h2{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:0.75rem}
.api-key{display:flex;align-items:center;gap:0.5rem;background:#0f172a;padding:0.7rem 1rem;border-radius:8px;font-family:"SF Mono","Fira Code",monospace;font-size:0.8rem;color:#e2e8f0;overflow:hidden}
.api-key .val{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.api-key .copy-btn{background:#334155;border:none;color:#94a3b8;cursor:pointer;padding:0.3rem 0.6rem;border-radius:4px;font-size:0.75rem;flex-shrink:0}
.api-key .copy-btn:hover{background:#475569;color:#e2e8f0}
.api-key .copy-btn.copied{background:#065f46;color:#6ee7b7}
.stats{display:flex;gap:1rem;margin-bottom:1.5rem}
.stat-card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:1rem;flex:1;text-align:center}
.stat-card .num{font-size:1.5rem;font-weight:700}
.stat-card .label{font-size:0.75rem;color:#64748b;margin-top:0.25rem}
.verify-box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem}
.verify-box h2{font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:0.75rem}
.verify-input{display:flex;gap:0.5rem}
.verify-input input{flex:1;padding:0.7rem 0.85rem;border:1px solid #334155;border-radius:6px;font-size:0.85rem;background:#0f172a;color:#e2e8f0;outline:none;font-family:"SF Mono","Fira Code",monospace}
.verify-input input:focus{border-color:#818cf8}
.verify-input button{padding:0.7rem 1.25rem;background:#818cf8;color:#0f172a;border:none;border-radius:6px;font-weight:600;cursor:pointer}
.verify-input button:hover{background:#6366f1}
.msg{padding:0.6rem 0.85rem;border-radius:6px;font-size:0.85rem;margin-top:0.75rem;display:none}
.msg.success{display:block;background:#065f46;color:#6ee7b7}
.msg.error{display:block;background:#7f1d1d;color:#fca5a5}
.msg.info{display:block;background:#1e3a5f;color:#93c5fd}
.receipts-table{width:100%;border-collapse:collapse;font-size:0.8rem}
.receipts-table th{text-align:left;padding:0.5rem 0.75rem;border-bottom:1px solid #334155;color:#64748b;font-weight:600;text-transform:uppercase;font-size:0.7rem;letter-spacing:0.05em}
.receipts-table td{padding:0.5rem 0.75rem;border-bottom:1px solid #1e293b;color:#cbd5e1}
.receipts-table td .status{display:inline-block;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.7rem;font-weight:600}
.status.verified{background:#065f46;color:#6ee7b7}.status.pending{background:#1e3a5f;color:#93c5fd}
.status.ready{background:#5b3a1e;color:#fcd34d}.status.failed,.status.not_found{background:#5f1e1e;color:#fca5a5}
.status.free{color:#94a3b8}.status.paid{color:#60a5fa}.status.pro{color:#c084fc}
.tier{display:inline-block;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.65rem;font-weight:700;text-transform:uppercase;background:#1e293b}
.tier.free{color:#94a3b8;background:#1e293b;border:1px solid #334155}
.tier.paid{color:#60a5fa;background:#1e3a5f;border:1px solid #1e3a5f}
.tier.pro{color:#c084fc;background:#3b1e5f;border:1px solid #3b1e5f}
.upgrade-banner{background:linear-gradient(135deg,#1e293b,#1e3a5f);border:1px solid #334155;border-radius:12px;padding:1.5rem;text-align:center;margin-top:1.5rem}
.upgrade-banner h3{font-size:1rem;margin-bottom:0.5rem}
.upgrade-banner p{color:#94a3b8;font-size:0.85rem;margin-bottom:1rem}
.btn{display:inline-block;padding:0.6rem 1.5rem;border-radius:8px;font-weight:600;font-size:0.9rem;text-decoration:none;cursor:pointer;border:none}
.btn-primary{background:#818cf8;color:#0f172a}
.btn-primary:hover{background:#6366f1}
.btn-outline{background:transparent;color:#818cf8;border:1.5px solid #818cf8}
.login-card{text-align:center;padding:3rem 1rem}
.login-card h2{font-size:1.25rem;margin-bottom:0.5rem}
.login-card p{color:#94a3b8;margin-bottom:1.5rem}
.empty{color:#64748b;font-size:0.85rem;padding:1rem 0;text-align:center}
</style></head>
<body>
<div class="wrap">
<div class="header">
  <a href="/" class="logo">XRPL<span>ink</span></a>
  <div class="nav">
    <a href="/" id="navHome">Home</a>
    <a href="#" id="navLogout" style="display:none">Log out</a>
  </div>
</div>

<div id="loading" style="text-align:center;padding:3rem;color:#64748b">Loading...</div>

<div id="dashboardContent" style="display:none"></div>
<div id="loginPrompt" style="display:none" class="login-card">
  <h2>Log in to your dashboard</h2>
  <p>Sign in to view your API key, receipts, and usage.</p>
  <a href="/login" class="btn btn-primary">Log In</a>
  <br><br>
  <a href="/signup" class="btn btn-outline">Create an Account</a>
</div>
</div>

<script>
const TOKEN_KEY = 'xrplink_token';
const API_KEY_KEY = 'xrplink_api_key';

async function loadDashboard() {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = token ? { 'Authorization': 'Bearer ' + token } : {};

  try {
    // credentials:'include' ensures the session cookie is always sent,
    // including after the cross-site Stripe Checkout redirect back.
    const r = await fetch('/me', { headers, credentials: 'include' });
    if (r.status === 401) {
      // Session cookie expired/invalid — show login prompt, keep stored key for reference
      document.getElementById('loginPrompt').style.display = 'block';
      document.getElementById('loading').style.display = 'none';
      return;
    }
    if (!r.ok) {
      document.getElementById('loading').textContent = 'Could not load dashboard.';
      return;
    }
    const data = await r.json();
    // Refresh stored API key from server response
    if (data.apiKeys && data.apiKeys[0]) {
      localStorage.setItem(API_KEY_KEY, data.apiKeys[0].key);
    }
    renderDashboard(data);
  } catch(e) {
    document.getElementById('loading').textContent = 'Could not load dashboard.';
  }
}

function renderDashboard(data) {
  const user = data.user;
  const apiKeys = data.apiKeys;
  const apiKey = apiKeys[0] || { key: localStorage.getItem(API_KEY_KEY) || 'Loading...' };
  const tier = user.tier || 'free';
  const monthlyLimit = tier === 'free' ? 0 : (tier === 'paid' ? 5 : 25);
  const usage = user.usageCount || 0;

  document.getElementById('loading').style.display = 'none';
  document.getElementById('dashboardContent').style.display = 'block';
  document.getElementById('navLogout').style.display = 'inline';

  document.getElementById('dashboardContent').innerHTML = \`
    <div class="api-card">
      <h2>Your API Key</h2>
      <div class="api-key">
        <span class="val">\${apiKey.key}</span>
        <button class="copy-btn" onclick="copyKey(this)">Copy</button>
      </div>
      <p style="color:#64748b;font-size:0.75rem;margin-top:0.5rem">Use this key in the <code>X-API-Key</code> header to call the API.</p>
    </div>

    <div class="stats">
      <div class="stat-card"><div class="num">\${tier.charAt(0).toUpperCase() + tier.slice(1)}</div><div class="label">Plan</div></div>
      <div class="stat-card"><div class="num">\${monthlyLimit === 0 ? 'Lookup only' : monthlyLimit}</div><div class="label">Receipts / month</div></div>
      <div class="stat-card"><div class="num"><span class="tier \${tier}">\${tier}</span></div><div class="label">Rate limit</div></div>
    </div>

    <div class="verify-box">
      <h2>Verify an XRP Payment</h2>
      <div class="verify-input">
        <input type="text" id="txHashInput" placeholder="Paste an XRP transaction hash..." spellcheck="false">
        <button onclick="lookupTx()">Look Up</button>
      </div>
      <div class="msg info" id="lookupMsg" style="display:none">Enter a txHash to look up or attest a payment.</div>
    </div>

    <h2 style="font-size:0.85rem;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:0.75rem">Your Receipts</h2>
    <table class="receipts-table" id="receiptTable">
      <thead><tr><th>TX Hash</th><th>Status</th><th>Date</th><th></th></tr></thead>
      <tbody id="receiptBody">
        <tr><td colspan="4" class="empty">Loading receipts...</td></tr>
      </tbody>
    </table>

    \${tier === 'free' ? \`
      <div class="upgrade-banner">
        <h3>Upgrade to create verified receipts</h3>
        <p>Your free plan includes receipt lookup only. Upgrade to attest payments and generate cryptographic proofs.</p>
        <button onclick="subscribe('paid')" class="btn btn-primary">Subscribe — \$29/mo</button>
        <a href="/#pricing" class="btn btn-outline" style="margin-left:0.5rem">See All Plans</a>
      </div>
    \` : \`
      <div class="upgrade-banner" style="background:linear-gradient(135deg,#065f46,#0f172a);border-color:#065f46">
        <h3>✓ You're on the \${tier.charAt(0).toUpperCase() + tier.slice(1)} plan</h3>
        <p>You can now attest payments and generate verified receipts. Use the form above to verify an XRP payment.</p>
      </div>
    \`}
  \`;

  // Show upgrade confirmation if we just returned from Stripe Checkout
  const urlParams = new URLSearchParams(window.location.search);
  const upgraded = urlParams.get('upgraded');
  if (upgraded) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#065f46;color:#6ee7b7;padding:0.85rem 1rem;border-radius:8px;font-size:0.9rem;margin-bottom:1.5rem;text-align:center';
    banner.textContent = 'Payment successful! Your plan has been upgraded to ' + upgraded.charAt(0).toUpperCase() + upgraded.slice(1) + '.';
    const wrap = document.querySelector('.wrap');
    if (wrap) wrap.insertBefore(banner, wrap.firstChild.nextSibling);
    // Clean the URL so a refresh doesn't re-show the message
    history.replaceState(null, '', '/dashboard');
  }

  // Load receipts
  loadReceipts();
}

async function loadReceipts() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const r = await fetch('/receipts', { headers, credentials: 'include' });
    if (!r.ok) return;
    const receipts = await r.json();
    const tbody = document.getElementById('receiptBody');
    if (receipts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">No receipts yet. Verify a payment above.</td></tr>';
      return;
    }
    tbody.innerHTML = receipts.slice(0, 20).map(r => \`
      <tr>
        <td><code style="font-size:0.75rem;background:#1e293b;padding:0.15rem 0.35rem;border-radius:3px">\${r.txHash.slice(0, 20)}...</code></td>
        <td><span class="status \${r.status}">\${r.status}</span></td>
        <td style="color:#64748b;font-size:0.8rem">\${new Date(r.createdAt).toLocaleDateString()}</td>
        <td><a href="/receipt/\${r.txHash}" style="color:#818cf8;text-decoration:none;font-size:0.8rem">View →</a></td>
      </tr>
    \`).join('');
  } catch(e) {}
}

function lookupTx() {
  const hash = document.getElementById('txHashInput').value.trim();
  if (!hash) return;
  window.location.href = '/receipt/' + hash.replace(/^0x/i, '').toUpperCase();
}

function copyKey(btn) {
  const key = btn.parentElement.querySelector('.val').textContent;
  navigator.clipboard.writeText(key).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  }).catch(() => {});
}

async function subscribe(tier) {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch('/billing/subscribe', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tier })
    });
    const d = await r.json();
    if (r.ok && d.url) { window.location.href = d.url; return; }
    alert(d.message || 'Could not start subscription. Check that Stripe is configured.');
  } catch(e) {
    alert('Could not start subscription.');
  }
}

document.getElementById('navLogout').addEventListener('click', async (e) => {
  e.preventDefault();
  try { await fetch('/auth/logout', { method: 'POST' }); } catch(err) {}
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(API_KEY_KEY);
  window.location.href = '/';
});

loadDashboard();
</script>
</body></html>`);
});

// --- MCP Protocol over HTTP (SSE transport for remote agents) ---

// In-memory SSE session
let sseClients: Response[] = [];

router.get("/mcp", (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("event: endpoint\ndata: /mcp\n\n");
  sseClients.push(res);
  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

router.post("/mcp", expressJsonWithRaw, async (req: Request, res: Response) => {
  // Accept JSON-RPC messages from MCP clients and relay to SSE clients
  // For now, log received messages - full MCP-over-SSE routing requires
  // the MCP SDK's SSE transport which we'll wire up in a future step.
  const msg = req.body;
  console.log("MCP message received:", JSON.stringify(msg).slice(0, 200));
  res.status(202).json({ status: "received" });
});

function expressJsonWithRaw(req: Request, res: Response, next: express.NextFunction) {
  express.json()(req, res, next);
}

// --- Public Receipt Page ---

const XRP_RPC_URL = "https://s1.ripple.com:51234";

interface XrplTxResult {
  Account: string;
  Destination: string;
  Amount: string;
  Fee: string;
  Memos?: { Memo: { MemoData?: string; MemoType?: string } }[];
  DestinationTag?: number;
  TransactionType: string;
  meta?: { TransactionResult?: string };
  date?: number;
}

async function fetchXrplTx(txHash: string): Promise<XrplTxResult | null> {
  try {
    const res = await fetch(XRP_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "tx",
        params: [{ transaction: txHash, binary: false }],
      }),
    });
    const data: any = await res.json();
    if (data.result?.Account) return data.result;
    return null;
  } catch {
    return null;
  }
}

function formatXrpAmount(drops: string): string {
  const n = BigInt(drops);
  const whole = n / 1000000n;
  const frac = n % 1000000n;
  if (frac === 0n) return whole.toString() + " XRP";
  return whole.toString() + "." + frac.toString().padStart(6, "0") + " XRP";
}

function formatTimestamp(unix: number): string {
  // XRPL timestamps are Ripple epoch (2000-01-01) + seconds
  const rippleEpoch = 946684800;
  return new Date((rippleEpoch + unix) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

router.get("/receipt/:txHash", async (req: Request, res: Response) => {
  const txHash = req.params.txHash.replace(/^0x/i, "").toUpperCase();
  const attestation = store.getByTxHash(txHash);
  const wl = whiteLabel.get();

  const shareUrl = `https://${wl.companyUrl.replace(/^https?:\/\//, "")}/receipt/${txHash}`;

  if (attestation && (attestation.status === "verified" || attestation.status === "ready" || attestation.status === "pending")) {
    const p = attestation.proof?.response;
    const rb = p?.responseBody;

    const memoHex = rb?.firstMemoData || "";
    const memoStr = memoHex.startsWith("0x") ? Buffer.from(memoHex.slice(2), "hex").toString("utf8").replace(/\0+$/, "") : "";

    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Verified Receipt — XRPLink</title>
<meta name="description" content="Cryptographically verified XRP payment receipt for transaction ${txHash}">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1e293b;background:#f8fafc;line-height:1.6;padding:2rem 1rem}
.receipt{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:2.5rem}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2rem}
.header .brand{font-weight:700;font-size:1.1rem;color:#0f172a}
.header .brand span{color:#6366f1}
.header .badge{background:#065f46;color:#d1fae5;padding:0.3rem 0.75rem;border-radius:6px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.03em}
h1{font-size:1.25rem;margin-bottom:0.25rem;color:#0f172a}
.subtitle{color:#64748b;font-size:0.85rem;margin-bottom:1.5rem}
.row{display:flex;justify-content:space-between;padding:0.75rem 0;border-bottom:1px solid #f1f5f9;font-size:0.88rem}
.row:last-child{border:none}
.row .key{color:#64748b;flex-shrink:0}
.row .value{color:#1e293b;font-family:"SF Mono","Fira Code","JetBrains Mono",monospace;font-size:0.8rem;text-align:right;word-break:break-all;max-width:65%}
.row .value.green{color:#059669}
.section-title{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin:1.5rem 0 0.75rem;font-weight:600}
.actions{margin-top:2rem;display:flex;gap:1rem}
.actions a{padding:0.6rem 1.25rem;border-radius:8px;font-weight:600;font-size:0.85rem;text-decoration:none;display:inline-block}
.btn-primary{background:#6366f1;color:#fff}
.btn-primary:hover{background:#4f46e5}
.btn-outline{background:transparent;color:#6366f1;border:1.5px solid #6366f1}
.btn-outline:hover{background:#eef2ff}
.footer{text-align:center;margin-top:2rem;padding-top:1.5rem;border-top:1px solid #f1f5f9;font-size:0.8rem;color:#94a3b8}
.footer a{color:#6366f1;text-decoration:none}
@media print{body{background:#fff;padding:0}.receipt{border:none;border-radius:0;padding:0}.actions{display:none}}
@media(max-width:480px){.row{flex-direction:column;gap:0.25rem}.row .value{text-align:left;max-width:100%}}
</style></head>
<body>
<div class="receipt">
<div class="header">
  <div class="brand">XRPL<span>ink</span></div>
  <div class="badge">Verified on Flare</div>
</div>
<h1>Verified Payment Receipt</h1>
<p class="subtitle">This receipt is cryptographically verified by the Flare Data Connector (FDC). Anyone can independently verify it on-chain.</p>

<div class="section-title">Payment Details</div>
<div class="row"><span class="key">XRP Transaction</span><span class="value">${txHash}</span></div>
${rb ? `<div class="row"><span class="key">Source Address</span><span class="value">${escapeHtml(rb.sourceAddress)}</span></div>
<div class="row"><span class="key">Amount</span><span class="value">${formatXrpAmount(rb.receivedAmount)}</span></div>
<div class="row"><span class="key">Status</span><span class="value green">${rb.status === "0" ? "Success" : "Failed (" + rb.status + ")"}</span></div>
${rb.hasMemoData && memoStr ? `<div class="row"><span class="key">Memo Data</span><span class="value">${escapeHtml(memoStr)}</span></div>` : ""}
${rb.hasDestinationTag && rb.destinationTag !== "0" ? `<div class="row"><span class="key">Destination Tag</span><span class="value">${rb.destinationTag}</span></div>` : ""}` : ""}

<div class="section-title">Verification Proof</div>
<div class="row"><span class="key">Attestation ID</span><span class="value">${attestation.id}</span></div>
${attestation.roundId ? `<div class="row"><span class="key">FDC Voting Round</span><span class="value">${attestation.roundId.toLocaleString()}</span></div>` : ""}
${p?.votingRound ? `<div class="row"><span class="key">DA Voting Round</span><span class="value">${p.votingRound}</span></div>` : ""}
${attestation.verifiedTxHash ? `<div class="row"><span class="key">Verification TX</span><span class="value">${attestation.verifiedTxHash}</span></div>` : ""}
<div class="row"><span class="key">Flare Contract</span><span class="value">${config.paymentVerifierAddress || "—"}</span></div>
${attestation.proof?.proof ? `<div class="row"><span class="key">Merkle Proof</span><span class="value">${attestation.proof.proof.length} entries</span></div>` : ""}
${attestation.status === "pending" ? `<div class="row"><span class="key">Status</span><span class="value">Pending — check back in ~90s</span></div>` : ""}

<div class="actions">
  <a href="${shareUrl}" class="btn btn-primary">Share Receipt</a>
  <a href="https://flare-explorer.flare.network/address/${config.paymentVerifierAddress}" class="btn btn-outline" target="_blank">View Contract</a>
</div>

<div class="footer">
  <p>Generated by <a href="/">XRPLink</a>. This receipt is independently verifiable by calling <code>verifyXRPPayment()</code> on the <a href="https://flare-explorer.flare.network/address/${config.paymentVerifierAddress}">PaymentVerifierMainnet</a> contract at <code>${config.paymentVerifierAddress}</code> on Flare mainnet.</p>
</div>
</div>
</body></html>`);
    return;
  }

  // No attestation found — check if tx exists on XRPL
  const txData = await fetchXrplTx(txHash);

  if (!txData) {
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Receipt Not Found — XRPLink</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1e293b;background:#f8fafc;line-height:1.6;padding:2rem 1rem;display:flex;align-items:center;justify-content:center;min-height:60vh}
.card{max-width:520px;text-align:center;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:3rem 2rem}
.card .icon{font-size:3rem;margin-bottom:1rem}
.card h2{font-size:1.25rem;margin-bottom:0.5rem}
.card p{color:#64748b;font-size:0.9rem;margin-bottom:1.5rem}
.card .btn{display:inline-block;padding:0.6rem 1.5rem;border-radius:8px;font-weight:600;font-size:0.85rem;text-decoration:none;background:#6366f1;color:#fff}
.card .btn:hover{background:#4f46e5}
.card .note{margin-top:1rem;font-size:0.8rem;color:#94a3b8}
</style></head>
<body>
<div class="card">
<div class="icon">🔍</div>
<h2>Transaction Not Found</h2>
<p>No XRP transaction with the hash <code style="font-size:0.8rem;word-break:break-all">${escapeHtml(txHash)}</code> was found on the XRP Ledger.</p>
<a href="/" class="btn">Back to Home</a>
</div>
</body></html>`);
    return;
  }

  // Transaction exists on XRPL but no receipt yet
  const amountFormatted = txData.Amount ? formatXrpAmount(txData.Amount) : "—";
  const memoData = txData.Memos?.[0]?.Memo?.MemoData || "";
  const memoStr = memoData ? Buffer.from(memoData, "hex").toString("utf8").replace(/\0+$/, "") : "";
  const txDate = txData.date ? formatTimestamp(txData.date) : "—";

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Attest This Payment — XRPLink</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1e293b;background:#f8fafc;line-height:1.6;padding:2rem 1rem}
.card{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:2.5rem}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:2rem}
.header .brand{font-weight:700;font-size:1.1rem;color:#0f172a}
.header .brand span{color:#6366f1}
.header .badge{background:#f59e0b;color:#fffbeb;padding:0.3rem 0.75rem;border-radius:6px;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.03em}
h1{font-size:1.25rem;margin-bottom:0.25rem;color:#0f172a}
.subtitle{color:#64748b;font-size:0.85rem;margin-bottom:1.5rem}
.row{display:flex;justify-content:space-between;padding:0.75rem 0;border-bottom:1px solid #f1f5f9;font-size:0.88rem}
.row:last-child{border:none}
.row .key{color:#64748b;flex-shrink:0}
.row .value{color:#1e293b;font-family:"SF Mono","Fira Code","JetBrains Mono",monospace;font-size:0.8rem;text-align:right;word-break:break-all;max-width:65%}
.actions{margin-top:2rem;display:flex;gap:1rem}
.actions a{padding:0.6rem 1.25rem;border-radius:8px;font-weight:600;font-size:0.85rem;text-decoration:none;display:inline-block}
.btn-primary{background:#6366f1;color:#fff}
.btn-primary:hover{background:#4f46e5}
.btn-outline{background:transparent;color:#6366f1;border:1.5px solid #6366f1}
.btn-outline:hover{background:#eef2ff}
.tip{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:1rem 1.25rem;margin-top:1.5rem;font-size:0.85rem;color:#92400e}
.tip code{background:#fef3c7;padding:0.1rem 0.3rem;border-radius:3px;font-size:0.8rem}
.footer{text-align:center;margin-top:2rem;padding-top:1.5rem;border-top:1px solid #f1f5f9;font-size:0.8rem;color:#94a3b8}
.footer a{color:#6366f1;text-decoration:none}
@media(max-width:480px){.row{flex-direction:column;gap:0.25rem}.row .value{text-align:left;max-width:100%}}
</style></head>
<body>
<div class="card">
<div class="header">
  <div class="brand">XRPL<span>ink</span></div>
  <div class="badge">Not Yet Attested</div>
</div>
<h1>XRP Payment Found</h1>
<p class="subtitle">This transaction exists on the XRP Ledger but hasn't been attested yet. Generate a verified receipt below.</p>

<div class="section-title" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:0.75rem;font-weight:600">Transaction Details</div>
<div class="row"><span class="key">Transaction Hash</span><span class="value">${txHash}</span></div>
<div class="row"><span class="key">Source Address</span><span class="value">${escapeHtml(txData.Account)}</span></div>
<div class="row"><span class="key">Destination</span><span class="value">${escapeHtml(txData.Destination)}</span></div>
<div class="row"><span class="key">Amount</span><span class="value">${amountFormatted}</span></div>
<div class="row"><span class="key">Timestamp</span><span class="value">${txDate}</span></div>
${memoStr ? `<div class="row"><span class="key">Memo</span><span class="value">${escapeHtml(memoStr)}</span></div>` : ""}
${txData.DestinationTag ? `<div class="row"><span class="key">Destination Tag</span><span class="value">${txData.DestinationTag}</span></div>` : ""}

<div class="tip">
  <strong>Want a verified receipt?</strong> Use our API to attest this payment. Receipts are cryptographically verified on the Flare Network and independently verifiable.
  <br><br>
  <code style="display:block;background:#fef3c7;padding:0.75rem;border-radius:6px;margin-top:0.5rem;line-height:1.5">
    # Get an API key at /dashboard<br>
    curl -X POST https://${req.headers.host}/api/v1/verify/xrp-payment \<br>
    &nbsp;&nbsp;-H "Content-Type: application/json" \<br>
    &nbsp;&nbsp;-H "X-API-Key: sk_live_..." \<br>
    &nbsp;&nbsp;-d '{"txHash": "${txHash}"}'
  </code>
</div>

<div class="actions">
  <a href="/dashboard" class="btn btn-primary">Get an API Key</a>
  <a href="https://livenet.xrpl.org/transactions/${txHash}" class="btn btn-outline" target="_blank">View on XRPL Explorer</a>
</div>

<div class="footer">
  <p><a href="/">XRPLink</a> — Cryptographically Verified XRP Payment Receipts</p>
</div>
</div>
</body></html>`);
});

// --- MCP documentation resources served as JSON (for HTTP clients) ---

router.get("/mcp/resources", async (_req: Request, res: Response) => {
  const resources = getResources();
  const result = [];
  for (const r of resources) {
    const text = await readResource(r.uri);
    result.push({ uri: r.uri, name: r.name, description: r.description, content: text });
  }
  res.json(result);
});

router.get("/mcp/prompts", (_req: Request, res: Response) => {
  const defs = getPromptDefs();
  res.json(defs);
});

// --- Authenticated routes ---

router.post("/api/v1/verify/xrp-payment", requireApiKey, async (req: Request, res: Response) => {
  const { txHash } = req.body;

  if (!txHash || typeof txHash !== "string") {
    return res.status(400).json(formatError("MISSING_TX_HASH", undefined, "txHash is required"));
  }

  const cleanHash = txHash.replace(/^0x/i, "").toUpperCase();
  if (!isHexTxHash(cleanHash)) {
    return res.status(400).json(formatError("INVALID_TX_HASH"));
  }

  const cached = store.getByTxHash(cleanHash);
  if (cached) {
    if (cached.status === "verified") {
      return res.json({ id: cached.id, txHash: cleanHash, roundId: cached.roundId, status: cached.status, cached: true });
    }
    return res.json({ id: cached.id, txHash: cleanHash, roundId: cached.roundId, status: cached.status } satisfies VerifyResponse);
  }

  if (config.paymentVerifierAddress) {
    try {
      const alreadyVerified = await fdc.isAlreadyVerified(cleanHash);
      if (alreadyVerified) {
        const record = store.createAttestation(cleanHash);
        store.updateAttestation(record.id, { status: "verified" });
        return res.json({ id: record.id, txHash: cleanHash, roundId: null, status: "verified" } satisfies VerifyResponse);
      }
    } catch {}
  }

  const attestation = store.createAttestation(cleanHash);

  try {
    const proofOwner = fdc.getProofOwner();
    const abiEncoded = await fdc.prepareRequest(cleanHash, proofOwner);
    store.updateAttestation(attestation.id, { abiEncodedRequest: abiEncoded });

    const { roundId, txHash: submitTxHash } = await fdc.submitRequest(abiEncoded);
    store.updateAttestation(attestation.id, { roundId, status: "pending" });

    console.log(`Attestation ${attestation.id}: submitted to round ${roundId} (tx: ${submitTxHash})`);

    pollForProof(attestation.id, roundId, abiEncoded).catch((err) => {
      console.error(`Polling failed for ${attestation.id}:`, err.message);
      store.updateAttestation(attestation.id, { status: "failed", error: err.message });
    });

    return res.status(202).json({ id: attestation.id, txHash: cleanHash, roundId, status: "pending" } satisfies VerifyResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    store.updateAttestation(attestation.id, { status: "failed", error: message });
    console.error(`Attestation ${attestation.id} failed:`, message);
    return res.status(500).json(formatError("SUBMIT_FAILED", { message }));
  }
});

router.get("/api/v1/status/:id", requireApiKey, (req: Request, res: Response) => {
  const attestation = store.getAttestation(req.params.id);
  if (!attestation) {
    return res.status(404).json(formatError("NOT_FOUND"));
  }
  return res.json({
    id: attestation.id, txHash: attestation.txHash, roundId: attestation.roundId,
    status: attestation.status, proof: attestation.proof,
    verifiedTxHash: attestation.verifiedTxHash, error: attestation.error,
  } satisfies StatusResponse);
});

router.get("/api/v1/status-by-tx/:txHash", requireApiKey, (req: Request, res: Response) => {
  const txHash = req.params.txHash.replace(/^0x/i, "").toUpperCase();
  if (!isHexTxHash(txHash)) {
    return res.status(400).json(formatError("INVALID_TX_HASH"));
  }
  const attestation = store.getByTxHash(txHash);
  if (!attestation) {
    return res.status(404).json(formatError("NOT_FOUND"));
  }
  return res.json({
    id: attestation.id, txHash: attestation.txHash, roundId: attestation.roundId,
    status: attestation.status, proof: attestation.proof,
    verifiedTxHash: attestation.verifiedTxHash, error: attestation.error,
  } satisfies StatusResponse);
});

router.post("/api/v1/webhooks", requireApiKey, (req: Request, res: Response) => {
  const { url, attestationId } = req.body as RegisterWebhookBody;
  if (!url || typeof url !== "string") {
    return res.status(400).json(formatError("MISSING_URL"));
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json(formatError("INVALID_URL"));
  }
  if (attestationId && !store.getAttestation(attestationId)) {
    return res.status(400).json(formatError("MISSING_ATTESTATION_ID"));
  }
  const webhook = store.registerWebhook(url, attestationId || null);
  return res.status(201).json({ id: webhook.id, url: webhook.url, attestationId: webhook.attestationId });
});

// --- Admin routes ---

router.get("/api/v1/admin/white-label", requireApiKey, (req: Request, res: Response) => {
  if ((req as any).apiKey.tier !== "pro") {
    return res.status(403).json(formatError("FORBIDDEN"));
  }
  res.json(whiteLabel.get());
});

router.put("/api/v1/admin/white-label", requireApiKey, (req: Request, res: Response) => {
  if ((req as any).apiKey.tier !== "pro") {
    return res.status(403).json(formatError("FORBIDDEN"));
  }
  const updated = whiteLabel.update(req.body);
  res.json(updated);
});

router.post("/api/v1/admin/keys", requireApiKey, (req: Request, res: Response) => {
  const requester = (req as any).apiKey;
  if (!requester || requester.tier !== "pro") {
    return res.status(403).json(formatError("FORBIDDEN"));
  }
  const { name, tier } = req.body as { name?: string; tier?: Tier };
  const apiKey = store.createApiKey(name || "unnamed", tier || "free");
  return res.status(201).json({ key: apiKey.key, name: apiKey.name, tier: apiKey.tier });
});

router.get("/api/v1/admin/keys", requireApiKey, (req: Request, res: Response) => {
  const requester = (req as any).apiKey;
  if (!requester || requester.tier !== "pro") {
    return res.status(403).json(formatError("FORBIDDEN"));
  }
  return res.json(store.listApiKeys());
});

router.delete("/api/v1/admin/keys/:key", requireApiKey, (req: Request, res: Response) => {
  const requester = (req as any).apiKey;
  if (!requester || requester.tier !== "pro") {
    return res.status(403).json(formatError("FORBIDDEN"));
  }
  const deleted = store.deleteApiKey(req.params.key);
  if (!deleted) {
    return res.status(404).json(formatError("NOT_FOUND"));
  }
  return res.json({ status: "deleted" });
});

// --- Background Polling ---

async function pollForProof(id: string, roundId: number, abiEncoded: string, attempt = 1) {
  await sleep(config.pollIntervalMs);

  let proofData;
  try {
    proofData = await fdc.fetchProof(roundId, abiEncoded);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Poll attempt ${attempt} for ${id}: ${message}`);
    if (attempt < config.maxPollAttempts) return pollForProof(id, roundId, abiEncoded, attempt + 1);
    store.updateAttestation(id, { status: "failed", error: `Polling exhausted: ${message}` });
    return;
  }

  if (!proofData) {
    console.log(`Poll attempt ${attempt} for ${id}: not ready yet`);
    if (attempt < config.maxPollAttempts) return pollForProof(id, roundId, abiEncoded, attempt + 1);
    store.updateAttestation(id, { status: "not_found", error: "Proof not found after max poll attempts" });
    return;
  }

  store.updateAttestation(id, { proof: proofData, status: "ready" });

  if (config.paymentVerifierAddress) {
    try {
      const verifiedTxHash = await fdc.verifyProofOnChain(proofData, config.paymentVerifierAddress);
      store.updateAttestation(id, { verifiedTxHash, status: "verified" });
      console.log(`Attestation ${id}: verified on-chain (${verifiedTxHash})`);
      // Notify SSE clients
      notifySseClients({ event: "attestation.completed", id, status: "verified", verifiedTxHash });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Attestation ${id}: on-chain verification failed:`, message);
      store.updateAttestation(id, { error: message });
    }
  }

  await deliverWebhooks(id);
}

function notifySseClients(data: Record<string, unknown>) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
