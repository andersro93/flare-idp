import type { RenderedEmail } from "../types.js";
import { escapeHtml } from "./escape.js";

export function renderInviteSetPassword(
  appName: string,
  recipientName: string,
  url: string,
  invitedBy: string,
): RenderedEmail {
  const safeRecipientName = escapeHtml(recipientName);
  const safeInvitedBy = escapeHtml(invitedBy);
  const safeUrl = escapeHtml(url);
  const safeAppName = escapeHtml(appName);

  return {
    subject: `You have been invited to ${appName}`,
    text: [
      `Hi ${recipientName},`,
      "",
      `${invitedBy} invited you to join ${appName}.`,
      `Set your password here: ${url}`,
      "",
      "This link expires; ask for a new invitation if it stops working.",
    ].join("\n"),
    html: `
      <p>Hi ${safeRecipientName},</p>
      <p>${safeInvitedBy} invited you to join ${safeAppName}.</p>
      <p><a href="${safeUrl}">Set your password</a></p>
      <p>This link expires; ask for a new invitation if it stops working.</p>
    `,
  };
}
