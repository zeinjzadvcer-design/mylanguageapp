import { describe, it, expect } from "vitest";
import { isKnownDevice, rememberDevice } from "./known-device";

/** The cookie header a browser would send after signing in as `email`. */
function cookieFor(email: string): string {
  let header = "";
  rememberDevice(
    { cookie: ((name: string, value: string) => { header = `${name}=${value}`; }) as never },
    email,
  );
  return header;
}

const withCookie = (cookie?: string) => ({ headers: { cookie } });

describe("recognising a browser that has signed in before", () => {
  it("recognises the cookie it issued for that address", () => {
    expect(isKnownDevice(withCookie(cookieFor("a@example.test")), "a@example.test")).toBe(true);
  });

  it("ignores case and surrounding spaces in the address", () => {
    expect(isKnownDevice(withCookie(cookieFor("a@example.test")), " A@Example.TEST ")).toBe(true);
  });

  it("finds it among other cookies", () => {
    const cookie = `connect.sid=abc; ${cookieFor("a@example.test")}; theme=dark`;
    expect(isKnownDevice(withCookie(cookie), "a@example.test")).toBe(true);
  });

  it("does not accept another account's cookie", () => {
    expect(isKnownDevice(withCookie(cookieFor("b@example.test")), "a@example.test")).toBe(false);
  });

  it("does not accept a forged value", () => {
    expect(isKnownDevice(withCookie("known_device=AAAA"), "a@example.test")).toBe(false);
  });

  it("is false with no cookie at all", () => {
    expect(isKnownDevice(withCookie(undefined), "a@example.test")).toBe(false);
  });
});
