import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../src/server/openrouter.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OpenRouter usage telemetry', () => {
  it('returns token counts and numeric cost from the completion response', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'generation-1',
      choices: [{ message: { content: '{"choice":0}' } }],
      usage: {
        prompt_tokens: 4_321,
        completion_tokens: 79,
        total_tokens: 4_400,
        cost: '0.000593',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const client = new OpenRouterClient({ apiKey: 'test-key', model: 'test/model', timeoutMs: 1_000 });
    const result = await client.completeWithUsage('system', 'user');

    expect(result.text).toBe('{"choice":0}');
    expect(result.usage).toEqual({
      prompt_tokens: 4_321,
      completion_tokens: 79,
      total_tokens: 4_400,
      cost_usd: 0.000593,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
