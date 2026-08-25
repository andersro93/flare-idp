import {
  ERROR_CODES,
  emailSchema,
  errorBodySchema,
  nameSchema,
  passwordSchema,
  profilePatchSchema,
  ROLES,
  sessionUserSchema,
  setupCompleteSchema,
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

    it("accepts empty password if length check passes (not empty)", () => {
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

    it("rejects patches with only optional fields missing values", () => {
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

  describe("ROLES", () => {
    it("exports the expected roles", () => {
      expect(ROLES).toEqual(["admin", "user"]);
    });
  });
});
