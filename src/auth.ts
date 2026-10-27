import { createHash, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userStore, StoredUser } from "./user-store.js";
import { store } from "./store.js";
import { sendWelcomeEmail, sendPasswordResetEmail } from "./email.js";
import { SESSION_TTL } from "./session.js";
import { hashApiKey } from "./api-keys.js";

function sessionSecret(): string {
  return process.env.SESSION_SECRET || "dev-secret-change-in-prod";
}

const SALT_ROUNDS = 10;

export const SESSION_TOKEN_PURPOSE = "session";
export const RESET_TOKEN_PURPOSE = "password_reset";
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface AuthResult {
  ok: boolean;
  user?: StoredUser;
  token?: string;
  apiKey?: string;
  error?: string;
}

export interface SessionPayload {
  userId: string;
  email: string;
  purpose?: string;
  sv?: number;
}

export async function signup(email: string, password: string): Promise<AuthResult> {
  if (!email || !password) return { ok: false, error: "Email and password required" };
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters" };

  const existing = userStore.findByEmail(email);
  if (existing) return { ok: false, error: "Email already registered" };

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const user = userStore.create(email, passwordHash);

  const apiKey = await store.createApiKey(`User: ${email}`, "free");
  userStore.update(user.id, { apiKeyIds: [hashApiKey(apiKey.key)] });

  const token = issueSessionToken(user);

  sendWelcomeEmail(email, apiKey.key).catch(() => {});

  return { ok: true, user, token, apiKey: apiKey.key };
}

export function login(email: string, password: string): AuthResult {
  if (!email || !password) return { ok: false, error: "Email and password required" };

  const user = userStore.findByEmail(email);
  if (!user) return { ok: false, error: "Invalid email or password" };

  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return { ok: false, error: "Invalid email or password" };
  }

  const token = issueSessionToken(user);
  // Hashed keys cannot be recovered on login. Clients use the session cookie
  // and rotate from the dashboard if they no longer have the secret.
  return { ok: true, user, token };
}

export function issueSessionToken(user: StoredUser): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      purpose: SESSION_TOKEN_PURPOSE,
      sv: userStore.currentSessionVersion(user),
    },
    sessionSecret(),
    { expiresIn: SESSION_TTL }
  );
}

export function verifyToken(token: string): SessionPayload | null {
  try {
    const payload = jwt.verify(token, sessionSecret()) as SessionPayload;
    if (!payload?.userId) return null;
    // Reset/verify tokens must never authenticate a session.
    if (payload.purpose && payload.purpose !== SESSION_TOKEN_PURPOSE) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getUserFromToken(token: string): StoredUser | null {
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = userStore.findById(payload.userId);
  if (!user) return null;
  const current = userStore.currentSessionVersion(user);
  if (payload.sv === undefined) {
    // Pre-sv cookies stay valid until the first revocation bump (sessionVersion > 1).
    if (current !== 1) return null;
  } else if (payload.sv !== current) {
    return null;
  }
  return user;
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateResetToken(email: string): string | null {
  const user = userStore.findByEmail(email);
  if (!user) return null;
  const token = randomBytes(32).toString("base64url");
  userStore.update(user.id, {
    resetTokenHash: hashResetToken(token),
    resetTokenExpiresAt: Date.now() + RESET_TOKEN_TTL_MS,
  });
  sendPasswordResetEmail(email, token).catch(() => {});
  return token;
}

export function resetPassword(token: string, newPassword: string): AuthResult {
  if (!token || !newPassword) return { ok: false, error: "Invalid or expired reset token" };
  if (newPassword.length < 8) return { ok: false, error: "Password must be at least 8 characters" };

  const user = userStore.findByResetTokenHash(hashResetToken(token));
  if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt < Date.now()) {
    return { ok: false, error: "Invalid or expired reset token" };
  }

  const passwordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
  userStore.update(user.id, {
    passwordHash,
    sessionVersion: userStore.currentSessionVersion(user) + 1,
    resetTokenHash: undefined,
    resetTokenExpiresAt: undefined,
  });

  return { ok: true, user: userStore.findById(user.id), token: "" };
}

export function revokeUserSessions(userId: string): StoredUser | undefined {
  return userStore.bumpSessionVersion(userId);
}
