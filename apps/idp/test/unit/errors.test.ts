import { AppError, errorBody, handleApiError } from "@flare-idp/api";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

describe("errorBody", () => {
  it("builds the envelope shape", () => {
    expect(errorBody("not_found", "Not found")).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });
});

describe("handleApiError", () => {
  function appWithError(err: unknown) {
    const app = new Hono();
    app.get("/boom", () => {
      throw err;
    });
    app.onError(handleApiError);
    return app;
  }

  it("maps AppError to its own envelope and status", async () => {
    const app = appWithError(
      new AppError(403, "forbidden", "Admin role required"),
    );
    const res = await app.request("/boom");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: "Admin role required" },
    });
  });

  it("maps a bare 401 HTTPException to unauthorized", async () => {
    const app = appWithError(new HTTPException(401, { message: "nope" }));
    const res = await app.request("/boom");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "nope" },
    });
  });

  it("maps a bare 404 HTTPException to not_found", async () => {
    const app = appWithError(new HTTPException(404, { message: "gone" }));
    const res = await app.request("/boom");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "gone" },
    });
  });

  it("maps any other HTTPException to invalid_request", async () => {
    const app = appWithError(new HTTPException(418, { message: "teapot" }));
    const res = await app.request("/boom");
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({
      error: { code: "invalid_request", message: "teapot" },
    });
  });

  it("never leaks the real error message for unknown errors", async () => {
    const app = appWithError(new Error("db password is hunter2"));
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "internal", message: "Internal error" },
    });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });
});
