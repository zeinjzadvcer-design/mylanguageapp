import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "./index";
import type { ResolvedTaskConfig } from "../ai-config";

const config = {
  baseUrl: "https://provider.example/v1",
  apiKey: "k",
  modelId: "m",
  temperature: 0.2,
  maxTokens: 50,
} as ResolvedTaskConfig;

/** A provider that never answers: each request waits until it is aborted. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat with a deadline", () => {
  it("gives up within the deadline, retries included, instead of after every full timeout", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    await expect(
      chat(config, [{ role: "user", content: "hi" }], { deadlineMs: 2_500 }),
    ).rejects.toThrow(/timed out|ran out of time/);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("still answers when the provider is quick", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ model: "m", choices: [{ message: { content: "Hello" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const result = await chat(config, [{ role: "user", content: "hi" }], { deadlineMs: 2_500 });
    expect(result.content).toBe("Hello");
  });
});
