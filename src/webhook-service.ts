import { createHmac } from "crypto";
import { store } from "./store.js";
import { callerOwnsAttestation } from "./attestation-view.js";
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from "./webhook-url.js";

const WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || "";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function signPayload(payload: string, timestamp: number, secret: string): string {
  const signedPayload = `${timestamp}.${payload}`;
  return createHmac("sha256", secret).update(signedPayload).digest("hex");
}

interface WebhookPayload {
  event: string;
  id: string;
  txHash: string;
  roundId: number | null;
  status: string;
  verifiedTxHash: string | null;
  proof: {
    response: unknown;
    merkleProofEntries: number;
  } | null;
}

export async function deliverWebhooks(attestationId: string): Promise<void> {
  const attestation = await store.getAttestation(attestationId);
  if (!attestation) return;

  const hooks = await store.getWebhooksForAttestation(attestationId);
  const owned = hooks.filter((h) => h.apiKeyId && callerOwnsAttestation(attestation, h.apiKeyId));
  if (owned.length === 0) return;

  const payload: WebhookPayload = {
    event: "attestation.completed",
    id: attestation.id,
    txHash: attestation.txHash,
    roundId: attestation.roundId,
    status: attestation.status,
    verifiedTxHash: attestation.verifiedTxHash,
    proof: attestation.proof
      ? { response: attestation.proof.response, merkleProofEntries: attestation.proof.proof.length }
      : null,
  };

  const results = await Promise.allSettled(
    owned.map((hook) => deliverWithRetry(hook.url, payload, hook.secret))
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      console.error(`Webhook delivery failed for ${owned[i].url}:`, (results[i] as PromiseRejectedResult).reason);
    }
  }
}

async function deliverWithRetry(
  url: string,
  payload: WebhookPayload,
  secret?: string,
  attempt = 1
): Promise<void> {
  try {
    await deliver(url, payload, secret);
  } catch (err) {
    if (err instanceof UnsafeWebhookUrlError) throw err;
    if (attempt < MAX_RETRIES) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.log(`Webhook retry ${attempt}/${MAX_RETRIES} for ${url} in ${backoff}ms`);
      await sleep(backoff);
      return deliverWithRetry(url, payload, secret, attempt + 1);
    }
    throw err;
  }
}

async function deliver(url: string, payload: WebhookPayload, secret?: string): Promise<void> {
  await assertSafeWebhookUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);

  const signingSecret = secret || WEBHOOK_SIGNING_SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Timestamp": String(timestamp),
  };

  if (signingSecret) {
    const signature = signPayload(body, timestamp, signingSecret);
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      throw new UnsafeWebhookUrlError(`Webhook URL redirected (${response.status}); redirects are not followed`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateWebhookSignature(
  body: string,
  signature: string,
  timestamp: number,
  secret: string,
  toleranceSecs = 300
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSecs) {
    return false;
  }

  const expectedSig = signPayload(body, timestamp, secret);
  const providedSig = signature.replace(/^sha256=/, "");

  return timingSafeEqual(expectedSig, providedSig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export { UnsafeWebhookUrlError, assertSafeWebhookUrl } from "./webhook-url.js";
