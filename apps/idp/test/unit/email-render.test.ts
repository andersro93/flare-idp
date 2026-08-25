import {
  captureEmailSender,
  cloudflareEmailSender,
  type EmailJob,
  queueEmailSender,
  renderEmail,
} from "@flare-idp/email";
import { describe, expect, it, vi } from "vitest";

describe("email rendering", () => {
  const appName = "Test App";

  describe("renderEmail", () => {
    describe("reset-password", () => {
      it("subject contains app name", () => {
        const job: EmailJob = {
          kind: "reset-password",
          to: "user@example.com",
          recipientName: "John",
          url: "https://example.com/reset?token=abc",
        };
        const result = renderEmail(job, appName);
        expect(result.subject).toContain(appName);
        expect(result.subject).toContain("Reset");
      });

      it("text body contains the raw url", () => {
        const job: EmailJob = {
          kind: "reset-password",
          to: "user@example.com",
          recipientName: "John",
          url: "https://example.com/reset?token=abc",
        };
        const result = renderEmail(job, appName);
        expect(result.text).toContain("https://example.com/reset?token=abc");
      });

      it("html body contains the escaped link", () => {
        const job: EmailJob = {
          kind: "reset-password",
          to: "user@example.com",
          recipientName: "John",
          url: "https://example.com/reset?token=abc",
        };
        const result = renderEmail(job, appName);
        expect(result.html).toContain("https://example.com/reset?token=abc");
        expect(result.html).toContain("href=");
      });

      it("escapes recipientName in html", () => {
        const job: EmailJob = {
          kind: "reset-password",
          to: "user@example.com",
          recipientName: "<script>alert(1)</script>",
          url: "https://example.com/reset?token=abc",
        };
        const result = renderEmail(job, appName);
        expect(result.html).toContain("&lt;script&gt;");
        expect(result.html).not.toContain("<script>alert");
      });

      it("includes ignore line in text and html", () => {
        const job: EmailJob = {
          kind: "reset-password",
          to: "user@example.com",
          recipientName: "John",
          url: "https://example.com/reset?token=abc",
        };
        const result = renderEmail(job, appName);
        expect(result.text).toContain("did not request");
        expect(result.html).toContain("did not request");
      });
    });

    describe("verify-email", () => {
      it("subject contains app name", () => {
        const job: EmailJob = {
          kind: "verify-email",
          to: "user@example.com",
          recipientName: "Jane",
          url: "https://example.com/verify?token=xyz",
        };
        const result = renderEmail(job, appName);
        expect(result.subject).toContain(appName);
        expect(result.subject).toContain("Verify");
      });

      it("text body contains the raw url", () => {
        const job: EmailJob = {
          kind: "verify-email",
          to: "user@example.com",
          recipientName: "Jane",
          url: "https://example.com/verify?token=xyz",
        };
        const result = renderEmail(job, appName);
        expect(result.text).toContain("https://example.com/verify?token=xyz");
      });

      it("html body contains the escaped link", () => {
        const job: EmailJob = {
          kind: "verify-email",
          to: "user@example.com",
          recipientName: "Jane",
          url: "https://example.com/verify?token=xyz",
        };
        const result = renderEmail(job, appName);
        expect(result.html).toContain("https://example.com/verify?token=xyz");
        expect(result.html).toContain("href=");
      });

      it("escapes recipientName in html", () => {
        const job: EmailJob = {
          kind: "verify-email",
          to: "user@example.com",
          recipientName: "<img src=x onerror=alert(1)>",
          url: "https://example.com/verify?token=xyz",
        };
        const result = renderEmail(job, appName);
        expect(result.html).toContain("&lt;img");
        expect(result.html).not.toContain("<img src=x");
      });

      it("includes ignore line in text and html", () => {
        const job: EmailJob = {
          kind: "verify-email",
          to: "user@example.com",
          recipientName: "Jane",
          url: "https://example.com/verify?token=xyz",
        };
        const result = renderEmail(job, appName);
        expect(result.text).toContain("did not request");
        expect(result.html).toContain("did not request");
      });
    });

    describe("invite-set-password", () => {
      it("subject contains app name", () => {
        const job: EmailJob = {
          kind: "invite-set-password",
          to: "newuser@example.com",
          recipientName: "Alice",
          url: "https://example.com/invite?token=def",
          invitedBy: "Bob Smith",
        };
        const result = renderEmail(job, appName);
        expect(result.subject).toContain(appName);
        expect(result.subject).toContain("invited");
      });

      it("text body contains the raw url", () => {
        const job: EmailJob = {
          kind: "invite-set-password",
          to: "newuser@example.com",
          recipientName: "Alice",
          url: "https://example.com/invite?token=def",
          invitedBy: "Bob Smith",
        };
        const result = renderEmail(job, appName);
        expect(result.text).toContain("https://example.com/invite?token=def");
      });

      it("html body contains the escaped link", () => {
        const job: EmailJob = {
          kind: "invite-set-password",
          to: "newuser@example.com",
          recipientName: "Alice",
          url: "https://example.com/invite?token=def",
          invitedBy: "Bob Smith",
        };
        const result = renderEmail(job, appName);
        expect(result.html).toContain("https://example.com/invite?token=def");
        expect(result.html).toContain("href=");
      });

      it("escapes recipientName in html", () => {
        const job: EmailJob = {
          kind: "invite-set-password",
          to: "newuser@example.com",
          recipientName: "<script>alert(1)</script>",
          url: "https://example.com/invite?token=def",
          invitedBy: "Bob Smith",
        };
        const result = renderEmail(job, appName);
        expect(result.html).toContain("&lt;script&gt;");
        expect(result.html).not.toContain("<script>alert");
      });

      it("escapes invitedBy in html", () => {
        const job: EmailJob = {
          kind: "invite-set-password",
          to: "newuser@example.com",
          recipientName: "Alice",
          url: "https://example.com/invite?token=def",
          invitedBy: "<img src=x onerror=alert(1)>",
        };
        const result = renderEmail(job, appName);
        expect(result.html).toContain("&lt;img");
        expect(result.html).not.toContain("<img src=x");
      });

      it("does NOT include ignore line (has expiration line instead)", () => {
        const job: EmailJob = {
          kind: "invite-set-password",
          to: "newuser@example.com",
          recipientName: "Alice",
          url: "https://example.com/invite?token=def",
          invitedBy: "Bob Smith",
        };
        const result = renderEmail(job, appName);
        expect(result.text).not.toContain("did not request");
        expect(result.html).not.toContain("did not request");
        expect(result.text).toContain("expires");
        expect(result.html).toContain("expires");
      });
    });
  });

  describe("captureEmailSender", () => {
    it("collects jobs sent through it", async () => {
      const sender = captureEmailSender();
      const job1: EmailJob = {
        kind: "reset-password",
        to: "user1@example.com",
        recipientName: "User 1",
        url: "https://example.com/reset?token=1",
      };
      const job2: EmailJob = {
        kind: "verify-email",
        to: "user2@example.com",
        recipientName: "User 2",
        url: "https://example.com/verify?token=2",
      };

      await sender.send(job1);
      await sender.send(job2);

      expect(sender.jobs).toHaveLength(2);
      expect(sender.jobs[0]).toEqual(job1);
      expect(sender.jobs[1]).toEqual(job2);
    });

    it("jobs property is accessible", () => {
      const sender = captureEmailSender();
      expect(sender.jobs).toEqual([]);
      expect(Array.isArray(sender.jobs)).toBe(true);
    });
  });

  describe("queueEmailSender", () => {
    it("sends jobs through the queue", async () => {
      const mockQueue = {
        send: vi.fn().mockResolvedValue(undefined),
      } as unknown as Queue<EmailJob>;
      const sender = queueEmailSender(mockQueue);
      const job: EmailJob = {
        kind: "reset-password",
        to: "user@example.com",
        recipientName: "User",
        url: "https://example.com/reset?token=1",
      };

      await sender.send(job);

      expect(mockQueue.send).toHaveBeenCalledWith(job);
    });
  });

  describe("cloudflareEmailSender", () => {
    it("renders and sends emails via Cloudflare", async () => {
      const mockEmail = {
        send: vi.fn().mockResolvedValue(undefined),
      } as unknown as SendEmail;
      const sender = cloudflareEmailSender(
        mockEmail,
        "noreply@example.com",
        appName,
      );
      const job: EmailJob = {
        kind: "reset-password",
        to: "user@example.com",
        recipientName: "User",
        url: "https://example.com/reset?token=1",
      };

      await sender.send(job);

      expect(mockEmail.send).toHaveBeenCalled();
      const mockSendFn = mockEmail.send as unknown as {
        mock: { calls: unknown[][] };
      };
      const call = mockSendFn.mock.calls?.[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call).toBeDefined();
      expect(call?.from).toBe("noreply@example.com");
      expect(call?.to).toBe("user@example.com");
      expect(call?.subject).toContain(appName);
      expect(call?.text).toBeDefined();
      expect(call?.html).toBeDefined();
    });
  });
});
