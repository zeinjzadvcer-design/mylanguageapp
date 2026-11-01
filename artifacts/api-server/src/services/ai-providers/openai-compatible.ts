/**
 * One client for every provider worth using.
 *
 * NVIDIA NIM, DeepSeek, Groq, Together, vLLM and Ollama all expose the OpenAI
 * chat-completions shape, so switching between them is a base URL and a key —
 * both of which come from the database at call time, not from the environment.
 * There is deliberately no provider-specific branching here: the moment this
 * file starts asking "which vendor is this", the abstraction has failed.
 */

import { logger } from "../../lib/logger";
import type { ResolvedTaskConfig } from "../ai-config";

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AIProviderError extends Error {
  /** HTTP status from the provider, or 0 for a transport failure. */
  readonly status: number;
  /** True when retrying the same request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    retryable: boolean,
    options: { cause?: unknown } = {},
  ) {
    // The student-facing message stays generic on a transport failure, so the
    // underlying cause is the only record of WHY the call never landed. Keep it
    // on the error for the log; without it a one-off network blip is
    // indistinguishable from a broken request shape.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AIProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

// ─── Wire types ───────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage: ChatUsage;
  modelId: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
  error?: { message?: string };
}

/** Providers disagree about trailing slashes; normalise once here. */
function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** A 5xx or a rate limit may succeed on retry; a 4xx will not. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

const DEFAULT_TIMEOUT_MS = parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? "30000", 10);

async function postJson<T>(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  // A hung provider must not hold a student's request open indefinitely; the
  // lesson flow is supposed to survive AI being slow or absent.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new AIProviderError(
      aborted ? `AI request timed out after ${timeoutMs}ms` : "Could not reach the AI provider",
      0,
      true,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as ChatCompletionResponse;
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Not JSON — the truncated body is the best message available.
    }
    throw new AIProviderError(
      `AI provider returned ${response.status}: ${detail}`,
      response.status,
      isRetryable(response.status),
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AIProviderError("AI provider returned a response that was not JSON", 0, false);
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export async function chat(
  config: ResolvedTaskConfig,
  messages: ChatMessage[],
  opts: { jsonMode?: boolean } = {},
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: config.modelId,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: false,
  };

  // Ask for JSON where the provider supports it. Not every OpenAI-compatible
  // server implements response_format, which is why callers must still parse
  // defensively rather than trusting this to work.
  if (opts.jsonMode) body.response_format = { type: "json_object" };

  const data = await postJson<ChatCompletionResponse>(
    endpoint(config.baseUrl, "chat/completions"),
    config.apiKey,
    body,
  );

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new AIProviderError("AI provider returned no message content", 0, true);
  }

  return {
    content,
    modelId: data.model ?? config.modelId,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
  };
}

/**
 * Chat, expecting a JSON object back, parsed and validated by the caller.
 *
 * Models wrap JSON in prose or fences however much you ask them not to, so the
 * first `{...}` block is extracted rather than trusting the whole response to
 * parse. Grading a student must not fail because a model said "Sure!" first.
 */
export async function chatJson<T>(
  config: ResolvedTaskConfig,
  messages: ChatMessage[],
  validate: (value: unknown) => T,
): Promise<{ value: T; usage: ChatUsage; modelId: string }> {
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

/** Find and parse the first balanced `{...}` in a string. */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  ownedBy: string | null;
}

/**
 * What this endpoint offers, so the panel can present a list instead of asking
 * an administrator to type a model id correctly from memory.
 */
export async function listModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(endpoint(baseUrl, "models"), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new AIProviderError(
        `Could not list models (HTTP ${response.status})`,
        response.status,
        isRetryable(response.status),
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string; owned_by?: string }>;
    };

    return (data.data ?? [])
      .filter((m): m is { id: string; owned_by?: string } => typeof m.id === "string")
      .map((m) => ({ id: m.id, ownedBy: m.owned_by ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (err) {
    if (err instanceof AIProviderError) throw err;
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
}

export interface ConnectionTest {
  ok: boolean;
  latencyMs: number;
  modelId: string;
  reply: string;
  usage: ChatUsage;
}

/**
 * One tiny real call, so an administrator finds out the configuration is wrong
 * here rather than when a student's answer fails to grade.
 */
export async function testConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ConnectionTest> {
  const started = Date.now();

  const result = await chat(
    {
      task: "open_answer",
      baseUrl,
      apiKey,
      modelId,
      temperature: 0,
      maxTokens: 16,
      providerLabel: "test",
      // Prices are irrelevant here: the test call is not billed to a student
      // and is never recorded against the monthly budget.
      inputPricePerMtok: null,
      outputPricePerMtok: null,
      pricePerMinute: null,
    },
    [{ role: "user", content: "Reply with the single word: ready" }],
  );

  const latencyMs = Date.now() - started;
  logger.info({ modelId, latencyMs }, "AI connection test completed");

  return {
    ok: true,
    latencyMs,
    modelId: result.modelId,
    reply: result.content.trim().slice(0, 100),
    usage: result.usage,
  };
}
