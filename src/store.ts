import { v4 as uuid } from "uuid";
import { Attestation, AttestationStatus, Webhook } from "./types.js";

class AttestationStore {
  private attestations = new Map<string, Attestation>();
  private txHashIndex = new Map<string, string>();
  private webhooks = new Map<string, Webhook>();

  create(txHash: string): Attestation {
    const existing = this.txHashIndex.get(txHash.toLowerCase());
    if (existing) {
      return this.attestations.get(existing)!;
    }

    const id = uuid();
    const now = new Date().toISOString();
    const record: Attestation = {
      id,
      txHash,
      status: "pending",
      roundId: null,
      abiEncodedRequest: null,
      proof: null,
      verifiedTxHash: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.attestations.set(id, record);
    this.txHashIndex.set(txHash.toLowerCase(), id);
    return record;
  }

  get(id: string): Attestation | undefined {
    return this.attestations.get(id);
  }

  getByTxHash(txHash: string): Attestation | undefined {
    const id = this.txHashIndex.get(txHash.toLowerCase());
    if (!id) return undefined;
    return this.attestations.get(id);
  }

  update(id: string, updates: Partial<Attestation>): Attestation | undefined {
    const record = this.attestations.get(id);
    if (!record) return undefined;
    const updated = { ...record, ...updates, updatedAt: new Date().toISOString() };
    this.attestations.set(id, updated);
    return updated;
  }

  list(): Attestation[] {
    return Array.from(this.attestations.values());
  }

  registerWebhook(url: string, attestationId: string | null): Webhook {
    const id = uuid();
    const hook: Webhook = { id, url, attestationId, createdAt: new Date().toISOString() };
    this.webhooks.set(id, hook);
    return hook;
  }

  getWebhooksForAttestation(attestationId: string): Webhook[] {
    return Array.from(this.webhooks.values()).filter(
      (h) => h.attestationId === null || h.attestationId === attestationId
    );
  }

  removeWebhook(id: string): boolean {
    return this.webhooks.delete(id);
  }
}

export const store = new AttestationStore();
