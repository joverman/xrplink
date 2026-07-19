import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { v4 as uuid } from "uuid";
import { Tier } from "./types.js";

const DATA_DIR = "data";
const USERS_PATH = `${DATA_DIR}/users.json`;

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  apiKeyIds: string[];
  stripeCustomerId: string;
  tier: Tier;
  createdAt: string;
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
      for (const [id, u] of Object.entries(users)) {
        emailIndex[(u as StoredUser).email.toLowerCase()] = id;
      }
      return { users, emailIndex };
    } catch {
      return empty;
    }
  }

  private persist() {
    writeFileSync(USERS_PATH, JSON.stringify(this.data.users, null, 2));
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
      tier: "free",
      createdAt: new Date().toISOString(),
    };
    this.data.users[id] = user;
    this.data.emailIndex[email.toLowerCase()] = id;
    this.persist();
    return user;
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
}

export const userStore = new UserStore();
