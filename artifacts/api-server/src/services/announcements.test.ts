import { describe, expect, it } from "vitest";
import { audiencePlanCodes } from "./announcements";

const known = ["free", "general_basic", "general_plus", "pro_basic", "pro_plus"];

describe("audiencePlanCodes", () => {
  it("means every student for the 'all' audience", () => {
    expect(audiencePlanCodes({ kind: "all" }, known)).toBeNull();
  });

  it("keeps the chosen plans, each once", () => {
    expect(
      audiencePlanCodes({ kind: "plans", planCodes: ["general_basic", "free", "general_basic"] }, known),
    ).toEqual(["general_basic", "free"]);
  });

  it("drops plans that do not exist rather than trusting them", () => {
    expect(audiencePlanCodes({ kind: "plans", planCodes: ["pro_basic", "vip"] }, known)).toEqual(["pro_basic"]);
  });

  it("never widens to everyone when no chosen plan exists", () => {
    // An empty list reaches nobody; only the 'all' audience reaches everyone.
    expect(audiencePlanCodes({ kind: "plans", planCodes: ["vip"] }, known)).toEqual([]);
  });
});
