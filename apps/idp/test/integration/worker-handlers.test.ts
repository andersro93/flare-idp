import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker";

describe("worker handlers", () => {
  it("scheduled handler runs to completion", async () => {
    const controller = createScheduledController({
      scheduledTime: new Date(),
      cron: "0 3 * * *",
    });
    const ctx = createExecutionContext();
    await worker.scheduled?.(controller, env, ctx);
    await waitOnExecutionContext(ctx);
  });

  it("queue handler delivers a valid job and acks a garbage body", async () => {
    const batch = createMessageBatch("flare-idp-email", [
      {
        id: "m1",
        timestamp: new Date(),
        body: {
          kind: "verify-email",
          to: "user@example.com",
          recipientName: "User",
          url: "https://example.com/verify?token=abc",
        },
        attempts: 1,
      },
      { id: "m2", timestamp: new Date(), body: { kind: "spike" }, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    // worker.ts declares queue as `(batch, env) => handleQueue(batch, env)`; `satisfies
    // ExportedHandler<Env>` keeps that narrower 2-arg inferred type, so only 2 args here.
    await worker.queue?.(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["m1", "m2"]);
    expect(result.retryMessages).toEqual([]);
  });
});
