import { ROLES, sessionUserSchema } from "@flare-idp/shared";
import { z } from "@hono/zod-openapi";

/**
 * `sessionUserSchema`'s `role` field is `z.enum(ROLES).catch("user")` —
 * defensive runtime coercion (see `@flare-idp/shared/src/schemas.ts`,
 * exercised by `shared-schemas.test.ts`). `zod-to-openapi` has no
 * introspection for `ZodCatch` and throws `UnknownZodTypeError` while
 * generating `doc31` unless the schema carries an explicit `type`
 * override.
 *
 * `@hono/zod-openapi`'s `.openapi()` is added by mutating `zod`'s
 * `ZodType.prototype` (`extendZodWithOpenApi`) the first time
 * `@hono/zod-openapi` is imported anywhere in the module graph — but
 * (observed empirically against zod 4.4.3) that mutation is NOT visible
 * on schema instances built before the patch ran, even though they share
 * the same underlying `zod` module: zod v4's internal chainable-method
 * wiring resolves per-instance at construction time, not via a live
 * prototype-chain lookup. `@flare-idp/shared` builds `sessionUserSchema`
 * with plain `zod` (by design — no `@hono/zod-openapi` dependency there),
 * so calling `.openapi()` on `sessionUserSchema.shape.role` is a coin
 * flip depending on which of `@flare-idp/shared` / `@hono/zod-openapi`
 * some route file happens to import first (it consistently loses when a
 * route imports `@flare-idp/shared` before `@hono/zod-openapi`, which is
 * the common case here).
 *
 * The fix: build a FRESH `role` validator here using `z` re-exported from
 * `@hono/zod-openapi` (guaranteed patched — this file's own
 * `@hono/zod-openapi` import always finishes evaluating, patch included,
 * before this module's body runs) instead of reusing the pre-built
 * instance from `@flare-idp/shared`. `.extend()` swaps that in for
 * `role`; parsing behavior (the `.catch("user")` fallback) is unchanged
 * — only OpenAPI generation is affected. Use this in response schemas;
 * use `sessionUserSchema` itself for parsing/type-inference.
 */
export const sessionUserResponseSchema = sessionUserSchema.extend({
  role: z
    .enum(ROLES)
    .catch("user")
    .openapi({ type: "string", enum: [...ROLES] }),
});
