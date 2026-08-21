import { app, handleQueue, handleScheduled } from "@flare-idp/api";

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(handleScheduled(controller, env));
  },
  queue: (batch, env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env>;
