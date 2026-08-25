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
});
