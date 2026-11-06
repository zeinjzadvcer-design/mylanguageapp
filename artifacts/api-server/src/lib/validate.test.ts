import { describe, it, expect } from "vitest";
import { passwordSchema, registerSchema } from "./validate";

describe("passwordSchema", () => {
  it("rejects passwords shorter than 8 characters", () => {
    expect(passwordSchema.safeParse("ab1").success).toBe(false);
  });

  it("rejects passwords with only letters", () => {
    expect(passwordSchema.safeParse("abcdefgh").success).toBe(false);
  });

  it("rejects passwords with only numbers", () => {
    expect(passwordSchema.safeParse("12345678").success).toBe(false);
  });

  it("rejects a common weak password even when it meets the length and character rules", () => {
    expect(passwordSchema.safeParse("password1").success).toBe(false);
  });

  it("rejects weak passwords no matter the letter case", () => {
    expect(passwordSchema.safeParse("PASSWORD1").success).toBe(false);
  });

  it("rejects passwords longer than 100 characters", () => {
    const tooLong = "a1".repeat(60); // 120 characters
    expect(passwordSchema.safeParse(tooLong).success).toBe(false);
  });

  it("accepts a password that meets all the rules", () => {
    expect(passwordSchema.safeParse("Sunshine42").success).toBe(true);
  });
});

describe("registerSchema", () => {
  // referralSource is required at signup, so every case carries one; without
  // it the weak-password case below would be rejected for the wrong reason.
  const base = { name: "Sumaia", email: "sumaia@example.com", referralSource: "friend" };

  it("rejects registration without a referral source", () => {
    const { referralSource: _omit, ...withoutReferral } = base;
    const result = registerSchema.safeParse({ ...withoutReferral, password: "Sunshine42" });
    expect(result.success).toBe(false);
  });

  it("rejects registration when the password is weak", () => {
    const result = registerSchema.safeParse({ ...base, password: "aaaaaaaa" });
    expect(result.success).toBe(false);
  });

  it("accepts registration with a strong password and fills in defaults", () => {
    const result = registerSchema.safeParse({ ...base, password: "Sunshine42" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.preferredLanguage).toBe("ar");
      expect(result.data.country).toBe("SY");
    }
  });
});
