export type EmailJob =
  | {
      kind: "reset-password";
      to: string;
      recipientName: string;
      url: string;
    }
  | {
      kind: "verify-email";
      to: string;
      recipientName: string;
      url: string;
    }
  | {
      kind: "invite-set-password";
      to: string;
      recipientName: string;
      url: string;
      invitedBy: string;
    };

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

export interface EmailSender {
  send(job: EmailJob): Promise<void>;
}
