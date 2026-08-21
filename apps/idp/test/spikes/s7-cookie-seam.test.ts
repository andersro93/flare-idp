import { env } from "cloudflare:test";
import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";
import {
  createSpikeAuth,
  migrateSpikeDb,
  SPIKE_USER,
  signUpSpikeUser,
} from "./helpers/auth-fixture";
import { CookieJar } from "./helpers/cookies";

/**
 * S7: every SPA-facing flow goes through our facade, which calls auth.api.*
 * and forwards Set-Cookie. These tests prove the cookie chain survives:
 * sign-in → (2FA interim cookie) → verify TOTP → session cookie → sign-out.
 */
describe("S7 cookie seam", () => {
  it("sign-in via auth.api returns Set-Cookie that authenticates getSession", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    await signUpSpikeUser(auth);

    const jar = new CookieJar();
    const { headers, response } = await auth.api.signInEmail({
      body: { email: SPIKE_USER.email, password: SPIKE_USER.password },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(headers);
    expect(response.user.email).toBe(SPIKE_USER.email);
    expect(jar.names().some((n) => n.includes("session_token"))).toBe(true);

    const session = await auth.api.getSession({ headers: jar.headers() });
    expect(session?.session.userId).toBe(response.user.id);

    const out = await auth.api.signOut({
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(out.headers);
    expect(await auth.api.getSession({ headers: jar.headers() })).toBeNull();
  });

  it("2FA: enable → verify setup → sign-in yields twoFactorRedirect + interim cookie → verifyTOTP yields session", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const { jar } = await signUpSpikeUser(auth);

    const enable = await auth.api.enableTwoFactor({
      body: { password: SPIKE_USER.password },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(enable.headers);
    const totpURI =
      "totpURI" in enable.response ? enable.response.totpURI : undefined;
    expect(totpURI, "1.7 discriminates by method; expect TOTP").toBeTypeOf(
      "string",
    );
    const totp = OTPAuth.URI.parse(totpURI as string) as OTPAuth.TOTP;

    const setup = await auth.api.verifyTOTP({
      body: { code: totp.generate() },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(setup.headers);

    // Fresh browser: sign in again → 2FA required.
    const jar2 = new CookieJar();
    const signIn = await auth.api.signInEmail({
      body: { email: SPIKE_USER.email, password: SPIKE_USER.password },
      headers: jar2.headers(),
      returnHeaders: true,
    });
    jar2.absorb(signIn.headers);
    expect(
      (signIn.response as { twoFactorRedirect?: boolean }).twoFactorRedirect,
    ).toBe(true);
    expect(jar2.names().some((n) => n.includes("two_factor"))).toBe(true);

    const verify = await auth.api.verifyTOTP({
      body: { code: totp.generate() },
      headers: jar2.headers(),
      returnHeaders: true,
    });
    jar2.absorb(verify.headers);
    const session = await auth.api.getSession({ headers: jar2.headers() });
    expect(session?.user.email).toBe(SPIKE_USER.email);

    const twoFactorRows = await env.DB.prepare(
      `SELECT verified FROM "twoFactor"`,
    ).all<{ verified: number }>();
    expect(twoFactorRows.results[0]?.verified).toBeTruthy();
  });
});
