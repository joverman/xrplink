import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { v4 as uuid } from "uuid";
import { Attestation, AttestationStatus, ApiKey, Tier, Webhook } from "./types.js";
import {
  apiKeyDisplayParts,
  apiKeyLookupId,
  generateApiKeyPlaintext,
  hashApiKey,
  isPlaintextApiKey,
} from "./api-keys.js";

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

export const MAX_WEBHOOKS_PER_KEY = 10;

export function sanitizeWebhookRecord(hook: Webhook): Webhook {
  const scoped = Boolean(hook.attestationId) && Boolean(hook.apiKeyId);
  return { ...hook, active: scoped && hook.active !== false };
}

interface Store {
  createAttestation(txHash: string, ownerKeyId?: string): Promise<Attestation>;
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
  setApiKeyUsageCount(key: string, count: number): Promise<boolean>;
  /** Copy monthly attestation quota from an old key id onto a new one, then drop the old rows. */
  rekeyAttestationUsage(oldKey: string, newKey: string): Promise<void>;
  registerWebhook(url: string, attestationId: string, apiKeyId: string, secret?: string): Promise<Webhook>;
  countWebhooksForApiKey(apiKeyId: string): Promise<number>;
  getWebhooksForAttestation(attestationId: string): Promise<Webhook[]>;
  getWebhook(id: string): Promise<Webhook | undefined>;
  removeWebhook(id: string): Promise<boolean>;
  getHealth(): StoreHealth;
  /** Get attestation count for an API key in a specific billing period */
  getAttestationUsage(apiKey: string, periodKey: string): Promise<number>;
  /** Increment attestation count for an API key in a specific billing period */
  incrementAttestationUsage(apiKey: string, periodKey: string): Promise<number>;
}

function migrateJsonApiKeys(raw: Record<string, ApiKey>): Record<string, ApiKey> {
  const next: Record<string, ApiKey> = {};
  for (const [id, record] of Object.entries(raw)) {
    if (isPlaintextApiKey(id) || isPlaintextApiKey(record.key)) {
      const plaintext = isPlaintextApiKey(id) ? id : record.key;
      const hashed = hashApiKey(plaintext);
      const display = apiKeyDisplayParts(plaintext);
      next[hashed] = {
        ...record,
        key: hashed,
        keyPrefix: record.keyPrefix || display.keyPrefix,
        keyLast4: record.keyLast4 || display.keyLast4,
      };
    } else {
      next[id] = record;
    }
  }
  return next;
}

