import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { atomicWriteJson, createMutex } from "./file-lock.js";
import { v4 as uuid } from "uuid";
import { Tier } from "./types.js";
import { apiKeyLookupId, hashApiKey, isPlaintextApiKey, timingSafeEqualString } from "./api-keys.js";

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
  /**
   * Incremented to revoke every outstanding session JWT for this user.
   * Missing on pre-migration records; treated as 1.
   */
  sessionVersion?: number;
  /** SHA-256 hex of the current password-reset secret. Never store the plaintext. */
  resetTokenHash?: string;
  /** Unix epoch ms when resetTokenHash expires. */
  resetTokenExpiresAt?: number;
}

interface PersistedData {
  users: Record<string, StoredUser>;
  emailIndex: Record<string, string>;
}

class UserStore {
  private data: PersistedData;
  private writeLock = createMutex();

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
      let needsPersist = false;
      for (const [id, u] of Object.entries(users)) {
        const user = u as StoredUser;
        emailIndex[user.email.toLowerCase()] = id;
        if (Array.isArray(user.apiKeyIds)) {
          const nextIds = user.apiKeyIds.map((k) => (isPlaintextApiKey(k) ? hashApiKey(k) : k));
          if (nextIds.some((k, i) => k !== user.apiKeyIds[i])) {
            user.apiKeyIds = nextIds;
            needsPersist = true;
          }
        }
        if (typeof user.sessionVersion !== "number" || !Number.isFinite(user.sessionVersion) || user.sessionVersion < 1) {
          user.sessionVersion = 1;
          needsPersist = true;
        }
      }
      const loaded = { users, emailIndex };
      if (needsPersist) {
        this.data = loaded;
        this.persist();
      }
      return loaded;
    } catch {
      return empty;
    }
  }

  private persist() {
    atomicWriteJson(USERS_PATH, this.data.users);
  }

  /** Serialize a mutate+persist so concurrent auth/billing updates cannot clobber users.json. */
  async withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.writeLock(fn);
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
      sessionVersion: 1,
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
    const next = { ...user, ...updates };
    if (updates.resetTokenHash === undefined && "resetTokenHash" in updates) {
      delete next.resetTokenHash;
    }
    if (updates.resetTokenExpiresAt === undefined && "resetTokenExpiresAt" in updates) {
      delete next.resetTokenExpiresAt;
    }
    this.data.users[id] = next;
    this.persist();
  }

  currentSessionVersion(user: StoredUser): number {
    return typeof user.sessionVersion === "number" && user.sessionVersion >= 1 ? user.sessionVersion : 1;
  }

  bumpSessionVersion(id: string): StoredUser | undefined {
    const user = this.data.users[id];
    if (!user) return undefined;
    this.update(id, { sessionVersion: this.currentSessionVersion(user) + 1 });
    return this.data.users[id];
  }

  findByResetTokenHash(hash: string): StoredUser | undefined {
    if (!hash) return undefined;
    for (const user of Object.values(this.data.users)) {
      if (user.resetTokenHash && timingSafeEqualString(user.resetTokenHash, hash)) {
        return user;
      }
    }
    return undefined;
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
