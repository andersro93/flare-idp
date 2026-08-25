import { cloudflareEmailSender, type EmailJob } from "@flare-idp/email";
import { z } from "zod";
import { errorTypeOf, logEvent } from "../http/log";

/**
 * Small inline validator — deliberately not `@flare-idp/shared`'s
 * `emailSchema` (which trims/lowercases for form input); a queue message's
 * `to` is either a well-formed address already or the job is poison, full
 * stop.
 */
const emailJobSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reset-password"),
    to: z.email(),
    recipientName: z.string(),
    url: z.string(),
  }),
  z.object({
    kind: z.literal("verify-email"),
    to: z.email(),
    recipientName: z.string(),
    url: z.string(),
  }),
  z.object({
    kind: z.literal("invite-set-password"),
    to: z.email(),
    recipientName: z.string(),
    url: z.string(),
    invitedBy: z.string(),
  }),
]);

/**
 * Delivers queued email jobs via the `EMAIL` (send_email) binding. A body
 * that fails validation is acked (never retried) — retrying it would loop
 * forever, since nothing about its shape ever changes. A body that
 * validates but fails to send is retried (transient send failures should
 * clear on redelivery).
 */
export async function handleQueue(
  batch: MessageBatch<EmailJob>,
  env: Env,
): Promise<void> {
  const sender = cloudflareEmailSender(
    env.EMAIL,
    env.OUTBOUND_EMAIL_FROM,
    env.APP_NAME,
  );

  for (const message of batch.messages) {
    const parsed = emailJobSchema.safeParse(message.body);
    if (!parsed.success) {
      logEvent("warn", "email_job_invalid", {
        id: message.id,
        issues: parsed.error.issues.map((issue) => issue.message),
      });
      message.ack();
      continue;
    }

    try {
      await sender.send(parsed.data);
      message.ack();
    } catch (error) {
      // Never the error's message: a sender error echoing any part of the
      // request would leak the job's token-bearing verification/reset URL
      // into production logs (see `errorTypeOf`). Kind and attempt count
      // are safe; `to`/`url` are deliberately absent.
      logEvent("error", "email_job_send_failed", {
        id: message.id,
        kind: parsed.data.kind,
        attempts: message.attempts,
        errorType: errorTypeOf(error),
      });
      message.retry();
    }
  }
}
