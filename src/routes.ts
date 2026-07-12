import { Router, Request, Response } from "express";
import express from "express";
import { store } from "./store.js";
import { config, activeNetwork } from "./config.js";
import * as fdc from "./fdc-service.js";
import { deliverWebhooks } from "./webhook-service.js";
import { requireApiKey } from "./middleware.js";
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

router.get("/dashboard", (_req: Request, res: Response) => {
  const wl = whiteLabel.get();
  const attestations = store.listAttestations();
  const apiKeys = store.listApiKeys();

  const apiKeyRows = apiKeys.map((k) => `
    <tr><td><code>${k.key.slice(0, 16)}...</code></td><td>${k.name}</td>
    <td><span class="tier ${k.tier}">${k.tier}</span></td><td>${k.active ? "✅" : "❌"}</td>
    <td>${k.usageCount}</td><td>${new Date(k.createdAt).toLocaleString()}</td></tr>
  `).join("");

  const attRows = attestations.slice(0, 50).map((a) => `
    <tr><td><code>${a.id.slice(0, 8)}</code></td><td><code>${a.txHash.slice(0, 16)}...</code></td>
    <td><span class="status ${a.status}">${a.status}</span></td><td>${a.roundId ?? "—"}</td>
    <td>${a.verifiedTxHash ? `<code>${a.verifiedTxHash.slice(0, 16)}...</code>` : "—"}</td>
    <td>${new Date(a.createdAt).toLocaleString()}</td></tr>
  `).join("");

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${wl.brandName} Dashboard</title>
${wl.brandName !== "XRPLink" ? whiteLabel.injectCss() : ""}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}
h2{font-size:1.1rem;margin:1.5rem 0 0.5rem;color:#94a3b8}
.sub{color:#64748b;font-size:0.85rem;margin-bottom:1rem}
table{width:100%;border-collapse:collapse;font-size:0.8rem}
th,td{text-align:left;padding:0.5rem 0.75rem;border-bottom:1px solid #1e293b}
th{color:#64748b;font-weight:600;text-transform:uppercase;font-size:0.7rem;letter-spacing:0.05em}
code{font-family:"JetBrains Mono","Fira Code",monospace;font-size:0.75rem;background:#1e293b;padding:0.15rem 0.35rem;border-radius:3px}
.status,.tier{display:inline-block;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.7rem;font-weight:600}
.status.verified{background:#065f46;color:#6ee7b7}.status.pending{background:#1e3a5f;color:#93c5fd}
.status.ready{background:#5b3a1e;color:#fcd34d}.status.failed,.status.not_found{background:#5f1e1e;color:#fca5a5}
.tier.free{background:#1e293b;color:#94a3b8}.tier.paid{background:#1e3a5f;color:#60a5fa}.tier.pro{background:#3b1e5f;color:#c084fc}
.stats{display:flex;gap:1rem;margin:1rem 0}
.stat-card{background:#1e293b;border-radius:8px;padding:1rem;flex:1}
.stat-card .num{font-size:1.5rem;font-weight:700}
.stat-card .label{font-size:0.75rem;color:#64748b;margin-top:0.25rem}
</style></head>
<body>
<div class="brand-header">
  <h1>${wl.logoUrl ? `<img src="${wl.logoUrl}" class="brand-logo">` : ""}${wl.brandName}</h1>
  <p>Network: ${config.network} · ${config.paymentVerifierAddress ? "✅ Verifier configured" : "⚠️ Verifier not set"}</p>
</div>
<div class="stats">
  <div class="stat-card"><div class="num">${attestations.length}</div><div class="label">Total Attestations</div></div>
  <div class="stat-card"><div class="num">${attestations.filter(a => a.status === "verified").length}</div><div class="label">Verified</div></div>
  <div class="stat-card"><div class="num">${apiKeys.length}</div><div class="label">API Keys</div></div>
  <div class="stat-card"><div class="num">${apiKeys.reduce((s, k) => s + k.usageCount, 0)}</div><div class="label">Total Requests</div></div>
</div>
<h2>API Keys</h2>
<table><thead><tr><th>Key</th><th>Name</th><th>Tier</th><th>Active</th><th>Uses</th><th>Created</th></tr></thead>
<tbody>${apiKeyRows || '<tr><td colspan="6" style="color:#64748b">No API keys yet</td></tr>'}</tbody></table>
<h2>Recent Attestations</h2>
<table><thead><tr><th>ID</th><th>TX Hash</th><th>Status</th><th>Round</th><th>Verified TX</th><th>Created</th></tr></thead>
<tbody>${attRows || '<tr><td colspan="6" style="color:#64748b">No attestations yet</td></tr>'}</tbody></table>
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
