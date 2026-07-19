import type { PolicyClient } from '../hermes.js';
import { usesExplicitCacheControl } from './model-cache.js';

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  sessionId?: string | undefined;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface OpenRouterResponse {
  text: string;
  finishReason: string | null;
  nativeFinishReason: string | null;
  usage: OpenRouterUsage;
}

export class OpenRouterClient implements PolicyClient {
  constructor(private readonly options: OpenRouterOptions) {}

  /** PolicyClient interface — returns just the text. */
  async complete(system: string, user: string): Promise<string> {
    const result = await this.completeWithUsage(system, user);
    return result.text;
  }

  /** Extended call that returns usage/cost info. */
  async completeWithUsage(system: string, user: string): Promise<OpenRouterResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
          'HTTP-Referer': 'https://unbrewed-agent.up.railway.app',
          'X-Title': 'Unbrewed Agent',
        },
        body: JSON.stringify({
          model: this.options.model,
          session_id: this.options.sessionId,
          messages: [
            {
              role: 'system',
              content: usesExplicitCacheControl(this.options.model)
                ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
                : system,
            },
            { role: 'user', content: user },
          ],
          temperature: 0.3,
          reasoning: { effort: 'none', exclude: true },
          // Leave enough visible output budget for providers that still add overhead.
          // Keep the reason concise in the prompt, but leave enough budget to finish.
          max_tokens: 512,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${text.slice(0, 500)}`);
      }
      const data = (await response.json()) as {
        id?: string;
        choices?: {
          message?: { content?: string };
          finish_reason?: string | null;
          native_finish_reason?: string | null;
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_tokens_details?: {
            cached_tokens?: number;
            cache_write_tokens?: number;
          };
          cache_read_tokens?: number;
          cache_write_tokens?: number;
          cost?: number | string; // OpenRouter sometimes includes cost directly
        };
      };
      // Preserve empty/partial provider responses together with usage and finish
      // metadata. GameSession will fall back, while diagnostics retain the cause.
      const text = data.choices?.[0]?.message?.content ?? '';

      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;

      // Try to get cost: OpenRouter includes it in usage.cost or we fetch it
      let costUsd = Number(data.usage?.cost ?? 0);
      if (!Number.isFinite(costUsd)) costUsd = 0;
      if (!costUsd && data.id) {
        costUsd = await fetchGenerationCost(this.options.apiKey, data.id);
      }

      const usage: OpenRouterUsage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: data.usage?.total_tokens ?? promptTokens + completionTokens,
        cache_read_tokens: data.usage?.prompt_tokens_details?.cached_tokens
          ?? data.usage?.cache_read_tokens
          ?? 0,
        cache_write_tokens: data.usage?.prompt_tokens_details?.cache_write_tokens
          ?? data.usage?.cache_write_tokens
          ?? 0,
        cost_usd: costUsd,
      };
      return {
        text,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        nativeFinishReason: data.choices?.[0]?.native_finish_reason ?? null,
        usage,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Fetch cost from OpenRouter generation endpoint after a response. */
export async function fetchGenerationCost(
  apiKey: string,
  generationId: string,
): Promise<number> {
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${generationId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as { data?: { total_cost?: number } };
    return data.data?.total_cost ?? 0;
  } catch {
    return 0;
  }
}
