#!/usr/bin/env tsx
/**
 * Migration script: JSON file storage -> PostgreSQL
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/migrate-to-postgres.ts
 *
 * This script reads data from the JSON files (data/*.json) and imports
 * them into a PostgreSQL database. It's safe to run multiple times
 * as it uses ON CONFLICT to upsert existing records.
 *
 * Prerequisites:
 *   - DATABASE_URL environment variable set to your Neon/Postgres connection string
 *   - npm install (pg package must be available)
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR || "data";

interface Attestation {
  id: string;
  txHash: string;
  status: string;
  roundId: number | null;
  abiEncodedRequest: string | null;
  proof: unknown | null;
  verifiedTxHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ApiKey {
  key: string;
  name: string;
  tier: string;
  active: boolean;
  usageCount: number;
  createdAt: string;
}

interface Webhook {
  id: string;
  url: string;
  attestationId: string | null;
  secret?: string;
  createdAt: string;
}

interface User {
  id: string;
  email: string;
  passwordHash: string;
  apiKeyIds: string[];
  stripeCustomerId: string;
  tier: string;
  createdAt: string;
  sessionVersion?: number;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Error: DATABASE_URL environment variable is not set.");
    console.error("Usage: DATABASE_URL=postgres://... tsx scripts/migrate-to-postgres.ts");
    process.exit(1);
  }

  console.log("Connecting to PostgreSQL...");
  const pg = await import("pg");
  const pool = new pg.default.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await pool.query("SELECT 1");
    console.log("Connected successfully.\n");
  } catch (err) {
    console.error("Failed to connect to database:", err);
    process.exit(1);
  }

  console.log("Creating tables if not exists...");
  await createTables(pool);

  const stats = { attestations: 0, apiKeys: 0, webhooks: 0, users: 0 };

  const attestationsPath = join(DATA_DIR, "attestations.json");
  if (existsSync(attestationsPath)) {
    const attestations: Record<string, Attestation> = JSON.parse(readFileSync(attestationsPath, "utf8"));
    console.log(`\nMigrating ${Object.keys(attestations).length} attestations...`);

    for (const [id, att] of Object.entries(attestations)) {
      await pool.query(
        `INSERT INTO attestations (id, tx_hash, status, round_id, abi_encoded_request, proof, verified_tx_hash, error, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           tx_hash = EXCLUDED.tx_hash,
           status = EXCLUDED.status,
           round_id = EXCLUDED.round_id,
           abi_encoded_request = EXCLUDED.abi_encoded_request,
           proof = EXCLUDED.proof,
           verified_tx_hash = EXCLUDED.verified_tx_hash,
           error = EXCLUDED.error,
           updated_at = EXCLUDED.updated_at`,
        [
          att.id,
          att.txHash,
          att.status,
          att.roundId,
          att.abiEncodedRequest,
          att.proof ? JSON.stringify(att.proof) : null,
          att.verifiedTxHash,
          att.error,
          att.createdAt,
          att.updatedAt,
        ]
      );
      stats.attestations++;
    }
    console.log(`  ✓ Migrated ${stats.attestations} attestations`);
  } else {
    console.log("No attestations.json found, skipping.");
  }

  const apiKeysPath = join(DATA_DIR, "api-keys.json");
  if (existsSync(apiKeysPath)) {
    const apiKeys: Record<string, ApiKey> = JSON.parse(readFileSync(apiKeysPath, "utf8"));
    console.log(`\nMigrating ${Object.keys(apiKeys).length} API keys...`);

    for (const [key, ak] of Object.entries(apiKeys)) {
      await pool.query(
        `INSERT INTO api_keys (key, name, tier, active, usage_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (key) DO UPDATE SET
           name = EXCLUDED.name,
           tier = EXCLUDED.tier,
           active = EXCLUDED.active,
           usage_count = EXCLUDED.usage_count`,
        [ak.key, ak.name, ak.tier, ak.active, ak.usageCount, ak.createdAt]
      );
      stats.apiKeys++;
    }
    console.log(`  ✓ Migrated ${stats.apiKeys} API keys`);
  } else {
    console.log("No api-keys.json found, skipping.");
  }

  const webhooksPath = join(DATA_DIR, "webhooks.json");
  if (existsSync(webhooksPath)) {
    const webhooks: Record<string, Webhook> = JSON.parse(readFileSync(webhooksPath, "utf8"));
    console.log(`\nMigrating ${Object.keys(webhooks).length} webhooks...`);

    for (const [id, wh] of Object.entries(webhooks)) {
      await pool.query(
        `INSERT INTO webhooks (id, url, attestation_id, secret, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           url = EXCLUDED.url,
           attestation_id = EXCLUDED.attestation_id,
           secret = EXCLUDED.secret`,
        [wh.id, wh.url, wh.attestationId, wh.secret || null, wh.createdAt]
      );
      stats.webhooks++;
    }
    console.log(`  ✓ Migrated ${stats.webhooks} webhooks`);
  } else {
    console.log("No webhooks.json found, skipping.");
  }

  const usersPath = join(DATA_DIR, "users.json");
  if (existsSync(usersPath)) {
    const users: Record<string, User> = JSON.parse(readFileSync(usersPath, "utf8"));
    console.log(`\nMigrating ${Object.keys(users).length} users...`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        api_key_ids TEXT[] DEFAULT '{}',
        stripe_customer_id VARCHAR(255),
        tier VARCHAR(20) NOT NULL DEFAULT 'free',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        session_version INTEGER NOT NULL DEFAULT 1,
        reset_token_hash VARCHAR(64),
        reset_token_expires_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(64);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at BIGINT;
    `);

    for (const [id, user] of Object.entries(users)) {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, api_key_ids, stripe_customer_id, tier, created_at, session_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           api_key_ids = EXCLUDED.api_key_ids,
           stripe_customer_id = EXCLUDED.stripe_customer_id,
           tier = EXCLUDED.tier,
           session_version = EXCLUDED.session_version`,
        [
          user.id,
          user.email,
          user.passwordHash,
          user.apiKeyIds,
          user.stripeCustomerId || null,
          user.tier,
          user.createdAt,
          user.sessionVersion || 1,
        ]
      );
      stats.users++;
    }
    console.log(`  ✓ Migrated ${stats.users} users`);
  } else {
    console.log("No users.json found, skipping.");
  }

  console.log("\n✅ Migration complete!");
  console.log(`   Attestations: ${stats.attestations}`);
  console.log(`   API Keys: ${stats.apiKeys}`);
  console.log(`   Webhooks: ${stats.webhooks}`);
  console.log(`   Users: ${stats.users}`);

  await pool.end();
}

async function createTables(pool: any) {
  await pool.query(`
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      tier VARCHAR(20) NOT NULL DEFAULT 'free',
      active BOOLEAN NOT NULL DEFAULT true,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id UUID PRIMARY KEY,
      url TEXT NOT NULL,
      attestation_id UUID,
      secret VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_attestation ON webhooks(attestation_id);
  `);

  console.log("  ✓ Tables created/verified");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
