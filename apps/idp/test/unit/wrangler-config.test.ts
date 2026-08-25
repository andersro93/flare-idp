import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type WranglerConfig = {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  keep_vars?: boolean;
  assets?: {
    binding?: string;
    not_found_handling?: string;
    run_worker_first?: boolean | string[];
  };
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    migrations_dir?: string;
  }>;
  kv_namespaces?: Array<{ binding: string }>;
  queues?: {
    producers?: Array<{ binding: string; queue: string }>;
    consumers?: Array<{ queue: string }>;
  };
  send_email?: Array<{ name: string }>;
  observability?: { logs?: { invocation_logs?: boolean } };
  vars?: Record<string, unknown>;
};

function loadWranglerConfig(): WranglerConfig {
  const raw = readFileSync(
    new URL("../../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  // Strip // line comments (the file has no block comments or URLs in strings).
  const json = raw
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  return JSON.parse(json) as WranglerConfig;
}

describe("wrangler.jsonc deployment contract", () => {
  const config = loadWranglerConfig();

  it("targets the single flare-idp Worker with nodejs_compat", () => {
    expect(config.name).toBe("flare-idp");
    expect(config.main).toBe("src/worker.ts");
    expect(config.compatibility_flags).toContain("nodejs_compat");
  });

  it("routes every request through the Worker and keeps SPA fallback", () => {
    expect(config.assets?.binding).toBe("ASSETS");
    expect(config.assets?.run_worker_first).toBe(true);
    expect(config.assets?.not_found_handling).toBe("single-page-application");
  });

  it("declares D1 (with shared migrations dir), KV, email queue and send_email bindings", () => {
    expect(config.d1_databases?.[0]).toMatchObject({
      binding: "DB",
      database_name: "flare-idp",
      migrations_dir: "../../packages/db/migrations",
    });
    expect(config.kv_namespaces?.[0]?.binding).toBe("KV");
    expect(config.queues?.producers?.[0]).toMatchObject({
      binding: "EMAIL_QUEUE",
      queue: "flare-idp-email",
    });
    expect(config.queues?.consumers?.[0]?.queue).toBe("flare-idp-email");
    expect(config.send_email?.[0]?.name).toBe("EMAIL");
  });

  it("preserves dashboard vars and disables invocation logs (URLs carry tokens)", () => {
    expect(config.keep_vars).toBe(true);
    expect(config.observability?.logs?.invocation_logs).toBe(false);
  });

  it("declares a non-empty OUTBOUND_EMAIL_FROM sender address", () => {
    const from = config.vars?.OUTBOUND_EMAIL_FROM;
    expect(typeof from).toBe("string");
    expect((from as string).length).toBeGreaterThan(0);
  });
});
