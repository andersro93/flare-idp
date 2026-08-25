import { AppError, callAuth, mapAuthError } from "@flare-idp/api";
import { APIError } from "better-auth";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

describe("mapAuthError", () => {
  it("maps known Better-Auth statuses to our envelope codes", () => {
    expect(
      mapAuthError(new APIError("UNAUTHORIZED", { message: "bad" })),
    ).toEqual(
      expect.objectContaining({ code: "invalid_credentials", status: 401 }),
    );
    expect(mapAuthError(new APIError("FORBIDDEN", { message: "no" }))).toEqual(
      expect.objectContaining({ code: "forbidden", status: 403 }),
    );
    expect(
      mapAuthError(new APIError("NOT_FOUND", { message: "gone" })),
    ).toEqual(expect.objectContaining({ code: "not_found", status: 404 }));
    expect(
      mapAuthError(new APIError("TOO_MANY_REQUESTS", { message: "slow down" })),
    ).toEqual(expect.objectContaining({ code: "rate_limited", status: 429 }));
    expect(
      mapAuthError(new APIError("BAD_REQUEST", { message: "invalid" })),
    ).toEqual(
      expect.objectContaining({ code: "invalid_request", status: 400 }),
    );
  });

  it("maps UNPROCESSABLE_ENTITY and CONFLICT to a 400 invalid_request, forwarding the upstream message", () => {
    expect(
      mapAuthError(
        new APIError("UNPROCESSABLE_ENTITY", {
          message: "User already exists",
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        code: "invalid_request",
        status: 400,
        message: "User already exists",
      }),
    );
    expect(mapAuthError(new APIError("CONFLICT", { message: "dup" }))).toEqual(
      expect.objectContaining({
        code: "invalid_request",
        status: 400,
        message: "dup",
      }),
    );
  });

  it("maps INTERNAL_SERVER_ERROR to a generic 500 without leaking the upstream message", () => {
    expect(
      mapAuthError(
        new APIError("INTERNAL_SERVER_ERROR", { message: "db exploded" }),
      ),
    ).toEqual(
      expect.objectContaining({
        code: "internal",
        status: 500,
        message: "Internal error",
      }),
    );
  });

  it("defaults unmapped statuses to a generic 500 without leaking the upstream message", () => {
    expect(
      mapAuthError(new APIError("SERVICE_UNAVAILABLE", { message: "down" })),
    ).toEqual(
      expect.objectContaining({
        code: "internal",
        status: 500,
        message: "Internal error",
      }),
    );
  });

  it("returns non-APIError errors unchanged", () => {
    const err = new Error("plain");
    expect(mapAuthError(err)).toBe(err);
  });

  it("mapped errors are AppError instances", () => {
    const mapped = mapAuthError(new APIError("FORBIDDEN", { message: "no" }));
    expect(mapped).toBeInstanceOf(AppError);
  });
});

describe("callAuth", () => {
  it("forwards Set-Cookie headers and returns the response payload", async () => {
    const app = new Hono();
    app.get("/x", async (c) => {
      const result = await callAuth(c, async () => {
        const headers = new Headers();
        headers.append("Set-Cookie", "a=1; Path=/");
        headers.append("Set-Cookie", "b=2; Path=/");
        return { headers, response: { ok: true } };
      });
      return c.json(result);
    });

    const res = await app.request("/x");
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("maps a thrown APIError to our envelope via handleApiError", async () => {
    const { handleApiError } = await import("@flare-idp/api");
    const app = new Hono();
    app.get("/x", async (c) => {
      return callAuth(c, async () => {
        throw new APIError("UNAUTHORIZED", { message: "bad creds" });
      });
    });
    app.onError(handleApiError);

    const res = await app.request("/x");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "invalid_credentials", message: "bad creds" },
    });
  });
});
