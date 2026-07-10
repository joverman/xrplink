import { config } from "./config.js";
import { store } from "./store.js";
import { Attestation } from "./types.js";

export async function deliverWebhooks(attestationId: string) {
  const attestation = store.get(attestationId);
  if (!attestation) return;

  const hooks = store.getWebhooksForAttestation(attestationId);
  if (hooks.length === 0) return;

  const payload = {
    event: "attestation.completed",
    id: attestation.id,
    txHash: attestation.txHash,
    roundId: attestation.roundId,
    status: attestation.status,
    verifiedTxHash: attestation.verifiedTxHash,
    proof: attestation.proof
      ? {
          response: attestation.proof.response,
          merkleProofEntries: attestation.proof.proof.length,
        }
      : null,
  };

  const results = await Promise.allSettled(
    hooks.map((hook) => deliverWebhook(hook.url, payload))
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      console.error(`Webhook delivery failed for ${hooks[i].url}:`, result.reason);
    }
  }
}

async function deliverWebhook(url: string, payload: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`Webhook ${url} returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
