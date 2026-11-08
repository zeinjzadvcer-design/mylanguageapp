import { describe, it, expect } from "vitest";
import { clientAddressIsKnown, clientIp } from "./client-ip";

/** A request with these headers and this `req.ip`. */
function req(headers: Record<string, string>, ip = "10.0.0.1") {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ip, get: (name: string) => lower[name.toLowerCase()] } as Parameters<typeof clientIp>[0];
}

describe("whether visitors can be told apart", () => {
  const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

  it("is no in production without a client-IP header", () => {
    expect(clientAddressIsKnown(env({ NODE_ENV: "production" }))).toBe(false);
    expect(clientAddressIsKnown(env({ NODE_ENV: "production", CLIENT_IP_HEADER: "  " }))).toBe(false);
  });

  it("is yes in production once the header is set", () => {
    expect(
      clientAddressIsKnown(env({ NODE_ENV: "production", CLIENT_IP_HEADER: "do-connecting-ip" })),
    ).toBe(true);
  });

  it("is yes outside production, where no ingress hides the visitor", () => {
    expect(clientAddressIsKnown(env({ NODE_ENV: "development" }))).toBe(true);
  });
});

describe("the address rate limits are keyed on", () => {
  it("is req.ip when no header is configured, as before", () => {
    expect(clientIp(req({ "do-connecting-ip": "203.0.113.9" }), undefined)).toBe("10.0.0.1");
  });

  it("is the configured header when the platform sets it", () => {
    expect(clientIp(req({ "do-connecting-ip": "203.0.113.9" }), "do-connecting-ip")).toBe("203.0.113.9");
  });

  it("matches the header name case-insensitively and ignores spaces around it", () => {
    expect(clientIp(req({ "DO-Connecting-IP": "203.0.113.9" }), " DO-Connecting-IP ")).toBe("203.0.113.9");
  });

  it("falls back to req.ip when the header is missing", () => {
    expect(clientIp(req({}), "do-connecting-ip")).toBe("10.0.0.1");
  });

  it("ignores a value that is not an address, so junk cannot invent buckets", () => {
    expect(clientIp(req({ "do-connecting-ip": "not-an-ip" }), "do-connecting-ip")).toBe("10.0.0.1");
    expect(clientIp(req({ "do-connecting-ip": "" }), "do-connecting-ip")).toBe("10.0.0.1");
  });

  it("takes the first entry of a list", () => {
    expect(clientIp(req({ "do-connecting-ip": "203.0.113.9, 10.1.1.1" }), "do-connecting-ip")).toBe("203.0.113.9");
  });

  it("groups an IPv6 address by its /56, like the limiter's own default", () => {
    const a = clientIp(req({ "do-connecting-ip": "2001:db8:1:100::1" }), "do-connecting-ip");
    const b = clientIp(req({ "do-connecting-ip": "2001:db8:1:1ff::2" }), "do-connecting-ip");
    expect(a).toBe(b);
  });
});
