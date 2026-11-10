import { describe, it, expect } from "vitest";
import { envInt } from "./env";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("envInt", () => {
  it("reads a number", () => {
    expect(envInt("X", 30, env({ X: "12" }))).toBe(12);
  });

  it("keeps a deliberate zero", () => {
    expect(envInt("X", 30, env({ X: "0" }))).toBe(0);
  });

  it("uses the default when the setting is missing", () => {
    expect(envInt("X", 30, env({}))).toBe(30);
  });

  it("uses the default when the setting is blank, as the DO console saves it", () => {
    expect(envInt("X", 30, env({ X: "" }))).toBe(30);
    expect(envInt("X", 30, env({ X: "   " }))).toBe(30);
  });

  it("uses the default for something that is not a number", () => {
    expect(envInt("X", 30, env({ X: "thirty" }))).toBe(30);
  });
});
