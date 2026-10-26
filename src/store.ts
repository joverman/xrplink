import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { v4 as uuid } from "uuid";
import { Attestation, AttestationStatus, ApiKey, Tier, Webhook } from "./types.js";
import { getCurrentMonthKey } from "./attestation-quota.js";

const DATA_DIR = process.env.DATA_DIR || "data";
const ATTESTATIONS_PATH = join(DATA_DIR, "attestations.json");
const API_KEYS_PATH = join(DATA_DIR, "api-keys.json");
const WEBHOOKS_PATH = join(DATA_DIR, "webhooks.json");
const ATTESTATION_USAGE_PATH = join(DATA_DIR, "attestation-usage.json");

interface PersistedData {
  attestations: Record<string, Attestation>;
  txHashIndex: Record<string, string>;
  apiKeys: Record<string, ApiKey>;
  webhooks: Record<string, Webhook>;
  /** Attestation usage per API key per month: { "apiKey:YYYY-MM": count } */
  attestationUsage: Record<string, number>;
}

interface StoreHealth {
  ok: boolean;
  type: "json" | "postgres";
  error?: string;
}

interface Store {
  createAttestation(txHash: string): Promise<Attestation>;
  getAttestation(id: string): Promise<Attestation | undefined>;
  getByTxHash(txHash: string): Promise<Attestation | undefined>;
  updateAttestation(id: string, updates: Partial<Attestation>): Promise<Attestation | undefined>;
  listAttestations(): Promise<Attestation[]>;
  createApiKey(name: string, tier?: Tier): Promise<ApiKey>;
  getApiKey(key: string): Promise<ApiKey | undefined>;
  listApiKeys(): Promise<ApiKey[]>;
  deleteApiKey(key: string): Promise<boolean>;
  incrementApiKeyUsage(key: string): Promise<void>;
  updateApiKeyTier(key: string, tier: Tier): Promise<boolean>;
  registerWebhook(url: string, attestationId: string | null, secret?: string): Promise<Webhook>;
  getWebhooksForAttestation(attestationId: string): Promise<Webhook[]>;
  getWebhook(id: string): Promise<Webhook | undefined>;
  removeWebhook(id: string): Promise<boolean>;
  getHealth(): StoreHealth;
  /** Get monthly attestation count for an API key in the current billing month */
  getAttestationUsage(apiKey: string): Promise<number>;
  /** Increment monthly attestation count for an API key */
  incrementAttestationUsage(apiKey: string): Promise<number>;
}

function atomicWriteFileSync(path: string, data: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tempPath, data);
    renameSync(tempPath, path);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {}
    throw err;
  }
}

class JsonFileStore implements Store {
  private data: PersistedData;
  private lastError?: string;

  constructor() {
    this.data = this.load();
  }

  private load(): PersistedData {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    const empty: PersistedData = { attestations: {}, txHashIndex: {}, apiKeys: {}, webhooks: {}, attestationUsage: {} };
    try {
      const attestationsRaw = this.readJson(ATTESTATIONS_PATH) || {};
      const attestations = attestationsRaw as Record<string, Attestation>;
      const txHashIndex: Record<string, string> = {};
      for (const [id, a] of Object.entries(attestations)) {
        txHashIndex[a.txHash.toLowerCase()] = id;
      }
      const apiKeys = (this.readJson(API_KEYS_PATH) || {}) as Record<string, ApiKey>;
      const webhooks = (this.readJson(WEBHOOKS_PATH) || {}) as Record<string, Webhook>;
      const attestationUsage = (this.readJson(ATTESTATION_USAGE_PATH) || {}) as Record<string, number>;
      this.lastError = undefined;
      return { attestations, txHashIndex, apiKeys, webhooks, attestationUsage };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return empty;
    }
  }

  private readJson(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }

