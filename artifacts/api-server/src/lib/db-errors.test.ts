import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./db-errors";

describe("isUniqueViolation", () => {
  it("recognises the Postgres code on the error itself", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("finds the code under the wrapper Drizzle adds", () => {
    expect(isUniqueViolation(new Error("Failed query", { cause: { code: "23505" } }))).toBe(true);
  });

  it("is false for any other failure", () => {
    expect(isUniqueViolation(new Error("timeout"))).toBe(false);
    expect(isUniqueViolation({ code: "23514" })).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
