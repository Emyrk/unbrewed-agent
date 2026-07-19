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
      choices: [{
        message: { content: '{"choice":0}' },
        finish_reason: 'stop',
        native_finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 4_321,
        completion_tokens: 79,
        total_tokens: 4_400,
        prompt_tokens_details: { cached_tokens: 3_200, cache_write_tokens: 900 },
        cost: '0.000593',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const client = new OpenRouterClient({
      apiKey: 'test-key',
      model: 'anthropic/claude-sonnet-4',
      timeoutMs: 1_000,
      sessionId: 'game-123',
    });
    const result = await client.completeWithUsage('system', 'user');

    expect(result.text).toBe('{"choice":0}');
    expect(result.finishReason).toBe('stop');
    expect(result.nativeFinishReason).toBe('stop');
    expect(result.usage).toEqual({
      prompt_tokens: 4_321,
      completion_tokens: 79,
      total_tokens: 4_400,
      cache_read_tokens: 3_200,
      cache_write_tokens: 900,
      cost_usd: 0.000593,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.session_id).toBe('game-123');
    expect(body.max_tokens).toBe(512);
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('preserves usage and finish metadata when the provider returns no visible text', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'generation-empty',
      choices: [{ message: { content: '' }, finish_reason: 'length', native_finish_reason: 'max_tokens' }],
      usage: { prompt_tokens: 500, completion_tokens: 512, total_tokens: 1_012, cost: '0.01' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const client = new OpenRouterClient({ apiKey: 'test-key', model: 'openai/gpt-5', timeoutMs: 1_000 });
    const result = await client.completeWithUsage('system', 'user');

    expect(result.text).toBe('');
    expect(result.finishReason).toBe('length');
    expect(result.nativeFinishReason).toBe('max_tokens');
    expect(result.usage.total_tokens).toBe(1_012);
    expect(result.usage.cost_usd).toBe(0.01);
  });
});
