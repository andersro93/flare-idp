import { app, handleQueue, handleScheduled } from "@flare-idp/api";
import type { EmailJob } from "@flare-idp/email";

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(handleScheduled(controller, env));
  },
  // Cloudflare's `ExportedHandler` queue signature carries no compile-time
  // guarantee about message bodies (it defaults to `unknown`); `handleQueue`
  // zod-validates each body before use, so the cast just names the contract.
  queue: (batch, env) => handleQueue(batch as MessageBatch<EmailJob>, env),
} satisfies ExportedHandler<Env>;
