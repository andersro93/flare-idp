import { renderInviteSetPassword } from "./templates/invite-set-password.js";
import { renderResetPassword } from "./templates/reset-password.js";
import { renderVerifyEmail } from "./templates/verify-email.js";
import type { EmailJob, RenderedEmail } from "./types.js";

export function renderEmail(job: EmailJob, appName: string): RenderedEmail {
  switch (job.kind) {
    case "reset-password":
      return renderResetPassword(appName, job.recipientName, job.url);
    case "verify-email":
      return renderVerifyEmail(appName, job.recipientName, job.url);
    case "invite-set-password":
      return renderInviteSetPassword(
        appName,
        job.recipientName,
        job.url,
        job.invitedBy,
      );
  }
}
