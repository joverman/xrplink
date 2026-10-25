import { createHmac } from "crypto";
import { store } from "./store.js";
import { isProduction } from "./env-validation.js";

const WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || "";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

const PRIVATE_IP_RANGES = [
  /^127\./,                    // Loopback
  /^10\./,                     // RFC1918
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // RFC1918
  /^192\.168\./,               // RFC1918
  /^169\.254\./,               // Link-local
  /^0\./,                      // Current network
  /^::1$/,                     // IPv6 loopback
  /^fc00:/i,                   // IPv6 unique local
  /^fe80:/i,                   // IPv6 link-local
  /^fd/i,                      // IPv6 private
];

const BLOCKED_HOSTNAMES = [
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "metadata.google",
  "metadata.aws",
  "instance-data",
  "[::1]",
];

function isPrivateOrBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (BLOCKED_HOSTNAMES.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`))) {
      return true;
    }

    for (const pattern of PRIVATE_IP_RANGES) {
      if (pattern.test(hostname)) {
        return true;
      }
    }

    return false;
  } catch {
    return true;
  }
}

function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

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
  if (hooks.length === 0) return;

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
    hooks.map((hook) => deliverWithRetry(hook.url, payload, hook.secret))
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      console.error(`Webhook delivery failed for ${hooks[i].url}:`, (results[i] as PromiseRejectedResult).reason);
    }
  }
}

async function deliverWithRetry(
  url: string,
  payload: WebhookPayload,
  secret?: string,
  attempt = 1
): Promise<void> {
  const isProd = isProduction();

  if (isProd && !isHttpsUrl(url)) {
    throw new Error(`Webhook URL must use HTTPS in production: ${url}`);
  }

  if (isPrivateOrBlockedUrl(url)) {
    throw new Error(`Webhook URL blocked (private/internal address): ${url}`);
  }

  try {
    await deliver(url, payload, secret);
  } catch (err) {
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
    });

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
