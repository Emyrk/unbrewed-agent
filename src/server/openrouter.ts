import type { PolicyClient } from '../hermes.js';

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface OpenRouterResponse {
  text: string;
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
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${text.slice(0, 500)}`);
      }
      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) throw new Error('OpenRouter returned empty response');

      // OpenRouter returns cost in the generation endpoint or we estimate
      const usage: OpenRouterUsage = {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        total_tokens: data.usage?.total_tokens ?? 0,
        cost_usd: 0, // Will be filled by generation lookup if available
      };
      return { text, usage };
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
