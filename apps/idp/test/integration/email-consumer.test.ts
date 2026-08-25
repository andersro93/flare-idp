import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { handleQueue } from "@flare-idp/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./helpers/db";

describe("email queue consumer", () => {
  beforeEach(resetDatabase);

  it("acks a valid EmailJob (delivered via the EMAIL binding) and acks a garbage body without retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const batch = createMessageBatch("flare-idp-email", [
        {
          id: "valid-1",
          timestamp: new Date(),
          body: {
            kind: "reset-password",
            to: "user@example.com",
            recipientName: "User",
            url: "https://example.com/reset?token=abc",
          },
          attempts: 1,
        },
        {
          id: "garbage-1",
          timestamp: new Date(),
          body: { kind: "not-a-real-kind", nonsense: true },
          attempts: 1,
        },
      ]);
      const ctx = createExecutionContext();

      // `createMessageBatch` has no way to know one of these bodies is
      // deliberately garbage; `handleQueue` zod-validates each body itself.
      await handleQueue(batch as Parameters<typeof handleQueue>[0], env);
      const result = await getQueueResult(batch, ctx);

      expect(result.explicitAcks.sort()).toEqual(["garbage-1", "valid-1"]);
      expect(result.retryMessages).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("email_job_invalid"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("retries a failed send, logging only an error-type descriptor — never the sender error's message", async () => {
    // A real sender failure could echo any part of the request back in its
    // message — including the job's token-bearing reset/verification URL —
    // so the consumer must log a non-identifying descriptor only.
    class SenderRejectedError extends Error {}
    const failingEnv = {
      ...env,
      EMAIL: {
        send: async () => {
          throw new SenderRejectedError(
            "rejected message to user@example.com containing https://example.com/reset?token=sentinel-plaintext-token",
          );
        },
        // Only `send` is exercised; the binding's remaining surface is not.
      } as unknown as typeof env.EMAIL,
    };

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const batch = createMessageBatch("flare-idp-email", [
        {
          id: "failing-1",
          timestamp: new Date(),
          body: {
            kind: "reset-password",
            to: "user@example.com",
            recipientName: "User",
            url: "https://example.com/reset?token=sentinel-plaintext-token",
          },
          attempts: 1,
        },
      ]);
      const ctx = createExecutionContext();

      await handleQueue(batch as Parameters<typeof handleQueue>[0], failingEnv);
      const result = await getQueueResult(batch, ctx);

      expect(result.retryMessages).toHaveLength(1);
      expect(result.explicitAcks).toEqual([]);

      const logged = error.mock.calls
        .map((call) => call.map(String).join(" "))
        .join("\n");
      expect(logged).toContain('"event":"email_job_send_failed"');
      expect(logged).toContain('"errorType":"SenderRejectedError"');
      expect(logged).toContain('"kind":"reset-password"');
      expect(logged).not.toContain("sentinel-plaintext-token");
      expect(logged).not.toContain("user@example.com");
    } finally {
      error.mockRestore();
    }
  });
});
