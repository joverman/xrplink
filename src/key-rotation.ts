import { store } from "./store.js";
import { userStore, StoredUser } from "./user-store.js";
import { hashApiKey, toPublicApiKey } from "./api-keys.js";

export async function rotateUserApiKey(user: StoredUser): Promise<{
  plaintext: string;
  publicKey: Record<string, unknown>;
} | null> {
  const current = userStore.findById(user.id);
  if (!current) return null;
  const oldId = current.apiKeyIds[0];
  const oldRecord = oldId ? await store.getApiKey(oldId) : undefined;
  const name = oldRecord?.name || `User: ${current.email}`;
  const tier = current.tier;
  const usageCount = oldRecord?.usageCount || 0;

  const created = await store.createApiKey(name, tier);
  const newId = hashApiKey(created.key);
  if (usageCount > 0) await store.setApiKeyUsageCount(newId, usageCount);

  if (oldId) {
    await store.rekeyAttestationUsage(oldId, newId);
    await store.deleteApiKey(oldId);
  }

  const remaining = current.apiKeyIds.filter((id) => id !== oldId);
  userStore.update(current.id, {
    apiKeyIds: [newId, ...remaining],
    sessionVersion: userStore.currentSessionVersion(current) + 1,
  });

  const fresh = await store.getApiKey(newId);
  return {
    plaintext: created.key,
    publicKey: toPublicApiKey(fresh || { ...created, key: newId }),
  };
}
