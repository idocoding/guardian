/**
 * LLM Client — thin HTTP client for LLM-powered doc generation.
 *
 * Resolution order:
 *   1. Configured LLM  — SPECGUARD_LLM_ENDPOINT + SPECGUARD_LLM_API_KEY both set
 *   2. Ollama fallback — SPECGUARD_LLM_ENDPOINT/KEY not set, Ollama reachable at localhost
 *   3. None            — returns null from loadLlmConfig(), callers write placeholder text
 *
 * Env vars:
 *   SPECGUARD_LLM_ENDPOINT   — full URL e.g. https://api.anthropic.com/v1/messages
 *   SPECGUARD_LLM_API_KEY    — API key (not required for Ollama)
 *   SPECGUARD_LLM_MODEL      — model ID (optional)
 *   SPECGUARD_OLLAMA_HOST    — Ollama base URL (default: http://localhost:11434)
 *   SPECGUARD_OLLAMA_MODEL   — Ollama model (default: llama3.2)
 *
 * Wire formats (auto-detected from endpoint URL):
 *   anthropic  — POST /v1/messages        { model, max_tokens, system, messages }
 *   openai     — POST /v1/chat/completions { model, max_tokens, messages }
 *   ollama     — POST /api/chat            { model, stream:false, messages }
 *
 * No SDK dependency. Pure fetch.
 */

export type LlmProvider = "anthropic" | "openai" | "ollama";

export type LlmConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  provider: LlmProvider;
};

export type LlmMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

const DEFAULT_CLOUD_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Load LLM config from environment variables.
 *
 * Resolution order:
 *   1. SPECGUARD_LLM_ENDPOINT + SPECGUARD_LLM_API_KEY → configured cloud/local LLM
 *   2. Ollama reachable at SPECGUARD_OLLAMA_HOST (or localhost:11434) → Ollama fallback
 *   3. null → no LLM available
 */
export async function loadLlmConfig(): Promise<LlmConfig | null> {
  // Priority 1: explicit endpoint + key
  const endpoint = process.env["SPECGUARD_LLM_ENDPOINT"];
  const apiKey = process.env["SPECGUARD_LLM_API_KEY"];
  if (endpoint && apiKey) {
    const model = process.env["SPECGUARD_LLM_MODEL"] ?? DEFAULT_CLOUD_MODEL;
    return { endpoint, apiKey, model, provider: detectProvider(endpoint) };
  }

  // Priority 2: Ollama fallback
  const ollamaHost = process.env["SPECGUARD_OLLAMA_HOST"] ?? DEFAULT_OLLAMA_HOST;
  const ollamaModel = process.env["SPECGUARD_OLLAMA_MODEL"] ?? DEFAULT_OLLAMA_MODEL;
  if (await isOllamaReachable(ollamaHost)) {
    return {
      endpoint: `${ollamaHost}/api/chat`,
      apiKey: "",
      model: ollamaModel,
      provider: "ollama",
    };
  }

  return null;
}

/**
 * Synchronous version — only checks env vars, does NOT probe Ollama.
 * Use when async is not possible, or when you want to skip Ollama discovery.
 */
export function loadLlmConfigSync(): LlmConfig | null {
  const endpoint = process.env["SPECGUARD_LLM_ENDPOINT"];
  const apiKey = process.env["SPECGUARD_LLM_API_KEY"];
  if (!endpoint || !apiKey) return null;
  const model = process.env["SPECGUARD_LLM_MODEL"] ?? DEFAULT_CLOUD_MODEL;
  return { endpoint, apiKey, model, provider: detectProvider(endpoint) };
}

/**
 * Send messages to the LLM and return the response text.
 * Throws on HTTP errors.
 */
export async function llmComplete(
  config: LlmConfig,
  messages: LlmMessage[],
  maxTokens = DEFAULT_MAX_TOKENS
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  let body: Record<string, unknown>;

  if (config.provider === "anthropic") {
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = buildAnthropicBody(config.model, messages, maxTokens);
  } else if (config.provider === "ollama") {
    // Ollama: no auth header needed
    body = buildOllamaBody(config.model, messages);
  } else {
    // openai-compatible
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    body = buildOpenAIBody(config.model, messages, maxTokens);
  }

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`LLM request failed [${config.provider}]: ${response.status} ${response.statusText} — ${text}`);
  }

  const data = await response.json() as Record<string, unknown>;
  return extractText(config.provider, data);
}

// ── Format detection ──────────────────────────────────────────────────────

function detectProvider(endpoint: string): LlmProvider {
  const lower = endpoint.toLowerCase();
  if (lower.includes("anthropic") || lower.includes("/v1/messages")) return "anthropic";
  if (lower.includes("/api/chat") || lower.includes("11434")) return "ollama";
  return "openai";
}

// ── Body builders ─────────────────────────────────────────────────────────

function buildAnthropicBody(
  model: string,
  messages: LlmMessage[],
  maxTokens: number
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const systemText = systemMessages.map((m) => m.content).join("\n\n");

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: nonSystemMessages,
  };
  if (systemText) body["system"] = systemText;
  return body;
}

function buildOpenAIBody(
  model: string,
  messages: LlmMessage[],
  maxTokens: number
): Record<string, unknown> {
  return { model, max_tokens: maxTokens, messages };
}

function buildOllamaBody(
  model: string,
  messages: LlmMessage[]
): Record<string, unknown> {
  return { model, stream: false, messages };
}

// ── Response extraction ───────────────────────────────────────────────────

function extractText(provider: LlmProvider, data: Record<string, unknown>): string {
  if (provider === "anthropic") {
    const content = (data["content"] as Array<{ type: string; text: string }> | undefined) ?? [];
    return content.find((c) => c.type === "text")?.text ?? "";
  }
  if (provider === "ollama") {
    const message = data["message"] as { content?: string } | undefined;
    return message?.content ?? "";
  }
  // openai
  const choices = (data["choices"] as Array<{ message: { content: string } }> | undefined) ?? [];
  return choices[0]?.message?.content ?? "";
}

// ── Ollama availability probe ─────────────────────────────────────────────

async function isOllamaReachable(host: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
