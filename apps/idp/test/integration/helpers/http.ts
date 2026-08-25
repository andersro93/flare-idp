import { SELF } from "cloudflare:test";
import { CookieJar } from "./cookies";

export const TEST_ORIGIN = "http://localhost:8787";

export async function api(
  path: string,
  init: RequestInit = {},
  jar?: CookieJar,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", TEST_ORIGIN);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (jar) headers.set("cookie", jar.header());
  const res = await SELF.fetch(`${TEST_ORIGIN}${path}`, { ...init, headers });
  jar?.absorb(res.headers);
  return res;
}

export const SETUP_ADMIN = {
  email: "admin@example.com",
  password: "correct-horse-battery-staple",
  name: "Admin",
};

/** POST /api/setup/complete with SETUP_SECRET; returns a jar holding the admin session. */
export async function completeSetup(jar = new CookieJar()): Promise<CookieJar> {
  const res = await api(
    "/api/setup/complete",
    {
      method: "POST",
      body: JSON.stringify({ secret: "test-setup-secret", ...SETUP_ADMIN }),
    },
    jar,
  );
  if (res.status !== 201) {
    throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  }
  return jar;
}

export async function signIn(
  email: string,
  password: string,
  jar = new CookieJar(),
): Promise<{ jar: CookieJar; res: Response }> {
  const res = await api(
    "/api/session/sign-in/password",
    { method: "POST", body: JSON.stringify({ email, password }) },
    jar,
  );
  return { jar, res };
}
