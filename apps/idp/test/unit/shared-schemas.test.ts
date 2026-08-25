import {
  ERROR_CODES,
  emailSchema,
  emailVerifySchema,
  errorBodySchema,
  nameSchema,
  passwordChangeSchema,
  passwordForgotSchema,
  passwordResetSchema,
  passwordSchema,
  profilePatchSchema,
  ROLES,
  sessionInfoSchema,
  sessionUserSchema,
  setupCompleteSchema,
  signInSchema,
} from "@flare-idp/shared";
import { describe, expect, it } from "vitest";

describe("shared schemas", () => {
  describe("ERROR_CODES", () => {
    it("exports the expected error codes", () => {
      expect(ERROR_CODES).toEqual([
        "invalid_request",
        "invalid_credentials",
        "unauthorized",
        "forbidden",
        "not_found",
        "rate_limited",
        "invalid_token",
        "email_not_verified",
        "setup_already_complete",
        "invalid_setup_secret",
        "misconfigured",
        "internal",
      ]);
    });
  });

  describe("errorBodySchema", () => {
    it("parses a valid error envelope", () => {
      const result = errorBodySchema.parse({
        error: { code: "unauthorized", message: "Unauthorized access" },
      });
      expect(result).toEqual({
        error: { code: "unauthorized", message: "Unauthorized access" },
      });
    });

    it("rejects an unknown error code", () => {
      expect(() =>
        errorBodySchema.parse({
          error: { code: "unknown_code", message: "Test" },
        }),
      ).toThrow();
    });

    it("rejects missing code field", () => {
      expect(() =>
        errorBodySchema.parse({
          error: { message: "Test" },
        }),
      ).toThrow();
    });

    it("rejects missing message field", () => {
      expect(() =>
        errorBodySchema.parse({
          error: { code: "unauthorized" },
        }),
      ).toThrow();
    });
  });

  describe("emailSchema", () => {
    it("trims and lowercases email addresses", () => {
      const result = emailSchema.parse("  Foo@EXAMPLE.com  ");
      expect(result).toBe("foo@example.com");
    });

    it("accepts valid email addresses", () => {
      expect(emailSchema.parse("test@example.com")).toBe("test@example.com");
      expect(emailSchema.parse("user+tag@domain.co.uk")).toBe(
        "user+tag@domain.co.uk",
      );
    });

    it("rejects invalid email addresses", () => {
      expect(() => emailSchema.parse("not-an-email")).toThrow();
      expect(() => emailSchema.parse("@example.com")).toThrow();
      expect(() => emailSchema.parse("test@")).toThrow();
    });

    it("rejects empty string", () => {
      expect(() => emailSchema.parse("")).toThrow();
    });
  });

  describe("passwordSchema", () => {
    it("accepts passwords of 12 or more characters", () => {
      expect(passwordSchema.parse("12charslong!!")).toBe("12charslong!!");
      expect(passwordSchema.parse("a".repeat(128))).toBe("a".repeat(128));
    });

    it("rejects passwords shorter than 12 characters", () => {
      expect(() => passwordSchema.parse("short")).toThrow();
      expect(() => passwordSchema.parse("11charelong")).toThrow();
    });

    it("rejects passwords longer than 128 characters", () => {
      expect(() => passwordSchema.parse("a".repeat(129))).toThrow();
    });

    it("rejects an empty password", () => {
      expect(() => passwordSchema.parse("")).toThrow();
    });
  });

  describe("nameSchema", () => {
    it("accepts valid names", () => {
      expect(nameSchema.parse("John Doe")).toBe("John Doe");
      expect(nameSchema.parse("Alice")).toBe("Alice");
    });

    it("trims whitespace", () => {
      expect(nameSchema.parse("  John Doe  ")).toBe("John Doe");
    });

    it("rejects empty names after trimming", () => {
      expect(() => nameSchema.parse("")).toThrow();
      expect(() => nameSchema.parse("   ")).toThrow();
    });

    it("rejects names longer than 100 characters", () => {
      expect(() => nameSchema.parse("a".repeat(101))).toThrow();
    });
  });

  describe("setupCompleteSchema", () => {
    it("parses a valid setup complete request", () => {
      const result = setupCompleteSchema.parse({
        secret: "test-setup-secret",
        email: "admin@example.com",
        password: "correct-horse-battery-staple",
        name: "Admin User",
      });
      expect(result).toEqual({
        secret: "test-setup-secret",
        email: "admin@example.com",
        password: "correct-horse-battery-staple",
        name: "Admin User",
      });
    });

    it("processes email through emailSchema (trimming and lowercasing)", () => {
      const result = setupCompleteSchema.parse({
        secret: "test-secret",
        email: "  ADMIN@EXAMPLE.COM  ",
        password: "correct-horse-battery-staple",
        name: "Admin",
      });
      expect(result.email).toBe("admin@example.com");
    });

    it("rejects missing required fields", () => {
      expect(() =>
        setupCompleteSchema.parse({
          email: "admin@example.com",
          password: "correct-horse-battery-staple",
          name: "Admin",
        }),
      ).toThrow();

      expect(() =>
        setupCompleteSchema.parse({
          secret: "test-secret",
          password: "correct-horse-battery-staple",
          name: "Admin",
        }),
      ).toThrow();
    });

    it("rejects invalid password", () => {
      expect(() =>
        setupCompleteSchema.parse({
          secret: "test-secret",
          email: "admin@example.com",
          password: "short",
          name: "Admin",
        }),
      ).toThrow();
    });
  });

  describe("profilePatchSchema", () => {
    it("accepts a patch with name only", () => {
      const result = profilePatchSchema.parse({ name: "New Name" });
      expect(result).toEqual({ name: "New Name" });
    });

    it("accepts a patch with image only", () => {
      const result = profilePatchSchema.parse({
        image: "https://example.com/image.png",
      });
      expect(result).toEqual({ image: "https://example.com/image.png" });
    });

    it("accepts a patch with both name and image", () => {
      const result = profilePatchSchema.parse({
        name: "New Name",
        image: "https://example.com/image.png",
      });
      expect(result).toEqual({
        name: "New Name",
        image: "https://example.com/image.png",
      });
    });

    it("accepts image as null", () => {
      const result = profilePatchSchema.parse({
        name: "New Name",
        image: null,
      });
      expect(result).toEqual({ name: "New Name", image: null });
    });

    it("rejects an empty patch object", () => {
      expect(() => profilePatchSchema.parse({})).toThrow();
    });

    it("processes name through nameSchema (trimming)", () => {
      const result = profilePatchSchema.parse({ name: "  John Doe  " });
      expect(result.name).toBe("John Doe");
    });
  });

  describe("sessionUserSchema", () => {
    it("parses a valid session user with all fields", () => {
      const result = sessionUserSchema.parse({
        id: "user-123",
        email: "user@example.com",
        name: "Test User",
        image: "https://example.com/avatar.png",
        emailVerified: true,
        role: "user",
        createdAt: new Date("2024-01-01"),
      });
      expect(result).toMatchObject({
        id: "user-123",
        email: "user@example.com",
        name: "Test User",
        image: "https://example.com/avatar.png",
        emailVerified: true,
        role: "user",
      });
      expect(result.createdAt).toEqual(new Date("2024-01-01"));
    });

    it("parses admin role", () => {
      const result = sessionUserSchema.parse({
        id: "user-456",
        email: "admin@example.com",
        name: "Admin User",
        emailVerified: true,
        role: "admin",
        createdAt: new Date("2024-01-01"),
      });
      expect(result.role).toBe("admin");
    });

    it("coerces string dates to Date objects", () => {
      const result = sessionUserSchema.parse({
        id: "user-123",
        email: "user@example.com",
        name: "Test User",
        emailVerified: false,
        role: "user",
        createdAt: "2024-01-01T00:00:00Z",
      });
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("defaults unknown role to 'user' via .catch()", () => {
      const result = sessionUserSchema.parse({
        id: "user-789",
        email: "user@example.com",
        name: "Unknown Role User",
        emailVerified: false,
        role: "superadmin",
        createdAt: new Date("2024-01-01"),
      });
      expect(result.role).toBe("user");
    });

    it("handles image as optional", () => {
      const result = sessionUserSchema.parse({
        id: "user-123",
        email: "user@example.com",
        name: "Test User",
        emailVerified: false,
        role: "user",
        createdAt: new Date("2024-01-01"),
      });
      expect(result.image).toBeUndefined();
    });

    it("handles image as null", () => {
      const result = sessionUserSchema.parse({
        id: "user-123",
        email: "user@example.com",
        name: "Test User",
        image: null,
        emailVerified: false,
        role: "user",
        createdAt: new Date("2024-01-01"),
      });
      expect(result.image).toBeNull();
    });

    it("rejects missing required fields", () => {
      expect(() =>
        sessionUserSchema.parse({
          id: "user-123",
          email: "user@example.com",
          // missing name and emailVerified
          role: "user",
          createdAt: new Date("2024-01-01"),
        }),
      ).toThrow();
    });
  });

  describe("signInSchema", () => {
    it("parses a valid sign-in request", () => {
      const result = signInSchema.parse({
        email: "user@example.com",
        password: "correct-horse-battery-staple",
      });
      expect(result).toEqual({
        email: "user@example.com",
        password: "correct-horse-battery-staple",
      });
    });

    it("transforms email through emailSchema (trimming and lowercasing)", () => {
      const result = signInSchema.parse({
        email: "  USER@EXAMPLE.COM  ",
        password: "correct-horse-battery-staple",
      });
      expect(result.email).toBe("user@example.com");
    });

    it("rejects an empty password", () => {
      expect(() =>
        signInSchema.parse({
          email: "user@example.com",
          password: "",
        }),
      ).toThrow();
    });

    it("rejects an invalid email", () => {
      expect(() =>
        signInSchema.parse({
          email: "not-an-email",
          password: "correct-horse-battery-staple",
        }),
      ).toThrow();
    });
  });

  describe("passwordForgotSchema", () => {
    it("parses a valid password forgot request", () => {
      const result = passwordForgotSchema.parse({
        email: "user@example.com",
      });
      expect(result).toEqual({ email: "user@example.com" });
    });

    it("transforms email through emailSchema (trimming and lowercasing)", () => {
      const result = passwordForgotSchema.parse({
        email: "  USER@EXAMPLE.COM  ",
      });
      expect(result.email).toBe("user@example.com");
    });

    it("rejects an invalid email", () => {
      expect(() =>
        passwordForgotSchema.parse({
          email: "not-an-email",
        }),
      ).toThrow();
    });
  });

  describe("passwordResetSchema", () => {
    it("parses a valid password reset request", () => {
      const result = passwordResetSchema.parse({
        token: "reset-token-123",
        password: "correct-horse-battery-staple",
      });
      expect(result).toEqual({
        token: "reset-token-123",
        password: "correct-horse-battery-staple",
      });
    });

    it("rejects an empty token", () => {
      expect(() =>
        passwordResetSchema.parse({
          token: "",
          password: "correct-horse-battery-staple",
        }),
      ).toThrow();
    });

    it("rejects a password shorter than 12 characters", () => {
      expect(() =>
        passwordResetSchema.parse({
          token: "reset-token-123",
          password: "short",
        }),
      ).toThrow();
    });
  });

  describe("passwordChangeSchema", () => {
    it("parses a valid password change request with all fields", () => {
      const result = passwordChangeSchema.parse({
        currentPassword: "old-password-string",
        newPassword: "correct-horse-battery-staple",
        revokeOtherSessions: true,
      });
      expect(result).toEqual({
        currentPassword: "old-password-string",
        newPassword: "correct-horse-battery-staple",
        revokeOtherSessions: true,
      });
    });

    it("defaults revokeOtherSessions to true when omitted", () => {
      const result = passwordChangeSchema.parse({
        currentPassword: "old-password-string",
        newPassword: "correct-horse-battery-staple",
      });
      expect(result.revokeOtherSessions).toBe(true);
    });

    it("preserves an explicit false for revokeOtherSessions", () => {
      const result = passwordChangeSchema.parse({
        currentPassword: "old-password-string",
        newPassword: "correct-horse-battery-staple",
        revokeOtherSessions: false,
      });
      expect(result.revokeOtherSessions).toBe(false);
    });

    it("rejects a newPassword shorter than 12 characters", () => {
      expect(() =>
        passwordChangeSchema.parse({
          currentPassword: "old-password-string",
          newPassword: "short",
        }),
      ).toThrow();
    });

    it("rejects an empty currentPassword", () => {
      expect(() =>
        passwordChangeSchema.parse({
          currentPassword: "",
          newPassword: "correct-horse-battery-staple",
        }),
      ).toThrow();
    });
  });

  describe("emailVerifySchema", () => {
    it("parses a valid email verify request", () => {
      const result = emailVerifySchema.parse({
        token: "verify-token-123",
      });
      expect(result).toEqual({ token: "verify-token-123" });
    });

    it("rejects an empty token", () => {
      expect(() =>
        emailVerifySchema.parse({
          token: "",
        }),
      ).toThrow();
    });
  });

  describe("sessionInfoSchema", () => {
    it("parses a valid session info with all fields", () => {
      const result = sessionInfoSchema.parse({
        id: "session-123",
        createdAt: new Date("2024-01-01"),
        expiresAt: new Date("2024-01-15"),
        userAgent: "Mozilla/5.0",
        ipAddress: "192.168.1.1",
        current: true,
      });
      expect(result).toMatchObject({
        id: "session-123",
        userAgent: "Mozilla/5.0",
        ipAddress: "192.168.1.1",
        current: true,
      });
      expect(result.createdAt).toEqual(new Date("2024-01-01"));
      expect(result.expiresAt).toEqual(new Date("2024-01-15"));
    });

    it("coerces string dates to Date objects", () => {
      const result = sessionInfoSchema.parse({
        id: "session-123",
        createdAt: "2024-01-01T00:00:00Z",
        expiresAt: "2024-01-15T00:00:00Z",
        current: false,
      });
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("accepts userAgent as null", () => {
      const result = sessionInfoSchema.parse({
        id: "session-123",
        createdAt: new Date("2024-01-01"),
        expiresAt: new Date("2024-01-15"),
        userAgent: null,
        current: true,
      });
      expect(result.userAgent).toBeNull();
    });

    it("accepts ipAddress as null", () => {
      const result = sessionInfoSchema.parse({
        id: "session-123",
        createdAt: new Date("2024-01-01"),
        expiresAt: new Date("2024-01-15"),
        ipAddress: null,
        current: true,
      });
      expect(result.ipAddress).toBeNull();
    });

    it("handles userAgent as optional (absent)", () => {
      const result = sessionInfoSchema.parse({
        id: "session-123",
        createdAt: new Date("2024-01-01"),
        expiresAt: new Date("2024-01-15"),
        current: false,
      });
      expect(result.userAgent).toBeUndefined();
    });

    it("handles ipAddress as optional (absent)", () => {
      const result = sessionInfoSchema.parse({
        id: "session-123",
        createdAt: new Date("2024-01-01"),
        expiresAt: new Date("2024-01-15"),
        current: true,
      });
      expect(result.ipAddress).toBeUndefined();
    });

    it("rejects missing required current field", () => {
      expect(() =>
        sessionInfoSchema.parse({
          id: "session-123",
          createdAt: new Date("2024-01-01"),
          expiresAt: new Date("2024-01-15"),
        }),
      ).toThrow();
    });

    it("rejects missing required id field", () => {
      expect(() =>
        sessionInfoSchema.parse({
          createdAt: new Date("2024-01-01"),
          expiresAt: new Date("2024-01-15"),
          current: true,
        }),
      ).toThrow();
    });
  });

  describe("ROLES", () => {
    it("exports the expected roles", () => {
      expect(ROLES).toEqual(["admin", "user"]);
    });
  });
});
