import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels, testConnection } from "./index";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Records each request and answers it with `reply(url)`. */
function recordingFetch(reply: (url: string) => Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers?: Record<string, string> } = {}) => {
      calls.push({ url, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
      return reply(url);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin Test button", () => {
  it("speaks Anthropic's protocol to Anthropic", async () => {
    const calls = recordingFetch(() =>
      json({ model: "claude-x", content: [{ type: "text", text: "ready" }], usage: { input_tokens: 9, output_tokens: 1 } }),
    );
    const r = await testConnection("https://api.anthropic.com", "key-a", "claude-x");
    expect(r).toMatchObject({ ok: true, reply: "ready", modelId: "claude-x" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("key-a");
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it("reports Anthropic's own reason for refusing a key, without retrying", async () => {
    const calls = recordingFetch(() =>
      json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401),
    );
    await expect(testConnection("https://api.anthropic.com", "bad", "claude-x")).rejects.toMatchObject({
      message: "invalid x-api-key",
      status: 401,
    });
    expect(calls).toHaveLength(1);
  });

  it("still speaks OpenAI's protocol to everyone else", async () => {
    const calls = recordingFetch(() => json({ model: "m", choices: [{ message: { content: "ready" } }] }));
    await testConnection("https://provider.example/v1", "key-o", "m");
    expect(calls[0].url).toBe("https://provider.example/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer key-o");
  });
});

describe("admin model list", () => {
  it("asks Anthropic at /v1/models with its key header", async () => {
    const calls = recordingFetch(() => json({ data: [{ id: "claude-b" }, { id: "claude-a" }] }));
    const models = await listModels("https://api.anthropic.com/", "key-a");
    expect(models.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(calls[0].headers["x-api-key"]).toBe("key-a");
  });

  it("asks other providers at /models with a Bearer token", async () => {
    const calls = recordingFetch(() => json({ data: [{ id: "m1", owned_by: "x" }] }));
    expect(await listModels("https://provider.example/v1", "key-o")).toEqual([{ id: "m1", ownedBy: "x" }]);
    expect(calls[0].url).toBe("https://provider.example/v1/models");
    expect(calls[0].headers.authorization).toBe("Bearer key-o");
  });
});
