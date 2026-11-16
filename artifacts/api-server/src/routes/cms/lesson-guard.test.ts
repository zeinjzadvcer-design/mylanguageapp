import { describe, expect, it } from "vitest";
import { lessonIdFrom } from "./lesson-guard";

describe("a lesson id from a request body", () => {
  it("keeps a number", () => {
    expect(lessonIdFrom(42)).toBe(42);
  });

  it("reads one written as a string, which the database would accept as the same lesson", () => {
    expect(lessonIdFrom("42")).toBe(42);
  });

  it("tells leaving it alone apart from detaching it", () => {
    expect(lessonIdFrom(undefined)).toBeUndefined();
    expect(lessonIdFrom(null)).toBeNull();
    expect(lessonIdFrom("")).toBeNull();
  });

  it("refuses anything that is not a lesson id", () => {
    for (const bad of ["42abc", " 42", "4.2", 4.2, 0, -3, "-3", true, {}, [42]]) {
      expect(lessonIdFrom(bad)).toBe("invalid");
    }
  });
});
