import { Router, Request, Response } from "express";
import { store } from "./store.js";
import { config } from "./config.js";
import * as fdc from "./fdc-service.js";
import { deliverWebhooks } from "./webhook-service.js";
import {
  AttestationStatus,
  VerifyResponse,
  StatusResponse,
  RegisterWebhookBody,
  ApiError,
} from "./types.js";

const router = Router();

function isHexTxHash(v: string): boolean {
  return /^[0-9A-Fa-f]{64}$/.test(v);
}

/**
 * POST /api/v1/verify/xrp-payment
 * Body: { txHash: string }
 * Submits an XRP payment hash for FDC attestation.
 */
router.post("/api/v1/verify/xrp-payment", async (req: Request, res: Response) => {
  const { txHash } = req.body;

  if (!txHash || typeof txHash !== "string") {
    return res.status(400).json({ error: "txHash is required", code: "MISSING_TX_HASH" } satisfies ApiError);
  }

  const cleanHash = txHash.replace(/^0x/i, "").toUpperCase();
  if (!isHexTxHash(cleanHash)) {
    return res.status(400).json({ error: "Invalid txHash format (expected 64-char hex)", code: "INVALID_TX_HASH" } satisfies ApiError);
  }

  // Check cache first
  const cached = store.getByTxHash(cleanHash);
  if (cached) {
    if (cached.status === "verified") {
      return res.json({ id: cached.id, txHash: cleanHash, roundId: cached.roundId, status: cached.status, cached: true } satisfies VerifyResponse & { cached: boolean });
    }
    // Already in progress
    return res.json({ id: cached.id, txHash: cleanHash, roundId: cached.roundId, status: cached.status } satisfies VerifyResponse);
  }

  // Already verified on-chain?
  if (config.paymentVerifierAddress) {
    const alreadyVerified = await fdc.isAlreadyVerified(cleanHash);
    if (alreadyVerified) {
      const record = store.create(cleanHash);
      store.update(record.id, { status: "verified" });
      return res.json({ id: record.id, txHash: cleanHash, roundId: null, status: "verified" } satisfies VerifyResponse);
    }
  }

  // Create attestation record
  const attestation = store.create(cleanHash);

  try {
    // Step 1: Prepare request via verifier API
    const proofOwner = fdc.getProofOwner();
    const abiEncoded = await fdc.prepareRequest(cleanHash, proofOwner);
    store.update(attestation.id, { abiEncodedRequest: abiEncoded });

    // Step 2: Submit to FdcHub
    const { roundId, txHash: submitTxHash } = await fdc.submitRequest(abiEncoded);
    store.update(attestation.id, { roundId, status: "pending" });

    console.log(`Attestation ${attestation.id}: submitted to round ${roundId} (tx: ${submitTxHash})`);

    // Step 3: Start background polling for proof
    pollForProof(attestation.id, roundId, abiEncoded).catch((err) => {
      console.error(`Polling failed for ${attestation.id}:`, err.message);
      store.update(attestation.id, { status: "failed", error: err.message });
    });

    return res.status(202).json({
      id: attestation.id,
      txHash: cleanHash,
      roundId,
      status: "pending",
    } satisfies VerifyResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    store.update(attestation.id, { status: "failed", error: message });
    console.error(`Attestation ${attestation.id} failed:`, message);
    return res.status(500).json({ error: message, code: "SUBMIT_FAILED" } satisfies ApiError);
  }
});

/**
 * GET /api/v1/status/:id
 * Returns the current state of an attestation by its ID.
 */
router.get("/api/v1/status/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const attestation = store.get(id);

  if (!attestation) {
    return res.status(404).json({ error: "Attestation not found", code: "NOT_FOUND" } satisfies ApiError);
  }

  return res.json({
    id: attestation.id,
    txHash: attestation.txHash,
    roundId: attestation.roundId,
    status: attestation.status,
    proof: attestation.proof,
    verifiedTxHash: attestation.verifiedTxHash,
    error: attestation.error,
  } satisfies StatusResponse);
});

/**
 * GET /api/v1/status-by-tx/:txHash
 * Returns the current state of an attestation by txHash.
 */
router.get("/api/v1/status-by-tx/:txHash", (req: Request, res: Response) => {
  const txHash = req.params.txHash.replace(/^0x/i, "").toUpperCase();
  if (!isHexTxHash(txHash)) {
    return res.status(400).json({ error: "Invalid txHash format", code: "INVALID_TX_HASH" } satisfies ApiError);
  }

  const attestation = store.getByTxHash(txHash);
  if (!attestation) {
    return res.status(404).json({ error: "Attestation not found for this txHash", code: "NOT_FOUND" } satisfies ApiError);
  }

  return res.json({
    id: attestation.id,
    txHash: attestation.txHash,
    roundId: attestation.roundId,
    status: attestation.status,
    proof: attestation.proof,
    verifiedTxHash: attestation.verifiedTxHash,
    error: attestation.error,
  } satisfies StatusResponse);
});

/**
 * POST /api/v1/webhooks
 * Body: { url: string, attestationId?: string }
 * Register a webhook to be called when an attestation completes.
 */
router.post("/api/v1/webhooks", (req: Request, res: Response) => {
  const { url, attestationId } = req.body as RegisterWebhookBody;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url is required", code: "MISSING_URL" } satisfies ApiError);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Invalid protocol");
    }
  } catch {
    return res.status(400).json({ error: "Invalid URL", code: "INVALID_URL" } satisfies ApiError);
  }

  if (attestationId && !store.get(attestationId)) {
    return res.status(400).json({ error: "attestationId not found", code: "INVALID_ATTESTATION_ID" } satisfies ApiError);
  }

  const webhook = store.registerWebhook(url, attestationId || null);
  return res.status(201).json({ id: webhook.id, url: webhook.url, attestationId: webhook.attestationId });
});

/**
 * GET /health
 * Health check endpoint.
 */
router.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    network: "coston2",
    paymentVerifier: config.paymentVerifierAddress || "not configured",
    uptime: process.uptime(),
  });
});

// --- Background Polling ---

async function pollForProof(
  id: string,
  roundId: number,
  abiEncoded: string,
  attempt = 1
) {
  const delay = config.pollIntervalMs;
  await sleep(delay);

  let proofData;

  try {
    proofData = await fdc.fetchProof(roundId, abiEncoded);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Poll attempt ${attempt} for ${id}: ${message}`);
    if (attempt < config.maxPollAttempts) {
      return pollForProof(id, roundId, abiEncoded, attempt + 1);
    }
    store.update(id, { status: "failed", error: `Polling exhausted: ${message}` });
    return;
  }

  if (!proofData) {
    console.log(`Poll attempt ${attempt} for ${id}: not ready yet`);
    if (attempt < config.maxPollAttempts) {
      return pollForProof(id, roundId, abiEncoded, attempt + 1);
    }
    store.update(id, { status: "not_found", error: "Proof not found after max poll attempts" });
    return;
  }

  // Proof found!
  store.update(id, { proof: proofData, status: "ready" });

  // Optional: verify on-chain
  if (config.paymentVerifierAddress) {
    try {
      const verifiedTxHash = await fdc.verifyProofOnChain(proofData, config.paymentVerifierAddress);
      store.update(id, { verifiedTxHash, status: "verified" });
      console.log(`Attestation ${id}: verified on-chain (${verifiedTxHash})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Attestation ${id}: on-chain verification failed:`, message);
      store.update(id, { error: message });
    }
  }

  // Fire webhooks
  await deliverWebhooks(id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
