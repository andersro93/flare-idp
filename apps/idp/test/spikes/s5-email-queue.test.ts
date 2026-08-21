import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("S5 Email Service binding in miniflare", () => {
  it("exposes EMAIL.send and accepts a plain-object message", async () => {
    expect(env.EMAIL).toBeDefined();
    const result = await env.EMAIL.send({
      from: "noreply@example.com",
      to: "user@example.com",
      subject: "flare-idp spike",
      text: "hello",
      html: "<p>hello</p>",
    });
    // Real behaviour on @cloudflare/vitest-plugin 1.0.0 + workerd (2026-08): the local
    // send_email simulator always resolves a MessageBuilder-style id, never undefined.
    expect(result).toEqual({ messageId: expect.stringMatching(/^<.+@.+>$/) });
  });
});

describe("S5 Queue producer binding", () => {
  it("accepts a message on EMAIL_QUEUE", async () => {
    // Real behaviour on @cloudflare/vitest-plugin 1.0.0 + workerd (2026-08): Queue#send()
    // resolves a backlog-metrics envelope, not undefined as the brief assumed.
    const result = await env.EMAIL_QUEUE.send({
      kind: "spike",
      to: "user@example.com",
    });
    expect(result).toEqual({
      metadata: {
        metrics: {
          backlogBytes: expect.any(Number),
          backlogCount: expect.any(Number),
          oldestMessageTimestamp: undefined,
        },
      },
    });
  });
});
