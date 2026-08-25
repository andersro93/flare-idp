import type { Context, MiddlewareHandler } from "hono";
import { errorBody } from "../errors";

export type RateLimitRule = {
  /** Short label used in the storage key, e.g. "setup". */
  name: string;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Maximum requests per window per client. */
  max: number;
};

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Resolves the client address. Cloudflare sets cf-connecting-ip on every
 * request that reaches a Worker; it cannot be spoofed by the client.
 */
export function clientAddress(headers: Headers): string {
  return headers.get("cf-connecting-ip")?.trim() || "unknown";
}

/**
 * Atomic fixed-window counter in D1 (single upsert with RETURNING), keyed by
 * rule name + client. Shares the `rate_limit` table with the drizzle schema
 * (packages/db/src/schema/app.ts).
 */
export async function consumeRateLimit(
  db: D1Database,
  rule: RateLimitRule,
  client: string,
  now: number = Date.now(),
): Promise<RateLimitDecision> {
  const key = `app:${rule.name}:${client}`;
  const windowMs = rule.windowSeconds * 1000;
  const windowStartCutoff = now - windowMs;

  const row = await db
    .prepare(
      `INSERT INTO rate_limit (id, key, count, last_request)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE
           WHEN rate_limit.last_request <= ?4 THEN 1
           ELSE rate_limit.count + 1
         END,
         last_request = CASE
           WHEN rate_limit.last_request <= ?4 THEN ?3
           ELSE rate_limit.last_request
         END
       RETURNING count, last_request`,
    )
    .bind(crypto.randomUUID(), key, now, windowStartCutoff)
    .first<{ count: number; last_request: number }>();

  const count = Number(row?.count ?? 1);
  const lastRequest = Number(row?.last_request ?? now);

  if (count > rule.max) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((lastRequest + windowMs - now) / 1000),
    );
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true, remaining: rule.max - count };
}

/**
 * Hono middleware that enforces `rule` per client. Default key is the
 * request's `cf-connecting-ip` (fallback "unknown"); pass `keyFn` for a
 * composite key (e.g. sign-in's ip+email).
 */
export function rateLimit(
  rule: RateLimitRule,
  keyFn?: (c: Context<{ Bindings: Env }>) => string,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const clientKey = keyFn ? keyFn(c) : clientAddress(c.req.raw.headers);
    const decision = await consumeRateLimit(c.env.DB, rule, clientKey);

    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json(
        errorBody("rate_limited", "Too many requests. Please try again later."),
        429,
      );
    }

    await next();
  };
}

export const RATE_LIMITS = {
  setup: { name: "setup", windowSeconds: 900, max: 5 },
  signIn: { name: "sign-in", windowSeconds: 60, max: 5 },
  passwordForgot: { name: "pw-forgot", windowSeconds: 300, max: 3 },
  passwordReset: { name: "pw-reset", windowSeconds: 300, max: 5 },
  emailVerify: { name: "email-verify", windowSeconds: 300, max: 10 },
} as const;
