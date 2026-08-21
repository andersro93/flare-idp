import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationsDir = new URL(
  "../../../../packages/db/migrations/",
  import.meta.url,
);

describe("D1 migration files", () => {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  it("exist and follow NNNN_name.sql", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it("are numbered sequentially from 0001 without gaps or duplicates", () => {
    const numbers = files.map((name) => Number(name.slice(0, 4)));
    expect(numbers[0]).toBe(1);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i], `after ${numbers[i - 1]}`).toBe(
        (numbers[i - 1] ?? 0) + 1,
      );
    }
  });

  it("never use PRAGMA foreign_keys or explicit transactions (D1 rejects them)", () => {
    for (const name of files) {
      const sql = readFileSync(new URL(name, migrationsDir), "utf8");
      expect(sql, name).not.toMatch(/PRAGMA\s+foreign_keys/i);
      expect(sql, name).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);
    }
  });

  it("do not end with a SQL comment line (applyD1Migrations bug, workers-sdk#7739)", () => {
    for (const name of files) {
      const lines = readFileSync(new URL(name, migrationsDir), "utf8")
        .trimEnd()
        .split("\n");
      expect(lines.at(-1)?.trim().startsWith("--"), name).toBe(false);
    }
  });
});
