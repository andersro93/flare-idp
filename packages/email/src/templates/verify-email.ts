import type { RenderedEmail } from "../types.js";
import { escapeHtml } from "./escape.js";

export function renderVerifyEmail(
  appName: string,
  recipientName: string,
  url: string,
): RenderedEmail {
  const safeRecipientName = escapeHtml(recipientName);
  const safeUrl = escapeHtml(url);

  return {
    subject: `Verify your email for ${appName}`,
    text: [
      `Hi ${recipientName},`,
      "",
      `Please verify your email address to complete your ${appName} account setup.`,
      `Confirm your email here: ${url}`,
      "",
      "If you did not request this, you can safely ignore this email.",
    ].join("\n"),
    html: `
      <p>Hi ${safeRecipientName},</p>
      <p>Please verify your email address to complete your ${appName} account setup.</p>
      <p><a href="${safeUrl}">Verify your email</a></p>
      <p>If you did not request this, you can safely ignore this email.</p>
    `,
  };
}
