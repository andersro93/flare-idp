import type { ErrorCode } from "@flare-idp/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorTypeOf, logEvent } from "./log";

export type ErrorBody = { error: { code: ErrorCode; message: string } };

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

export class AppError extends HTTPException {
  readonly code: ErrorCode;
  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
    super(status, { message });
    this.code = code;
  }
}

function nearestCodeFor(status: number): ErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  return "invalid_request";
}

/**
 * Global onError: `AppError` -> its own envelope + status; a bare
 * `HTTPException` -> mapped to the nearest error code; anything else is an
 * unhandled programming error, logged and answered as a generic 500 so
 * internals never leak — in EITHER direction: the response body never
 * carries the error's message, and neither does the log line (see
 * `errorTypeOf` for why arbitrary messages are radioactive).
 */
export function handleApiError(err: unknown, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(errorBody(err.code, err.message), err.status);
  }

  if (err instanceof HTTPException) {
    return c.json(
      errorBody(nearestCodeFor(err.status), err.message),
      err.status,
    );
  }

  logEvent("error", "unhandled_error", {
    errorType: errorTypeOf(err),
    path: c.req.path,
    method: c.req.method,
  });
  return c.json(errorBody("internal", "Internal error"), 500);
}
