import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { v4 as uuid } from "uuid";
import { Attestation, AttestationStatus, ApiKey, Tier, Webhook } from "./types.js";

const DATA_DIR = "data";
const ATTESTATIONS_PATH = `${DATA_DIR}/attestations.json`;
const API_KEYS_PATH = `${DATA_DIR}/api-keys.json`;
const WEBHOOKS_PATH = `${DATA_DIR}/webhooks.json`;

interface PersistedData {
  attestations: Record<string, Attestation>;
  txHashIndex: Record<string, string>;
  apiKeys: Record<string, ApiKey>;
  webhooks: Record<string, Webhook>;
}

class JsonFileStore {
  private data: PersistedData;

  constructor() {
    this.data = this.load();
  }

  private load(): PersistedData {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    const empty = { attestations: {}, txHashIndex: {}, apiKeys: {}, webhooks: {} };
    try {
      const attestations = this.readJson(ATTESTATIONS_PATH) || {};
      const txHashIndex: Record<string, string> = {};
      for (const [id, a] of Object.entries(attestations)) {
        txHashIndex[(a as Attestation).txHash.toLowerCase()] = id;
      }
      const apiKeys = this.readJson(API_KEYS_PATH) || {};
      const webhooks = this.readJson(WEBHOOKS_PATH) || {};
      return { attestations, txHashIndex, apiKeys, webhooks };
    } catch {
      return empty;
    }
  }

  private readJson(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }

  private syncPersist() {
    writeFileSync(ATTESTATIONS_PATH, JSON.stringify(this.data.attestations, null, 2));
    writeFileSync(API_KEYS_PATH, JSON.stringify(this.data.apiKeys, null, 2));
    writeFileSync(WEBHOOKS_PATH, JSON.stringify(this.data.webhooks, null, 2));
  }

  // --- Attestations ---

  createAttestation(txHash: string): Attestation {
    const existing = this.data.txHashIndex[txHash.toLowerCase()];
    if (existing) return this.data.attestations[existing];

    const id = uuid();
    const now = new Date().toISOString();
    const record: Attestation = {
      id, txHash, status: "pending", roundId: null,
      abiEncodedRequest: null, proof: null, verifiedTxHash: null, error: null,
      createdAt: now, updatedAt: now,
    };
    this.data.attestations[id] = record;
    this.data.txHashIndex[txHash.toLowerCase()] = id;
    this.syncPersist();
    return record;
  }

  getAttestation(id: string): Attestation | undefined {
    return this.data.attestations[id];
  }

  getByTxHash(txHash: string): Attestation | undefined {
    const id = this.data.txHashIndex[txHash.toLowerCase()];
    if (!id) return undefined;
    return this.data.attestations[id];
  }

  updateAttestation(id: string, updates: Partial<Attestation>): Attestation | undefined {
    const record = this.data.attestations[id];
    if (!record) return undefined;
    const updated = { ...record, ...updates, updatedAt: new Date().toISOString() };
    this.data.attestations[id] = updated;
    this.syncPersist();
    return updated;
  }

  listAttestations(): Attestation[] {
    return Object.values(this.data.attestations).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  // --- API Keys ---

  createApiKey(name: string, tier: Tier = "free"): ApiKey {
    const key = "sk_live_" + uuid().replace(/-/g, "") + uuid().replace(/-/g, "");
    const record: ApiKey = { key, name, tier, active: true, usageCount: 0, createdAt: new Date().toISOString() };
    this.data.apiKeys[key] = record;
    this.syncPersist();
    return record;
  }

  getApiKey(key: string): ApiKey | undefined {
    return this.data.apiKeys[key];
  }

  listApiKeys(): ApiKey[] {
    return Object.values(this.data.apiKeys);
  }

  deleteApiKey(key: string): boolean {
    const exists = !!this.data.apiKeys[key];
    delete this.data.apiKeys[key];
    if (exists) this.syncPersist();
    return exists;
  }

  incrementApiKeyUsage(key: string) {
    const record = this.data.apiKeys[key];
    if (record) {
      record.usageCount++;
      this.syncPersist();
    }
  }

  // --- Webhooks ---

  registerWebhook(url: string, attestationId: string | null): Webhook {
    const id = uuid();
    const hook: Webhook = { id, url, attestationId, createdAt: new Date().toISOString() };
    this.data.webhooks[id] = hook;
    this.syncPersist();
    return hook;
  }

  getWebhooksForAttestation(attestationId: string): Webhook[] {
    return Object.values(this.data.webhooks).filter(
      (h) => h.attestationId === null || h.attestationId === attestationId
    );
  }

  removeWebhook(id: string): boolean {
    const exists = !!this.data.webhooks[id];
    delete this.data.webhooks[id];
    if (exists) this.syncPersist();
    return exists;
  }
}

export const store = new JsonFileStore();
