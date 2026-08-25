import { renderEmail } from "./render.js";
import type { EmailJob, EmailSender } from "./types.js";

export function queueEmailSender(queue: Queue<EmailJob>): EmailSender {
  return {
    send: async (job: EmailJob) => {
      await queue.send(job);
    },
  };
}

export function cloudflareEmailSender(
  email: SendEmail,
  from: string,
  appName: string,
): EmailSender {
  return {
    send: async (job: EmailJob) => {
      const rendered = renderEmail(job, appName);
      await email.send({
        from,
        to: job.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    },
  };
}

export function captureEmailSender(): EmailSender & {
  readonly jobs: EmailJob[];
} {
  const jobs: EmailJob[] = [];
  return {
    get jobs(): EmailJob[] {
      return jobs;
    },
    send: async (job: EmailJob) => {
      jobs.push(job);
    },
  };
}
