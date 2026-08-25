import type { RenderedEmail } from "../types.js";
import { escapeHtml } from "./escape.js";

export function renderResetPassword(
  appName: string,
  recipientName: string,
  url: string,
): RenderedEmail {
  const safeRecipientName = escapeHtml(recipientName);
  const safeUrl = escapeHtml(url);

  return {
    subject: `Reset your ${appName} password`,
    text: [
      `Hi ${recipientName},`,
      "",
      `We received a request to reset your ${appName} password.`,
      `Use this link to choose a new password: ${url}`,
      "",
      "If you did not request this, you can safely ignore this email.",
    ].join("\n"),
    html: `
      <p>Hi ${safeRecipientName},</p>
      <p>We received a request to reset your ${appName} password.</p>
      <p><a href="${safeUrl}">Reset your password</a></p>
      <p>If you did not request this, you can safely ignore this email.</p>
    `,
  };
}
