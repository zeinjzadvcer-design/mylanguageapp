import { describe, it, expect } from "vitest";
import bcryptjs from "bcryptjs";
import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies what it hashed", async () => {
    const stored = await hashPassword("Secret12345");
    expect(stored).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword("Secret12345", stored)).toBe(true);
    expect(await verifyPassword("Wrong12345", stored)).toBe(false);
  });

  it("verifies every password stored before the switch from bcryptjs", async () => {
    // What bcryptjs wrote: $2b$ by default, $2a$ from older versions. The two
    // differ only in the prefix for any password under 255 bytes.
    const written = bcryptjs.hashSync("Secret12345", 10);
    for (const prefix of ["2a", "2b"] as const) {
      const legacy = written.replace(/^\$2[aby]\$/, `$${prefix}$`);
      expect(legacy.startsWith(`$${prefix}$10$`)).toBe(true);
      expect(await verifyPassword("Secret12345", legacy)).toBe(true);
      expect(await verifyPassword("Wrong12345", legacy)).toBe(false);
    }
  });

  it("produces hashes bcryptjs can read, so switching back stays possible", async () => {
    const stored = await hashPassword("Secret12345");
    expect(bcryptjs.compareSync("Secret12345", stored)).toBe(true);
  });

  it("treats non-ASCII passwords the same way bcryptjs did", async () => {
    const legacy = bcryptjs.hashSync("كلمة-سر-٢٠٢٦", 10);
    expect(await verifyPassword("كلمة-سر-٢٠٢٦", legacy)).toBe(true);
  });

  it("answers false, not an error, for a damaged hash", async () => {
    expect(await verifyPassword("Secret12345", "not-a-hash")).toBe(false);
  });
});
