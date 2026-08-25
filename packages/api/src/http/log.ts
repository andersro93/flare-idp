import type { Context, MiddlewareHandler } from "hono";

export type LogLevel = "info" | "warn" | "error";

/**
 * Single-line JSON logs for Workers Logs / Logpush. Every line carries an
 * `event` name plus structured fields. Never log request/response bodies or
 * secrets (tokens, passwords, verification codes).
 */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ event, level, ...fields });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Request correlation fields: Cloudflare's ray id, method and path. */
export function requestFields(c: Context): Record<string, unknown> {
  return {
    ray: c.req.header("cf-ray") ?? null,
    method: c.req.method,
    path: c.req.path,
  };
}

/**
 * Logs API responses that failed (>= 400) with duration and correlation
 * fields. Successful requests are not logged to keep the volume low; error
 * rate and latency are available from Workers metrics. Never logs bodies.
 */
export const logFailedApiRequests: MiddlewareHandler = async (c, next) => {
  const startedAt = Date.now();
  await next();
  const status = c.res.status;
  if (status >= 400) {
    logEvent(status >= 500 ? "error" : "warn", "api_request_failed", {
      ...requestFields(c),
      status,
      durationMs: Date.now() - startedAt,
    });
  }
};
