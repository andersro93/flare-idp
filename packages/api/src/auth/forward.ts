import { APIError } from "better-auth";
import type { Context } from "hono";
import { AppError } from "../http/errors";

/** Run a Better-Auth server call and forward its Set-Cookie headers onto our response. */
export async function callAuth<T>(
  c: Context,
  fn: () => Promise<{ headers: Headers; response: T }>,
): Promise<T> {
  try {
    const { headers, response } = await fn();
    for (const cookie of headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }
    return response;
  } catch (error) {
    throw mapAuthError(error);
  }
}

/** Map Better-Auth APIError statuses to our envelope codes; rethrow anything else. */
export function mapAuthError(error: unknown): unknown {
  if (!(error instanceof APIError)) return error;
  const message =
    error.body?.message ?? error.message ?? "Authentication error";
  switch (error.status) {
    case "UNAUTHORIZED":
      return new AppError(401, "invalid_credentials", message);
    case "FORBIDDEN":
      return new AppError(403, "forbidden", message);
    case "NOT_FOUND":
      return new AppError(404, "not_found", message);
    case "TOO_MANY_REQUESTS":
      return new AppError(429, "rate_limited", message);
    case "BAD_REQUEST":
      return new AppError(400, "invalid_request", message);
    case "INTERNAL_SERVER_ERROR":
      // Never forward Better-Auth's internal message to the caller.
      return new AppError(500, "internal", "Internal error");
    default:
      // Unrecognized statuses are treated as server errors, not 400s — an
      // unmapped Better-Auth status is a bug in this mapping, not a bad
      // request, and its message must not leak either.
      return new AppError(500, "internal", "Internal error");
  }
}
