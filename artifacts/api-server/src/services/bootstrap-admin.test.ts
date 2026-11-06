import { describe, it, expect } from "vitest";
import {
  decideBootstrapAdmin,
  readBootstrapConfig,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  type BootstrapInput,
} from "./bootstrap-admin";

function input(over: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    adminCount: 0,
    emailTaken: false,
    email: DEFAULT_ADMIN_EMAIL,
    password: DEFAULT_ADMIN_PASSWORD,
    ...over,
  };
}

describe("creating the first administrator", () => {
  it("creates one on an empty database", () => {
    // The whole point: a fresh checkout has a way in without anyone opening
    // psql.
    expect(decideBootstrapAdmin(input()).action).toBe("create");
  });

  it("accepts the documented default password, which passes the app's own rules", () => {
    // If the default were rejected by passwordSchema the feature would be
    // broken on a fresh checkout — the one case nobody thinks to test.
    expect(decideBootstrapAdmin(input())).toMatchObject({
      action: "create",
      email: DEFAULT_ADMIN_EMAIL,
      password: DEFAULT_ADMIN_PASSWORD,
    });
  });

  it("creates one in production from values the operator chose", () => {
    const deployment = decideBootstrapAdmin(
      input({ email: "ops@lughati.app", password: "a-real-secret-9", production: true }),
    );
    expect(deployment).toMatchObject({ action: "create", email: "ops@lughati.app" });
  });
});

describe("the documented defaults in production", () => {
  // The defaults are printed in .env.example, the compose file and the deploy
  // docs. On a public URL they are an administrator login anyone can look up.
  it("refuses the default email and password together", () => {
    expect(decideBootstrapAdmin(input({ production: true }))).toMatchObject({
      action: "skip",
      reason: "DEFAULT_CREDENTIALS",
    });
  });

  it("refuses the default password with a chosen email", () => {
    expect(
      decideBootstrapAdmin(input({ email: "ops@lughati.app", production: true })),
    ).toMatchObject({ action: "skip", reason: "DEFAULT_CREDENTIALS" });
  });

  it("refuses the default email with a chosen password", () => {
    expect(
      decideBootstrapAdmin(input({ password: "a-real-secret-9", production: true })),
    ).toMatchObject({ action: "skip", reason: "DEFAULT_CREDENTIALS" });
  });

  it("refuses what an unset production environment reads as", () => {
    const config = readBootstrapConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(decideBootstrapAdmin(input(config))).toMatchObject({
      action: "skip",
      reason: "DEFAULT_CREDENTIALS",
    });
  });

  it("still allows them outside production, so a fresh checkout has a way in", () => {
    const config = readBootstrapConfig({} as NodeJS.ProcessEnv);
    expect(decideBootstrapAdmin(input(config)).action).toBe("create");
  });
});

describe("when it must not create one", () => {
  it("does nothing when any administrator already exists", () => {
    expect(decideBootstrapAdmin(input({ adminCount: 1 }))).toMatchObject({
      action: "skip",
      reason: "ADMIN_EXISTS",
    });
  });

  it("does not recreate the default after someone promoted their own account and deleted it", () => {
    // The check counts administrators rather than looking for the email.
    // Keying it to the email would resurrect a deleted account on the next
    // restart — a door the operator thought they had closed.
    expect(
      decideBootstrapAdmin(
        input({ adminCount: 1, emailTaken: false, email: "someone-else@example.com" }),
      ),
    ).toMatchObject({ action: "skip", reason: "ADMIN_EXISTS" });
  });

  it("does not touch an existing non-administrator account with that email", () => {
    // Silently promoting a student because their address happens to match
    // ADMIN_EMAIL would be a privilege escalation nobody asked for.
    expect(decideBootstrapAdmin(input({ emailTaken: true }))).toMatchObject({
      action: "skip",
      reason: "EMAIL_TAKEN",
    });
  });

  it("holds ADMIN_PASSWORD to the same rules a student's password must pass", () => {
    expect(decideBootstrapAdmin(input({ password: "short" }))).toMatchObject({
      action: "skip",
      reason: "WEAK_PASSWORD",
    });
  });

  it("rejects a password with no number, like registration does", () => {
    expect(decideBootstrapAdmin(input({ password: "onlylettershere" }))).toMatchObject({
      action: "skip",
      reason: "WEAK_PASSWORD",
    });
  });

  it("says no administrator was created when it rejects the password", () => {
    // Otherwise the first sign of trouble is the login screen.
    const d = decideBootstrapAdmin(input({ password: "short" }));
    if (d.action === "skip") expect(d.message).toMatch(/No administrator was created/);
  });

  it("rejects a malformed ADMIN_EMAIL rather than creating an unusable login", () => {
    expect(decideBootstrapAdmin(input({ email: "not-an-email" }))).toMatchObject({
      action: "skip",
      reason: "INVALID_EMAIL",
    });
  });
});

describe("reading the environment", () => {
  it("falls back to the documented defaults when .env sets nothing", () => {
    const c = readBootstrapConfig({} as NodeJS.ProcessEnv);
    expect(c.email).toBe(DEFAULT_ADMIN_EMAIL);
    expect(c.password).toBe(DEFAULT_ADMIN_PASSWORD);
  });

  it("uses what .env sets", () => {
    const c = readBootstrapConfig({
      ADMIN_EMAIL: "ops@lughati.app",
      ADMIN_PASSWORD: "a-real-secret-9",
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({ email: "ops@lughati.app", password: "a-real-secret-9", production: false });
  });

  it("treats an empty or blank value as unset, not as a chosen empty password", () => {
    // A commented-out or blank line in .env is someone not setting it, not
    // someone choosing "".
    const c = readBootstrapConfig({
      ADMIN_EMAIL: "",
      ADMIN_PASSWORD: "   ",
    } as NodeJS.ProcessEnv);
    expect(c.email).toBe(DEFAULT_ADMIN_EMAIL);
    expect(c.password).toBe(DEFAULT_ADMIN_PASSWORD);
  });

  it("lowercases ADMIN_EMAIL, because that is how login looks accounts up", () => {
    const c = readBootstrapConfig({ ADMIN_EMAIL: "Admin@Example.COM" } as NodeJS.ProcessEnv);
    expect(c.email).toBe("admin@example.com");
  });
});
