import { describe, expect, it } from 'vitest';
import {
  filterCacheCapableModels,
  supportsPromptCaching,
  usesExplicitCacheControl,
} from '../src/server/model-cache.js';

describe('OpenRouter prompt cache model filtering', () => {
  it('requires a discounted input cache read price', () => {
    expect(supportsPromptCaching({
      id: 'cache/model',
      pricing: { prompt: '0.000002', input_cache_read: '0.0000005' },
    })).toBe(true);
    expect(supportsPromptCaching({ id: 'plain/model', pricing: { prompt: '0.000002' } })).toBe(false);
    expect(supportsPromptCaching({
      id: 'not-discounted/model',
      pricing: { prompt: '0.000002', input_cache_read: '0.000002' },
    })).toBe(false);
  });

  it('filters the catalog without mutating model metadata', () => {
    const response = {
      data: [
        { id: 'cache/model', name: 'Cached', pricing: { prompt: '1', input_cache_read: '0.1' } },
        { id: 'plain/model', name: 'Plain', pricing: { prompt: '1' } },
      ],
    };
    expect(filterCacheCapableModels(response).data).toEqual([response.data[0]]);
  });

  it('uses explicit cache breakpoints only for documented model families', () => {
    expect(usesExplicitCacheControl('anthropic/claude-sonnet-4')).toBe(true);
    expect(usesExplicitCacheControl('deepseek/deepseek-v3.2')).toBe(true);
    expect(usesExplicitCacheControl('openai/gpt-4.1')).toBe(false);
  });
});
