import type { SecondaryStorage } from "@better-auth/core/db";

const KV_MIN_TTL_SECONDS = 60;

function ttlOptions(ttl?: number): KVNamespacePutOptions | undefined {
  if (ttl === undefined) return undefined;
  return { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttl)) };
}

/**
 * Better-Auth secondary storage on Workers KV. Used as a session read cache
 * only: `rateLimit.storage` is never "secondary-storage" and
 * `verification.storeInDatabase` is true, so the non-atomic `increment` and
 * `getAndDelete` below are never on a security-critical path.
 */
export function kvSecondaryStorage(kv: KVNamespace): SecondaryStorage {
  return {
    get: (key) => kv.get(key),
    set: (key, value, ttl) => kv.put(key, value, ttlOptions(ttl)),
    delete: (key) => kv.delete(key),
    getAndDelete: async (key) => {
      const value = await kv.get(key);
      if (value !== null) await kv.delete(key);
      return value;
    },
    increment: async (key, ttl) => {
      const next = Number((await kv.get(key)) ?? 0) + 1;
      await kv.put(key, String(next), ttlOptions(ttl));
      return next;
    },
  };
}