function migrateJsonAttestationUsage(raw: Record<string, number>): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [usageKey, count] of Object.entries(raw)) {
    const sep = usageKey.lastIndexOf(":");
    const id = sep >= 0 ? usageKey.slice(0, sep) : usageKey;
    const period = sep >= 0 ? usageKey.slice(sep + 1) : "";
    const normalized = apiKeyLookupId(id);
    const newKey = period ? `${normalized}:${period}` : normalized;
    next[newKey] = (next[newKey] || 0) + count;
  }
  return next;
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
    try {
      this.syncPersist();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
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
      const apiKeys = migrateJsonApiKeys((this.readJson(API_KEYS_PATH) || {}) as Record<string, ApiKey>);
      const rawWebhooks = (this.readJson(WEBHOOKS_PATH) || {}) as Record<string, Webhook>;
      const webhooks: Record<string, Webhook> = {};
      for (const [id, hook] of Object.entries(rawWebhooks)) {
        webhooks[id] = sanitizeWebhookRecord(hook);
      }
      const attestationUsage = migrateJsonAttestationUsage(
        (this.readJson(ATTESTATION_USAGE_PATH) || {}) as Record<string, number>
      );
      this.lastError = undefined;
      const loaded = { attestations, txHashIndex, apiKeys, webhooks, attestationUsage };
      return loaded;
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

  async createAttestation(txHash: string, ownerKeyId?: string): Promise<Attestation> {
    const existing = this.data.txHashIndex[txHash.toLowerCase()];
    if (existing) return this.data.attestations[existing];

    const id = uuid();
    const now = new Date().toISOString();
    const record: Attestation = {
      id, txHash, status: "pending", roundId: null,
      abiEncodedRequest: null, proof: null, verifiedTxHash: null, error: null,
      createdAt: now, updatedAt: now,
      ownerKeyId: ownerKeyId || null,
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
    const plaintext = generateApiKeyPlaintext();
    const id = hashApiKey(plaintext);
    const display = apiKeyDisplayParts(plaintext);
    const record: ApiKey = {
      key: id,
      name,
      tier,
      active: true,
      usageCount: 0,
      createdAt: new Date().toISOString(),
      ...display,
    };
    this.data.apiKeys[id] = record;
    this.syncPersist();
    return { ...record, key: plaintext };
  }

  async getApiKey(key: string): Promise<ApiKey | undefined> {
    const hashed = apiKeyLookupId(key);
    if (this.data.apiKeys[hashed]) return this.data.apiKeys[hashed];
    if (this.data.apiKeys[key]) return this.data.apiKeys[key];
    return undefined;
  }

  async listApiKeys(): Promise<ApiKey[]> {
    return Object.values(this.data.apiKeys);
  }

  async deleteApiKey(key: string): Promise<boolean> {
    const hashed = apiKeyLookupId(key);
    const id = this.data.apiKeys[hashed] ? hashed : this.data.apiKeys[key] ? key : "";
    if (!id) return false;
    delete this.data.apiKeys[id];
    this.syncPersist();
    return true;
  }

  async incrementApiKeyUsage(key: string): Promise<void> {
    const hashed = apiKeyLookupId(key);
    const record = this.data.apiKeys[hashed] || this.data.apiKeys[key];
    if (record) {
      record.usageCount++;
      this.syncPersist();
    }
  }

  async updateApiKeyTier(key: string, tier: Tier): Promise<boolean> {
    const hashed = apiKeyLookupId(key);
    const record = this.data.apiKeys[hashed] || this.data.apiKeys[key];
    if (!record) return false;
    record.tier = tier;
    this.syncPersist();
    return true;
  }

  async setApiKeyUsageCount(key: string, count: number): Promise<boolean> {
    const hashed = apiKeyLookupId(key);
    const record = this.data.apiKeys[hashed] || this.data.apiKeys[key];
    if (!record) return false;
    record.usageCount = count;
    this.syncPersist();
    return true;
  }

  async rekeyAttestationUsage(oldKey: string, newKey: string): Promise<void> {
    const from = apiKeyLookupId(oldKey);
    const to = apiKeyLookupId(newKey);
    const next: Record<string, number> = {};
    for (const [usageKey, count] of Object.entries(this.data.attestationUsage)) {
      const sep = usageKey.lastIndexOf(":");
      const id = sep >= 0 ? usageKey.slice(0, sep) : usageKey;
      const period = sep >= 0 ? usageKey.slice(sep + 1) : "";
      const normalized = apiKeyLookupId(id);
      if (normalized === from || id === oldKey) {
        next[`${to}:${period}`] = (next[`${to}:${period}`] || 0) + count;
      } else {
        next[usageKey] = count;
      }
    }
    this.data.attestationUsage = next;
    this.syncPersist();
  }

  async registerWebhook(url: string, attestationId: string, apiKeyId: string, secret?: string): Promise<Webhook> {
    const id = uuid();
    const hook: Webhook = {
      id,
      url,
      attestationId,
      apiKeyId: apiKeyLookupId(apiKeyId),
      secret,
      createdAt: new Date().toISOString(),
      active: true,
    };
    this.data.webhooks[id] = hook;
    this.syncPersist();
    return hook;
  }

  async countWebhooksForApiKey(apiKeyId: string): Promise<number> {
    const hashed = apiKeyLookupId(apiKeyId);
    return Object.values(this.data.webhooks).filter(
      (h) => h.active !== false && h.apiKeyId && apiKeyLookupId(h.apiKeyId) === hashed
    ).length;
  }

  async getWebhooksForAttestation(attestationId: string): Promise<Webhook[]> {
    return Object.values(this.data.webhooks).filter(
      (h) => h.active !== false && Boolean(h.apiKeyId) && h.attestationId === attestationId
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

  async getAttestationUsage(apiKey: string, periodKey: string): Promise<number> {
    const usageKey = `${apiKeyLookupId(apiKey)}:${periodKey}`;
    return this.data.attestationUsage[usageKey] || 0;
  }

  async incrementAttestationUsage(apiKey: string, periodKey: string): Promise<number> {
    const usageKey = `${apiKeyLookupId(apiKey)}:${periodKey}`;
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
    await this.pool.query(`ALTER TABLE attestations ADD COLUMN IF NOT EXISTS owner_key_id VARCHAR(100)`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        key VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        tier VARCHAR(20) NOT NULL DEFAULT 'free',
        active BOOLEAN NOT NULL DEFAULT true,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        key_prefix VARCHAR(16),
        key_last4 VARCHAR(8)
      );
    `);
    await this.pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix VARCHAR(16)`);
    await this.pool.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_last4 VARCHAR(8)`);

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
    await this.pool.query(`ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS api_key_id VARCHAR(100)`);
    await this.pool.query(`ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true`);
    await this.pool.query(
      `UPDATE webhooks SET active = false WHERE attestation_id IS NULL OR api_key_id IS NULL`
    );

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

  private rowToApiKey(row: any): ApiKey {
    return {
      key: row.key,
      name: row.name,
      tier: row.tier as Tier,
      active: row.active,
      usageCount: row.usage_count,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      keyPrefix: row.key_prefix || undefined,
      keyLast4: row.key_last4 || undefined,
    };
  }

  private async migratePostgresApiKeyRow(row: any): Promise<void> {
    if (!isPlaintextApiKey(row.key)) return;
    const plaintext = row.key;
    const hashed = hashApiKey(plaintext);
    const display = apiKeyDisplayParts(plaintext);
    await this.pool.query(
      `INSERT INTO api_keys (key, name, tier, active, usage_count, created_at, key_prefix, key_last4)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO NOTHING`,
      [
        hashed,
        row.name,
        row.tier,
        row.active,
        row.usage_count,
        row.created_at,
        display.keyPrefix,
        display.keyLast4,
      ]
    );
    await this.pool.query(`DELETE FROM api_keys WHERE key = $1`, [plaintext]);
    await this.pool.query(
      `UPDATE attestation_usage SET api_key = $1 WHERE api_key = $2`,
      [hashed, plaintext]
    );
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
      ownerKeyId: row.owner_key_id || null,
    };
  }

  async createAttestation(txHash: string, ownerKeyId?: string): Promise<Attestation> {
    const existing = await this.getByTxHash(txHash);
    if (existing) return existing;

    const id = uuid();
    const result = await this.pool.query(
      `INSERT INTO attestations (id, tx_hash, owner_key_id) VALUES ($1, $2, $3) RETURNING *`,
      [id, txHash, ownerKeyId || null]
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
    const plaintext = generateApiKeyPlaintext();
    const id = hashApiKey(plaintext);
    const display = apiKeyDisplayParts(plaintext);
    const result = await this.pool.query(
      `INSERT INTO api_keys (key, name, tier, key_prefix, key_last4) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, name, tier, display.keyPrefix, display.keyLast4]
    );
    const record = this.rowToApiKey(result.rows[0]);
    return { ...record, key: plaintext };
  }

  async getApiKey(key: string): Promise<ApiKey | undefined> {
    const hashed = apiKeyLookupId(key);
    let result = await this.pool.query(`SELECT * FROM api_keys WHERE key = $1`, [hashed]);
    if (!result.rows[0] && key !== hashed) {
      result = await this.pool.query(`SELECT * FROM api_keys WHERE key = $1`, [key]);
      if (result.rows[0] && isPlaintextApiKey(result.rows[0].key)) {
        await this.migratePostgresApiKeyRow(result.rows[0]);
        result = await this.pool.query(`SELECT * FROM api_keys WHERE key = $1`, [hashed]);
      }
    }
    if (!result.rows[0]) return undefined;
    return this.rowToApiKey(result.rows[0]);
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const result = await this.pool.query(`SELECT * FROM api_keys ORDER BY created_at DESC`);
    return result.rows.map((row: any) => this.rowToApiKey(row));
  }

  async deleteApiKey(key: string): Promise<boolean> {
    const hashed = apiKeyLookupId(key);
    let result = await this.pool.query(`DELETE FROM api_keys WHERE key = $1`, [hashed]);
    if (result.rowCount === 0 && key !== hashed) {
      result = await this.pool.query(`DELETE FROM api_keys WHERE key = $1`, [key]);
    }
    return result.rowCount > 0;
  }

  async incrementApiKeyUsage(key: string): Promise<void> {
    const hashed = apiKeyLookupId(key);
    const updated = await this.pool.query(`UPDATE api_keys SET usage_count = usage_count + 1 WHERE key = $1`, [hashed]);
    if (updated.rowCount === 0 && key !== hashed) {
      await this.pool.query(`UPDATE api_keys SET usage_count = usage_count + 1 WHERE key = $1`, [key]);
    }
  }

  async updateApiKeyTier(key: string, tier: Tier): Promise<boolean> {
    const hashed = apiKeyLookupId(key);
    let result = await this.pool.query(`UPDATE api_keys SET tier = $1 WHERE key = $2`, [tier, hashed]);
    if (result.rowCount === 0 && key !== hashed) {
      result = await this.pool.query(`UPDATE api_keys SET tier = $1 WHERE key = $2`, [tier, key]);
    }
    return result.rowCount > 0;
  }

  async setApiKeyUsageCount(key: string, count: number): Promise<boolean> {
    const hashed = apiKeyLookupId(key);
    let result = await this.pool.query(`UPDATE api_keys SET usage_count = $1 WHERE key = $2`, [count, hashed]);
    if (result.rowCount === 0 && key !== hashed) {
      result = await this.pool.query(`UPDATE api_keys SET usage_count = $1 WHERE key = $2`, [count, key]);
    }
    return result.rowCount > 0;
  }

  async rekeyAttestationUsage(oldKey: string, newKey: string): Promise<void> {
    const from = apiKeyLookupId(oldKey);
    const to = apiKeyLookupId(newKey);
    await this.pool.query(
      `UPDATE attestation_usage SET api_key = $1 WHERE api_key = $2 OR api_key = $3`,
      [to, from, oldKey]
    );
  }

  private rowToWebhook(row: any): Webhook {
    return {
      id: row.id,
      url: row.url,
      attestationId: row.attestation_id,
      apiKeyId: row.api_key_id || undefined,
      secret: row.secret,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      active: row.active !== false,
    };
  }

  async registerWebhook(url: string, attestationId: string, apiKeyId: string, secret?: string): Promise<Webhook> {
    const id = uuid();
    const result = await this.pool.query(
      `INSERT INTO webhooks (id, url, attestation_id, api_key_id, secret, active) VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [id, url, attestationId, apiKeyLookupId(apiKeyId), secret || null]
    );
    return this.rowToWebhook(result.rows[0]);
  }

  async countWebhooksForApiKey(apiKeyId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM webhooks WHERE active = true AND api_key_id = $1`,
      [apiKeyLookupId(apiKeyId)]
    );
    return result.rows[0]?.n || 0;
  }

  async getWebhooksForAttestation(attestationId: string): Promise<Webhook[]> {
    const result = await this.pool.query(
      `SELECT * FROM webhooks WHERE active = true AND api_key_id IS NOT NULL AND attestation_id = $1`,
      [attestationId]
    );
    return result.rows.map((row: any) => this.rowToWebhook(row));
  }

  async getWebhook(id: string): Promise<Webhook | undefined> {
    const result = await this.pool.query(`SELECT * FROM webhooks WHERE id = $1`, [id]);
    if (!result.rows[0]) return undefined;
    return this.rowToWebhook(result.rows[0]);
  }

  async removeWebhook(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM webhooks WHERE id = $1`, [id]);
    return result.rowCount > 0;
  }

  async getAttestationUsage(apiKey: string, periodKey: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT usage_count FROM attestation_usage WHERE api_key = $1 AND month_key = $2`,
      [apiKeyLookupId(apiKey), periodKey]
    );
    return result.rows[0]?.usage_count || 0;
  }

  async incrementAttestationUsage(apiKey: string, periodKey: string): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO attestation_usage (api_key, month_key, usage_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (api_key, month_key)
       DO UPDATE SET usage_count = attestation_usage.usage_count + 1
       RETURNING usage_count`,
      [apiKeyLookupId(apiKey), periodKey]
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
