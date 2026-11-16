/**
 * Anthropic Messages API.
 *
 * A separate adapter from `openai-compatible.ts` because Anthropic's API is not
 * OpenAI-shaped — three things differ and all three break the other adapter:
 *
 *   auth      `x-api-key` header, not `Authorization: Bearer`
 *   endpoint  `/v1/messages`, not `/chat/completions`
 *   shape     the system prompt is a TOP-LEVEL field, not a message with
 *             role "system"; the reply is `content[].text`, not
 *             `choices[0].message.content`
 *
 * Exposes the same `chat` / `chatJson` contract as the OpenAI adapter so the
 * graders and the conversation service do not care which provider is behind a
 * task.
 */

import type { ResolvedTaskConfig } from "../ai-config";
import {
  AIProviderError,
  extractJsonObject,
  type ChatMessage,
  type ChatResult,
  type ModelInfo,
} from "./openai-compatible";

/** Pinned: the wire format is versioned, and a silent change would be worse than a hard failure. */
const ANTHROPIC_VERSION = "2023-06-01";

function timeoutMs(): number {
  return parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? "30000", 10);
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

interface AnthropicError {
  error?: { type?: string; message?: string };
}

/**
 * True when retrying could plausibly succeed.
 *
 * 429 and 5xx are transient. 401/403 (bad key) and 400 (malformed request) are
 * not — retrying those just spends the quota again on the same failure.
 */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The models this key may use, for the picker at /admin/ai.
 *
 * Anthropic lists them at `/v1/models` behind the same `x-api-key` header as
 * chat; the OpenAI adapter's `/models` with a Bearer token is refused here.
 */
export async function listModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models?limit=1000`, {
      headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new AIProviderError(
      aborted ? "Listing models timed out" : "Could not reach the AI provider",
      0,
      true,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as AnthropicError | null;
    throw new AIProviderError(
      payload?.error?.message
        ? `Could not list models: ${payload.error.message}`
        : `Could not list models (HTTP ${response.status})`,
      response.status,
      isRetryable(response.status),
    );
  }

  const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({ id, ownedBy: "anthropic" }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function chat(
  config: ResolvedTaskConfig,
  messages: ChatMessage[],
  /** `timeoutMs` can only shorten the configured timeout, never extend it. */
  opts: { jsonMode?: boolean; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const limitMs = Math.min(opts.timeoutMs ?? timeoutMs(), timeoutMs());
  // Anthropic takes the system prompt as its own field. Several `system`
  // messages are joined rather than dropped — losing one would quietly change
  // the model's instructions.
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  if (turns.length === 0) {
    throw new AIProviderError("No user message to send", 0, false);
  }

  const body: Record<string, unknown> = {
    model: config.modelId,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    messages: turns,
  };
  if (system) body.system = system;

  // There is no response_format on this API. Asking in words is what the
  // callers already cope with — `chatJson` below strips fences regardless.
  if (opts.jsonMode) {
    body.system = `${system ? `${system}\n\n` : ""}Reply with a single JSON object and nothing else. No prose, no code fences.`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limitMs);

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new AIProviderError(
      aborted
        ? `AI request timed out after ${limitMs}ms`
        : "Could not reach the AI provider",
      0,
      true,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as AnthropicError | null;
    throw new AIProviderError(
      payload?.error?.message ?? `AI provider returned ${response.status}`,
      response.status,
      isRetryable(response.status),
    );
  }

  const data = (await response.json()) as AnthropicResponse;

  // A reply can hold several blocks; only the text ones carry the answer.
  const content = (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");

  if (!content) {
    throw new AIProviderError("AI provider returned no message content", 0, true);
  }

  const promptTokens = data.usage?.input_tokens ?? 0;
  const completionTokens = data.usage?.output_tokens ?? 0;

  return {
    content,
    modelId: data.model ?? config.modelId,
    usage: {
      promptTokens,
      completionTokens,
      // Anthropic reports the two separately and no total; the cost model and
      // the usage log both expect one.
      totalTokens: promptTokens + completionTokens,
    },
  };
}

/**
 * As `chat`, but parsed and validated.
 *
 * Reuses the OpenAI adapter's `extractJsonObject`: finding the first balanced
 * object handles fences and surrounding prose alike, which models produce
 * however firmly they are told not to.
 */
export async function chatJson<T>(
  config: ResolvedTaskConfig,
  messages: ChatMessage[],
  validate: (value: unknown) => T,
): Promise<{ value: T; usage: ChatResult["usage"]; modelId: string }> {
  const result = await chat(config, messages, { jsonMode: true });

  const parsed = extractJsonObject(result.content);
  if (parsed === null) {
    throw new AIProviderError(
      `AI response contained no JSON object: ${result.content.slice(0, 200)}`,
      0,
      true,
    );
  }

  return { value: validate(parsed), usage: result.usage, modelId: result.modelId };
}
