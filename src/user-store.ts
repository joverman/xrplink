import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { v4 as uuid } from "uuid";
import { Tier } from "./types.js";
import { apiKeyLookupId, hashApiKey, isPlaintextApiKey } from "./api-keys.js";

const DATA_DIR = process.env.DATA_DIR || "data";
const USERS_PATH = join(DATA_DIR, "users.json");

export type SubscriptionStatus = "active" | "past_due" | "canceled" | "none";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  apiKeyIds: string[];
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  tier: Tier;
  subscriptionStatus: SubscriptionStatus;
  createdAt: string;
  /** Stripe billing period start (Unix timestamp in seconds) */
  billingPeriodStart?: number;
  /** Stripe billing period end (Unix timestamp in seconds) */
  billingPeriodEnd?: number;
  /** txHashes this user attested or verified from the dashboard (newest last). */
  receiptTxHashes?: string[];
}

interface PersistedData {
  users: Record<string, StoredUser>;
  emailIndex: Record<string, string>;
}

class UserStore {
  private data: PersistedData;

  constructor() {
    this.data = this.load();
  }

  private load(): PersistedData {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const empty = { users: {}, emailIndex: {} };
    try {
      const raw = existsSync(USERS_PATH)
        ? JSON.parse(readFileSync(USERS_PATH, "utf8"))
        : {};
      const users = raw.users || raw;
      const emailIndex: Record<string, string> = {};
      let hashedIds = false;
      for (const [id, u] of Object.entries(users)) {
        const user = u as StoredUser;
        emailIndex[user.email.toLowerCase()] = id;
        if (Array.isArray(user.apiKeyIds)) {
          const nextIds = user.apiKeyIds.map((k) => (isPlaintextApiKey(k) ? hashApiKey(k) : k));
          if (nextIds.some((k, i) => k !== user.apiKeyIds[i])) {
            user.apiKeyIds = nextIds;
            hashedIds = true;
          }
        }
      }
      const loaded = { users, emailIndex };
      if (hashedIds) {
        this.data = loaded;
        this.persist();
      }
      return loaded;
    } catch {
      return empty;
    }
  }

  private persist() {
    const dir = dirname(USERS_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tempPath = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    try {
      writeFileSync(tempPath, JSON.stringify(this.data.users, null, 2));
      renameSync(tempPath, USERS_PATH);
    } catch (err) {
      try { unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  findByEmail(email: string): StoredUser | undefined {
    const id = this.data.emailIndex[email.toLowerCase()];
    return id ? this.data.users[id] : undefined;
  }

  findById(id: string): StoredUser | undefined {
    return this.data.users[id];
  }

  create(email: string, passwordHash: string): StoredUser {
    const id = uuid();
    const user: StoredUser = {
      id,
      email: email.toLowerCase(),
      passwordHash,
      apiKeyIds: [],
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      tier: "free",
      subscriptionStatus: "none",
      createdAt: new Date().toISOString(),
      receiptTxHashes: [],
    };
    this.data.users[id] = user;
    this.data.emailIndex[email.toLowerCase()] = id;
    this.persist();
    return user;
  }

  findByStripeCustomerId(customerId: string): StoredUser | undefined {
    for (const user of Object.values(this.data.users)) {
      if (user.stripeCustomerId === customerId) return user;
    }
    return undefined;
  }

  update(id: string, updates: Partial<StoredUser>) {
    const user = this.data.users[id];
    if (!user) return;
    this.data.users[id] = { ...user, ...updates };
    this.persist();
  }

  delete(id: string) {
    const user = this.data.users[id];
    if (!user) return;
    delete this.data.users[id];
    delete this.data.emailIndex[user.email.toLowerCase()];
    this.persist();
  }

  addReceipt(userId: string, txHash: string): void {
    const user = this.data.users[userId];
    if (!user) return;
    const hash = txHash.replace(/^0x/i, "").toUpperCase();
    const existing = user.receiptTxHashes || [];
    const next = existing.filter((h) => h !== hash);
    next.push(hash);
    this.data.users[userId] = { ...user, receiptTxHashes: next.slice(-100) };
    this.persist();
  }

  /** Find user who owns a specific API key (plaintext secret or stored hash). */
  findByApiKey(apiKey: string): StoredUser | undefined {
    const hashed = apiKeyLookupId(apiKey);
    for (const user of Object.values(this.data.users)) {
      if (user.apiKeyIds.includes(apiKey) || user.apiKeyIds.includes(hashed)) return user;
    }
    return undefined;
  }
}

export const userStore = new UserStore();