  private syncPersist() {
    try {
      atomicWriteFileSync(ATTESTATIONS_PATH, JSON.stringify(this.data.attestations, null, 2));
      atomicWriteFileSync(API_KEYS_PATH, JSON.stringify(this.data.apiKeys, null, 2));
      atomicWriteFileSync(WEBHOOKS_PATH, JSON.stringify(this.data.webhooks, null, 2));
      atomicWriteFileSync(ATTESTATION_USAGE_PATH, JSON.stringify(this.data.attestationUsage, null, 2));
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  getHealth(): StoreHealth {
    return {
      ok: !this.lastError,
      type: "json",
      error: this.lastError,
    };
  }

  async createAttestation(txHash: string): Promise<Attestation> {
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

  async getAttestation(id: string): Promise<Attestation | undefined> {
    return this.data.attestations[id];
  }

  async getByTxHash(txHash: string): Promise<Attestation | undefined> {
    const id = this.data.txHashIndex[txHash.toLowerCase()];
    if (!id) return undefined;
    return this.data.attestations[id];
  }

  async updateAttestation(id: string, updates: Partial<Attestation>): Promise<Attestation | undefined> {
    const record = this.data.attestations[id];
    if (!record) return undefined;
    const updated = { ...record, ...updates, updatedAt: new Date().toISOString() };
    this.data.attestations[id] = updated;
    this.syncPersist();
    return updated;
  }

  async listAttestations(): Promise<Attestation[]> {
    return Object.values(this.data.attestations).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async createApiKey(name: string, tier: Tier = "free"): Promise<ApiKey> {
    const key = "sk_live_" + uuid().replace(/-/g, "") + uuid().replace(/-/g, "");
    const record: ApiKey = { key, name, tier, active: true, usageCount: 0, createdAt: new Date().toISOString() };
    this.data.apiKeys[key] = record;
    this.syncPersist();
    return record;
  }

  async getApiKey(key: string): Promise<ApiKey | undefined> {
    return this.data.apiKeys[key];
  }

  async listApiKeys(): Promise<ApiKey[]> {
    return Object.values(this.data.apiKeys);
  }

  async deleteApiKey(key: string): Promise<boolean> {
    const exists = !!this.data.apiKeys[key];
    delete this.data.apiKeys[key];
    if (exists) this.syncPersist();
    return exists;
  }

  async incrementApiKeyUsage(key: string): Promise<void> {
    const record = this.data.apiKeys[key];
    if (record) {
      record.usageCount++;
      this.syncPersist();
    }
  }

  async updateApiKeyTier(key: string, tier: Tier): Promise<boolean> {
    const record = this.data.apiKeys[key];
    if (!record) return false;
    record.tier = tier;
    this.syncPersist();
    return true;
  }

  async registerWebhook(url: string, attestationId: string | null, secret?: string): Promise<Webhook> {
    const id = uuid();
    const hook: Webhook = { id, url, attestationId, secret, createdAt: new Date().toISOString() };
    this.data.webhooks[id] = hook;
    this.syncPersist();
    return hook;
  }

  async getWebhooksForAttestation(attestationId: string): Promise<Webhook[]> {
    return Object.values(this.data.webhooks).filter(
      (h) => h.attestationId === null || h.attestationId === attestationId
    );
  }

  async getWebhook(id: string): Promise<Webhook | undefined> {
    return this.data.webhooks[id];
  }

  async removeWebhook(id: string): Promise<boolean> {
    const exists = !!this.data.webhooks[id];
    delete this.data.webhooks[id];
    if (exists) this.syncPersist();
    return exists;
  }

  async getAttestationUsage(apiKey: string): Promise<number> {
    const monthKey = getCurrentMonthKey();
    const usageKey = `${apiKey}:${monthKey}`;
    return this.data.attestationUsage[usageKey] || 0;
  }

  async incrementAttestationUsage(apiKey: string): Promise<number> {
    const monthKey = getCurrentMonthKey();
    const usageKey = `${apiKey}:${monthKey}`;
    const current = this.data.attestationUsage[usageKey] || 0;
    this.data.attestationUsage[usageKey] = current + 1;
    this.syncPersist();
    return current + 1;
  }

  getData(): PersistedData {
    return this.data;
  }
}

class PostgresStore implements Store {
  private pool: any;
  private initialized = false;
  private lastError?: string;

  constructor(connectionString: string) {
    this.initPool(connectionString);
  }

  private async initPool(connectionString: string) {
    try {
      const pg = await import("pg");
      this.pool = new pg.default.Pool({ connectionString, ssl: { rejectUnauthorized: false } });
      await this.ensureTables();
      this.initialized = true;
      this.lastError = undefined;
      console.log("PostgreSQL connection established");
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error("PostgreSQL connection failed:", this.lastError);
      throw err;
    }
  }

  private async ensureTables() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS attestations (
        id UUID PRIMARY KEY,
        tx_hash VARCHAR(64) NOT NULL UNIQUE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        round_id INTEGER,
        abi_encoded_request TEXT,
        proof JSONB,
        verified_tx_hash VARCHAR(66),
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_attestations_tx_hash ON attestations(tx_hash);
      CREATE INDEX IF NOT EXISTS idx_attestations_status ON attestations(status);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        key VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        tier VARCHAR(20) NOT NULL DEFAULT 'free',
        active BOOLEAN NOT NULL DEFAULT true,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id UUID PRIMARY KEY,
        url TEXT NOT NULL,
        attestation_id UUID,
        secret VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_webhooks_attestation ON webhooks(attestation_id);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS attestation_usage (
        api_key VARCHAR(100) NOT NULL,
        month_key VARCHAR(7) NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (api_key, month_key)
      );
    `);
  }

  getHealth(): StoreHealth {
    return {
      ok: this.initialized && !this.lastError,
      type: "postgres",
      error: this.lastError,
    };
  }

  private rowToAttestation(row: any): Attestation {
    return {
      id: row.id,
      txHash: row.tx_hash,
      status: row.status as AttestationStatus,
      roundId: row.round_id,
      abiEncodedRequest: row.abi_encoded_request,
      proof: row.proof,
      verifiedTxHash: row.verified_tx_hash,
      error: row.error,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async createAttestation(txHash: string): Promise<Attestation> {
    const existing = await this.getByTxHash(txHash);
    if (existing) return existing;

    const id = uuid();
    const result = await this.pool.query(
      `INSERT INTO attestations (id, tx_hash) VALUES ($1, $2) RETURNING *`,
      [id, txHash]
    );
    return this.rowToAttestation(result.rows[0]);
  }

  async getAttestation(id: string): Promise<Attestation | undefined> {
    const result = await this.pool.query(`SELECT * FROM attestations WHERE id = $1`, [id]);
    return result.rows[0] ? this.rowToAttestation(result.rows[0]) : undefined;
  }

  async getByTxHash(txHash: string): Promise<Attestation | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM attestations WHERE LOWER(tx_hash) = LOWER($1)`,
      [txHash]
    );
    return result.rows[0] ? this.rowToAttestation(result.rows[0]) : undefined;
  }

  async updateAttestation(id: string, updates: Partial<Attestation>): Promise<Attestation | undefined> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (updates.status !== undefined) { fields.push(`status = $${idx++}`); values.push(updates.status); }
    if (updates.roundId !== undefined) { fields.push(`round_id = $${idx++}`); values.push(updates.roundId); }
    if (updates.abiEncodedRequest !== undefined) { fields.push(`abi_encoded_request = $${idx++}`); values.push(updates.abiEncodedRequest); }
    if (updates.proof !== undefined) { fields.push(`proof = $${idx++}`); values.push(JSON.stringify(updates.proof)); }
    if (updates.verifiedTxHash !== undefined) { fields.push(`verified_tx_hash = $${idx++}`); values.push(updates.verifiedTxHash); }
    if (updates.error !== undefined) { fields.push(`error = $${idx++}`); values.push(updates.error); }

    if (fields.length === 0) return this.getAttestation(id);

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await this.pool.query(
      `UPDATE attestations SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0] ? this.rowToAttestation(result.rows[0]) : undefined;
  }

  async listAttestations(): Promise<Attestation[]> {
    const result = await this.pool.query(`SELECT * FROM attestations ORDER BY created_at DESC`);
    return result.rows.map((r: any) => this.rowToAttestation(r));
  }

  async createApiKey(name: string, tier: Tier = "free"): Promise<ApiKey> {
    const key = "sk_live_" + uuid().replace(/-/g, "") + uuid().replace(/-/g, "");
    const result = await this.pool.query(
      `INSERT INTO api_keys (key, name, tier) VALUES ($1, $2, $3) RETURNING *`,
      [key, name, tier]
    );
    const row = result.rows[0];
    return {
      key: row.key,
      name: row.name,
      tier: row.tier as Tier,
      active: row.active,
      usageCount: row.usage_count,
      createdAt: row.created_at.toISOString(),
    };
  }

  async getApiKey(key: string): Promise<ApiKey | undefined> {
    const result = await this.pool.query(`SELECT * FROM api_keys WHERE key = $1`, [key]);
    if (!result.rows[0]) return undefined;
    const row = result.rows[0];
    return {
      key: row.key,
      name: row.name,
      tier: row.tier as Tier,
      active: row.active,
      usageCount: row.usage_count,
      createdAt: row.created_at.toISOString(),
    };
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const result = await this.pool.query(`SELECT * FROM api_keys ORDER BY created_at DESC`);
    return result.rows.map((row: any) => ({
      key: row.key,
      name: row.name,
      tier: row.tier as Tier,
      active: row.active,
      usageCount: row.usage_count,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async deleteApiKey(key: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM api_keys WHERE key = $1`, [key]);
    return result.rowCount > 0;
  }

  async incrementApiKeyUsage(key: string): Promise<void> {
    await this.pool.query(`UPDATE api_keys SET usage_count = usage_count + 1 WHERE key = $1`, [key]);
  }

  async updateApiKeyTier(key: string, tier: Tier): Promise<boolean> {
    const result = await this.pool.query(`UPDATE api_keys SET tier = $1 WHERE key = $2`, [tier, key]);
    return result.rowCount > 0;
  }

  async registerWebhook(url: string, attestationId: string | null, secret?: string): Promise<Webhook> {
    const id = uuid();
    const result = await this.pool.query(
      `INSERT INTO webhooks (id, url, attestation_id, secret) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, url, attestationId, secret || null]
    );
    const row = result.rows[0];
    return {
      id: row.id,
      url: row.url,
      attestationId: row.attestation_id,
      secret: row.secret,
      createdAt: row.created_at.toISOString(),
    };
  }

  async getWebhooksForAttestation(attestationId: string): Promise<Webhook[]> {
    const result = await this.pool.query(
      `SELECT * FROM webhooks WHERE attestation_id IS NULL OR attestation_id = $1`,
      [attestationId]
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      url: row.url,
      attestationId: row.attestation_id,
      secret: row.secret,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async getWebhook(id: string): Promise<Webhook | undefined> {
    const result = await this.pool.query(`SELECT * FROM webhooks WHERE id = $1`, [id]);
    if (!result.rows[0]) return undefined;
    const row = result.rows[0];
    return {
      id: row.id,
      url: row.url,
      attestationId: row.attestation_id,
      secret: row.secret,
      createdAt: row.created_at.toISOString(),
    };
  }

  async removeWebhook(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM webhooks WHERE id = $1`, [id]);
    return result.rowCount > 0;
  }

  async getAttestationUsage(apiKey: string): Promise<number> {
    const monthKey = getCurrentMonthKey();
    const result = await this.pool.query(
      `SELECT usage_count FROM attestation_usage WHERE api_key = $1 AND month_key = $2`,
      [apiKey, monthKey]
    );
    return result.rows[0]?.usage_count || 0;
  }

  async incrementAttestationUsage(apiKey: string): Promise<number> {
    const monthKey = getCurrentMonthKey();
    const result = await this.pool.query(
      `INSERT INTO attestation_usage (api_key, month_key, usage_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (api_key, month_key)
       DO UPDATE SET usage_count = attestation_usage.usage_count + 1
       RETURNING usage_count`,
      [apiKey, monthKey]
    );
    return result.rows[0].usage_count;
  }
}

let storeInstance: Store;

if (process.env.DATABASE_URL) {
  console.log("Using PostgreSQL storage");
  storeInstance = new PostgresStore(process.env.DATABASE_URL);
} else {
  console.log("Using JSON file storage");
  storeInstance = new JsonFileStore();
}

export const store = storeInstance;

export function getStoreHealth(): StoreHealth {
  return storeInstance.getHealth();
}

export function getJsonStoreData(): PersistedData | null {
  if (storeInstance instanceof JsonFileStore) {
    return storeInstance.getData();
  }
  return null;
}
