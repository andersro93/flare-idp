import { describe, expect, it } from "vitest";
import {
  createSpikeAuth,
  migrateSpikeDb,
  signUpSpikeUser,
} from "./helpers/auth-fixture";

/**
 * S3: the passkey plugin (SimpleWebAuthn) loads and runs on workerd. A real
 * attestation needs an authenticator, so we prove: options generate (challenge
 * is persisted), a bogus attestation is rejected with a clean APIError (not a
 * crash) at its exact real status/code, and authentication options generate.
 *
 * Real behaviour observed on workerd (see docs/decisions.md / task-8-report.md):
 * - `generatePasskeyRegistrationOptions` response: `{ challenge, rp: { name, id },
 *   user: { id, name, displayName }, pubKeyCredParams, timeout, attestation,
 *   excludeCredentials, authenticatorSelection, extensions, hints }`.
 * - Challenge cookie name: `better-auth.better-auth-passkey` (HttpOnly, Max-Age=300).
 * - A bogus attestation fails cleanly with `APIError` — `status: "INTERNAL_SERVER_ERROR"`
 *   (statusCode 500), `body: { message: "Failed to verify registration",
 *   code: "FAILED_TO_VERIFY_REGISTRATION" }` — SimpleWebAuthn's verification
 *   rejects it and Better-Auth wraps that as a clean APIError, not a crash.
 * - `generatePasskeyAuthenticationOptions` works without a session (discoverable
 *   credential flow); response is `{ rpId, challenge, timeout, userVerification }`
 *   and it sets the same `better-auth.better-auth-passkey` challenge cookie. It's
 *   a `GET` endpoint (`method: "GET"` in its `StrictEndpoint` type) — its body
 *   type is `undefined`, so `{ body: {} }` (the brief's guess) fails `tsc` even
 *   though it happens to be accepted at runtime; omit `body` entirely.
 */
describe("S3 passkey plugin on workerd", () => {
  it("generates registration options and rejects a bogus attestation cleanly", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const { jar } = await signUpSpikeUser(auth);

    const reg = await auth.api.generatePasskeyRegistrationOptions({
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(reg.headers);
    expect(reg.response.challenge).toBeTypeOf("string");
    expect(reg.response.rp.id).toBe("localhost");
    expect(reg.headers.getSetCookie().some((c) => c.includes("passkey"))).toBe(
      true,
    );

    // Observed real behaviour on workerd: malformed client-supplied
    // attestation surfaces as a 500 (INTERNAL_SERVER_ERROR), not a 4xx —
    // SimpleWebAuthn's parse/verify failure is caught by the passkey
    // plugin's catch-all and re-thrown as this exact APIError, even though
    // the failure is entirely caused by client input. The Phase 5 facade
    // should map this to a 400 for the SPA.
    await expect(
      auth.api.verifyPasskeyRegistration({
        body: {
          response: {
            id: "bogus",
            rawId: "Ym9ndXM",
            type: "public-key",
            clientExtensionResults: {},
            response: { clientDataJSON: "e30", attestationObject: "AAAA" },
          },
        },
        headers: jar.headers(),
      }),
    ).rejects.toMatchObject({
      status: "INTERNAL_SERVER_ERROR",
      body: { code: "FAILED_TO_VERIFY_REGISTRATION" },
      message: "Failed to verify registration",
    });

    expect(await auth.api.listPasskeys({ headers: jar.headers() })).toEqual([]);
  });

  it("generates authentication options without a session (discoverable credential flow)", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const res = await auth.api.generatePasskeyAuthenticationOptions({
      headers: new Headers({ origin: "http://localhost:8787" }),
      returnHeaders: true,
    });
    expect(res.response.challenge).toBeTypeOf("string");
    expect(res.headers.getSetCookie().some((c) => c.includes("passkey"))).toBe(
      true,
    );
  });
});
