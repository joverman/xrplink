import { Router, Request, Response } from "express";
import { store } from "./store.js";
import { config, activeNetwork } from "./config.js";
import * as fdc from "./fdc-service.js";
import { deliverWebhooks } from "./webhook-service.js";
import { requireApiKey } from "./middleware.js";
import { whiteLabel } from "./white-label.js";
import {
  AttestationStatus, VerifyResponse, StatusResponse,
  RegisterWebhookBody, ApiError, Tier,
} from "./types.js";

const router = Router();

function isHexTxHash(v: string): boolean {
  return /^[0-9A-Fa-f]{64}$/.test(v);
}

/**
 * GET /health
 * Public — no API key required.
 */
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

/**
 * GET /dashboard
 * Public — simple HTML status page.
 */
router.get("/dashboard", (_req: Request, res: Response) => {
  const wl = whiteLabel.get();
  const attestations = store.listAttestations();
  const apiKeys = store.listApiKeys();

  let apiKeyRows = apiKeys.map((k) => `
    <tr><td><code>${k.key.slice(0, 16)}...</code></td><td>${k.name}</td>
    <td><span class="tier ${k.tier}">${k.tier}</span></td><td>${k.active ? "✅" : "❌"}</td>
    <td>${k.usageCount}</td><td>${new Date(k.createdAt).toLocaleString()}</td></tr>
  `).join("");

  let attRows = attestations.slice(0, 50).map((a) => `
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

// --- Authenticated routes below ---

/** POST /api/v1/verify/xrp-payment */
router.post("/api/v1/verify/xrp-payment", requireApiKey, async (req: Request, res: Response) => {
  const { txHash } = req.body;

  if (!txHash || typeof txHash !== "string") {
    return res.status(400).json({ error: "txHash is required", code: "MISSING_TX_HASH" } satisfies ApiError);
  }

  const cleanHash = txHash.replace(/^0x/i, "").toUpperCase();
  if (!isHexTxHash(cleanHash)) {
    return res.status(400).json({ error: "Invalid txHash format (expected 64-char hex)", code: "INVALID_TX_HASH" } satisfies ApiError);
  }

  // Check cache
  const cached = store.getByTxHash(cleanHash);
  if (cached) {
    if (cached.status === "verified") {
      return res.json({ id: cached.id, txHash: cleanHash, roundId: cached.roundId, status: cached.status, cached: true });
    }
    return res.json({ id: cached.id, txHash: cleanHash, roundId: cached.roundId, status: cached.status } satisfies VerifyResponse);
  }

  // Already verified on-chain?
  if (config.paymentVerifierAddress) {
    try {
      const alreadyVerified = await fdc.isAlreadyVerified(cleanHash);
      if (alreadyVerified) {
        const record = store.createAttestation(cleanHash);
        store.updateAttestation(record.id, { status: "verified" });
        return res.json({ id: record.id, txHash: cleanHash, roundId: null, status: "verified" } satisfies VerifyResponse);
      }
    } catch { /* contract call failed, proceed with submission */ }
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
    return res.status(500).json({ error: message, code: "SUBMIT_FAILED" } satisfies ApiError);
  }
});

/** GET /api/v1/status/:id */
router.get("/api/v1/status/:id", requireApiKey, (req: Request, res: Response) => {
  const attestation = store.getAttestation(req.params.id);
  if (!attestation) {
    return res.status(404).json({ error: "Attestation not found", code: "NOT_FOUND" } satisfies ApiError);
  }
  return res.json({
    id: attestation.id, txHash: attestation.txHash, roundId: attestation.roundId,
    status: attestation.status, proof: attestation.proof,
    verifiedTxHash: attestation.verifiedTxHash, error: attestation.error,
  } satisfies StatusResponse);
});

/** GET /api/v1/status-by-tx/:txHash */
router.get("/api/v1/status-by-tx/:txHash", requireApiKey, (req: Request, res: Response) => {
  const txHash = req.params.txHash.replace(/^0x/i, "").toUpperCase();
  if (!isHexTxHash(txHash)) {
    return res.status(400).json({ error: "Invalid txHash format", code: "INVALID_TX_HASH" } satisfies ApiError);
  }
  const attestation = store.getByTxHash(txHash);
  if (!attestation) {
    return res.status(404).json({ error: "Attestation not found for this txHash", code: "NOT_FOUND" } satisfies ApiError);
  }
  return res.json({
    id: attestation.id, txHash: attestation.txHash, roundId: attestation.roundId,
    status: attestation.status, proof: attestation.proof,
    verifiedTxHash: attestation.verifiedTxHash, error: attestation.error,
  } satisfies StatusResponse);
});

/** POST /api/v1/webhooks */
router.post("/api/v1/webhooks", requireApiKey, (req: Request, res: Response) => {
  const { url, attestationId } = req.body as RegisterWebhookBody;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required", code: "MISSING_URL" } satisfies ApiError);
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: "Invalid URL", code: "INVALID_URL" } satisfies ApiError);
  }
  if (attestationId && !store.getAttestation(attestationId)) {
    return res.status(400).json({ error: "attestationId not found", code: "INVALID_ATTESTATION_ID" } satisfies ApiError);
  }
  const webhook = store.registerWebhook(url, attestationId || null);
  return res.status(201).json({ id: webhook.id, url: webhook.url, attestationId: webhook.attestationId });
});

/** GET /api/v1/admin/white-label — Get current white-label config (pro only) */
router.get("/api/v1/admin/white-label", requireApiKey, (req: Request, res: Response) => {
  if ((req as any).apiKey.tier !== "pro") {
    return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" } satisfies ApiError);
  }
  res.json(whiteLabel.get());
});

/** PUT /api/v1/admin/white-label — Update white-label config (pro only) */
router.put("/api/v1/admin/white-label", requireApiKey, (req: Request, res: Response) => {
  if ((req as any).apiKey.tier !== "pro") {
    return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" } satisfies ApiError);
  }
  const updated = whiteLabel.update(req.body);
  res.json(updated);
});

// --- Admin routes ---

/** POST /api/v1/admin/keys — Generate a new API key */
router.post("/api/v1/admin/keys", requireApiKey, (req: Request, res: Response) => {
  const requester = (req as any).apiKey;
  if (!requester || requester.tier !== "pro") {
    return res.status(403).json({ error: "Only pro-tier keys can create new API keys", code: "FORBIDDEN" } satisfies ApiError);
  }
  const { name, tier } = req.body as { name?: string; tier?: Tier };
  const apiKey = store.createApiKey(name || "unnamed", tier || "free");
  return res.status(201).json({ key: apiKey.key, name: apiKey.name, tier: apiKey.tier });
});

/** GET /api/v1/admin/keys — List all API keys (pro only) */
router.get("/api/v1/admin/keys", requireApiKey, (req: Request, res: Response) => {
  const requester = (req as any).apiKey;
  if (!requester || requester.tier !== "pro") {
    return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" } satisfies ApiError);
  }
  return res.json(store.listApiKeys());
});

/** DELETE /api/v1/admin/keys/:key — Deactivate an API key */
router.delete("/api/v1/admin/keys/:key", requireApiKey, (req: Request, res: Response) => {
  const requester = (req as any).apiKey;
  if (!requester || requester.tier !== "pro") {
    return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" } satisfies ApiError);
  }
  const deleted = store.deleteApiKey(req.params.key);
  if (!deleted) {
    return res.status(404).json({ error: "API key not found", code: "NOT_FOUND" } satisfies ApiError);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Attestation ${id}: on-chain verification failed:`, message);
      store.updateAttestation(id, { error: message });
    }
  }

  await deliverWebhooks(id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
