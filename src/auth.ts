import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userStore, StoredUser } from "./user-store.js";
import { store } from "./store.js";
import { sendWelcomeEmail, sendPasswordResetEmail } from "./email.js";

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-in-prod";
const SALT_ROUNDS = 10;

export interface AuthResult {
  ok: boolean;
  user?: StoredUser;
  token?: string;
  apiKey?: string;
  error?: string;
}

export function signup(email: string, password: string): AuthResult {
  if (!email || !password) return { ok: false, error: "Email and password required" };
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters" };

  const existing = userStore.findByEmail(email);
  if (existing) return { ok: false, error: "Email already registered" };

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const user = userStore.create(email, passwordHash);

  // Auto-create a free-tier API key
  const apiKey = store.createApiKey(`User: ${email}`, "free");
  userStore.update(user.id, { apiKeyIds: [apiKey.key] });

  const token = jwt.sign({ userId: user.id, email: user.email }, SESSION_SECRET, { expiresIn: "7d" });

  // Fire and forget welcome email
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

  const token = jwt.sign({ userId: user.id, email: user.email }, SESSION_SECRET, { expiresIn: "7d" });
  return { ok: true, user, token, apiKey: user.apiKeyIds[0] || "" };
}

export function verifyToken(token: string): { userId: string; email: string } | null {
  try {
    const payload = jwt.verify(token, SESSION_SECRET) as { userId: string; email: string };
    return payload;
  } catch {
    return null;
  }
}

export function getUserFromToken(token: string): StoredUser | null {
  const payload = verifyToken(token);
  if (!payload) return null;
  return userStore.findById(payload.userId) || null;
}

export function generateResetToken(email: string): string | null {
  const user = userStore.findByEmail(email);
  if (!user) return null;
  const token = jwt.sign({ userId: user.id, purpose: "reset" }, SESSION_SECRET, { expiresIn: "1h" });
  sendPasswordResetEmail(email, token).catch(() => {});
  return token;
}

export function resetPassword(token: string, newPassword: string): AuthResult {
  const payload = verifyToken(token);
  if (!payload || !payload.userId) return { ok: false, error: "Invalid or expired reset token" };

  const user = userStore.findById(payload.userId);
  if (!user) return { ok: false, error: "User not found" };

  const passwordHash = bcrypt.hashSync(newPassword, SALT_ROUNDS);
  userStore.update(user.id, { passwordHash });

  return { ok: true, user, token: "", apiKey: user.apiKeyIds[0] || "" };
}
