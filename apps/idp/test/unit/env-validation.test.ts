import { validateEnv } from "@flare-idp/api";
import { describe, expect, it } from "vitest";

function fullEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): Env {
  return {
    APP_NAME: "flare-idp",
    APP_URL: "https://idp.example.com",
    ASSETS: {} as Fetcher,
    AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    EMAIL: {} as Env["EMAIL"],
    EMAIL_QUEUE: {} as Queue,
    ENVIRONMENT: "production",
    OUTBOUND_EMAIL_FROM: "noreply@idp.example.com",
    SETUP_SECRET: "setup-secret",
    ...overrides,
  } as Env;
}

describe("validateEnv", () => {
  it("accepts a complete production environment", () => {
    expect(validateEnv(fullEnv())).toEqual({ ok: true, problems: [] });
  });

  it("reports every missing required variable and binding", () => {
    const result = validateEnv(
      fullEnv({
        APP_NAME: undefined,
        APP_URL: undefined,
        AUTH_SECRET: undefined,
        OUTBOUND_EMAIL_FROM: undefined,
        DB: undefined,
        KV: undefined,
        EMAIL: undefined,
        EMAIL_QUEUE: undefined,
        ASSETS: undefined,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.key).sort()).toEqual(
      [
        "APP_NAME",
        "APP_URL",
        "AUTH_SECRET",
        "ASSETS",
        "DB",
        "EMAIL",
        "EMAIL_QUEUE",
        "KV",
        "OUTBOUND_EMAIL_FROM",
      ].sort(),
    );
  });

  it("does not require SETUP_SECRET", () => {
    const result = validateEnv(fullEnv({ SETUP_SECRET: undefined }));
    expect(result.ok).toBe(true);
  });

  it("rejects a short AUTH_SECRET", () => {
    const result = validateEnv(fullEnv({ AUTH_SECRET: "too-short" }));
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ key: "AUTH_SECRET" }),
    ]);
  });

  it("requires APP_URL to be an absolute https URL outside development/test", () => {
    expect(validateEnv(fullEnv({ APP_URL: "not a url" })).ok).toBe(false);
    expect(validateEnv(fullEnv({ APP_URL: "http://idp.example.com" })).ok).toBe(
      false,
    );
    expect(
      validateEnv(
        fullEnv({
          APP_URL: "http://localhost:8787",
          ENVIRONMENT: "development",
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateEnv(
        fullEnv({ APP_URL: "http://localhost:8787", ENVIRONMENT: "test" }),
      ).ok,
    ).toBe(true);
  });

  it("treats an empty string like a missing value", () => {
    expect(validateEnv(fullEnv({ OUTBOUND_EMAIL_FROM: "   " })).ok).toBe(false);
  });
});

describe("assertValidEnv", () => {
  it("throws EnvValidationError listing all problems when invalid", async () => {
    const { assertValidEnv, EnvValidationError } = await import(
      "@flare-idp/api"
    );
    expect(() => assertValidEnv(fullEnv({ AUTH_SECRET: undefined }))).toThrow(
      EnvValidationError,
    );
  });

  it("does not throw for a valid env", async () => {
    const { assertValidEnv } = await import("@flare-idp/api");
    expect(() => assertValidEnv(fullEnv())).not.toThrow();
  });
});
