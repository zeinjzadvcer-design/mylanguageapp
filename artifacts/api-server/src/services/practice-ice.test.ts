import { describe, it, expect, afterEach } from "vitest";
import { iceServers } from "./practice";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("ICE transport policy for peer calls", () => {
  it("is relay-only once a TURN relay is configured, so neither student sees the other's IP", async () => {
    process.env.PRACTICE_TURN_URLS = "turn:turn.example.test:3478";
    delete process.env.PRACTICE_RELAY_ONLY;
    const config = await iceServers();
    expect(config.hasTurn).toBe(true);
    expect(config.iceTransportPolicy).toBe("relay");
  });

  it("can be switched back to direct connections", async () => {
    process.env.PRACTICE_TURN_URLS = "turn:turn.example.test:3478";
    process.env.PRACTICE_RELAY_ONLY = "false";
    expect((await iceServers()).iceTransportPolicy).toBe("all");
  });

  it("allows direct connections when there is no relay, rather than no calls at all", async () => {
    process.env.PRACTICE_TURN_URLS = "";
    const config = await iceServers();
    expect(config.hasTurn).toBe(false);
    expect(config.iceTransportPolicy).toBe("all");
  });
});
