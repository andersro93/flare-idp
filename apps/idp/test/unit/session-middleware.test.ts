import type { AppEnv, SessionFetcher } from "@flare-idp/api";
import { loadSession, requireAdmin, requireAuth } from "@flare-idp/api";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

function fetcherFor(
  session: Awaited<ReturnType<SessionFetcher["api"]["getSession"]>>,
): SessionFetcher {
  return { api: { getSession: async () => session } };
}

function newApp() {
  return new Hono<AppEnv>();
}

describe("loadSession", () => {
  it("sets user/session to null when there is no session", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() => fetcherFor(null)),
    );
    app.get("/", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    );

    const res = await app.request("/");
    expect(await res.json()).toEqual({ user: null, session: null });
  });

  it("populates user with a default role of user", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() =>
        fetcherFor({
          user: {
            id: "u1",
            email: "a@example.com",
            name: "Ada",
            emailVerified: true,
          },
          session: { id: "s1" },
        }),
      ),
    );
    app.get("/", (c) =>
      c.json({ user: c.get("user"), session: c.get("session") }),
    );

    const res = await app.request("/");
    const body = (await res.json()) as {
      user: Record<string, unknown>;
      session: Record<string, unknown>;
    };
    expect(body.user).toMatchObject({
      id: "u1",
      email: "a@example.com",
      name: "Ada",
      emailVerified: true,
      role: "user",
    });
    expect(body.session).toEqual({ id: "s1" });
  });

  it("preserves an explicit admin role", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() =>
        fetcherFor({
          user: {
            id: "u1",
            email: "a@example.com",
            name: "Ada",
            emailVerified: true,
            role: "admin",
          },
          session: { id: "s1" },
        }),
      ),
    );
    app.get("/", (c) => c.json({ role: c.get("user")?.role }));

    const res = await app.request("/");
    expect(await res.json()).toEqual({ role: "admin" });
  });

  it("never throws: a getSession rejection clears the vars and continues", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() => ({
        api: {
          getSession: async () => {
            throw new Error("kv unavailable");
          },
        },
      })),
    );
    app.get("/", (c) => c.json({ user: c.get("user") }));

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });
});

describe("requireAuth", () => {
  it("401s with our envelope when there is no user", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() => fetcherFor(null)),
    );
    app.use("*", requireAuth);
    app.get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("passes through when a user is set", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() =>
        fetcherFor({
          user: {
            id: "u1",
            email: "a@example.com",
            name: "Ada",
            emailVerified: true,
          },
          session: { id: "s1" },
        }),
      ),
    );
    app.use("*", requireAuth);
    app.get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(200);
  });
});

describe("requireAdmin", () => {
  it("403s with our envelope for a non-admin user", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() =>
        fetcherFor({
          user: {
            id: "u1",
            email: "a@example.com",
            name: "Ada",
            emailVerified: true,
          },
          session: { id: "s1" },
        }),
      ),
    );
    app.use("*", requireAdmin);
    app.get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: expect.any(String) },
    });
  });

  it("401s (not 403) when there is no user at all", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() => fetcherFor(null)),
    );
    app.use("*", requireAdmin);
    app.get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(401);
  });

  it("passes through for an admin user", async () => {
    const app = newApp();
    app.use(
      "*",
      loadSession(() =>
        fetcherFor({
          user: {
            id: "u1",
            email: "a@example.com",
            name: "Ada",
            emailVerified: true,
            role: "admin",
          },
          session: { id: "s1" },
        }),
      ),
    );
    app.use("*", requireAdmin);
    app.get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(200);
  });
});
