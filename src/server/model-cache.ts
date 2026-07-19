export interface OpenRouterModel {
  id: string;
  reasoning?: {
    mandatory?: boolean;
    [key: string]: unknown;
  };
  pricing?: {
    prompt?: string | number;
    input_cache_read?: string | number;
    input_cache_write?: string | number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

/**
 * OpenRouter exposes cache pricing only for models with a cache-capable route.
 * Requiring a discounted input_cache_read rate is a conservative, machine-readable
 * alternative to maintaining a provider/model allowlist.
 */
export function supportsPromptCaching(model: OpenRouterModel): boolean {
  const prompt = Number(model.pricing?.prompt);
  const cacheRead = Number(model.pricing?.input_cache_read);
  return Number.isFinite(cacheRead)
    && cacheRead >= 0
    && Number.isFinite(prompt)
    && prompt > 0
    && cacheRead < prompt;
}

export function supportsGameplayModel(model: OpenRouterModel): boolean {
  return supportsPromptCaching(model) && model.reasoning?.mandatory !== true;
}

export function filterCacheCapableModels(response: OpenRouterModelsResponse): OpenRouterModelsResponse {
  // Gameplay requires visible, concise JSON. Mandatory-reasoning models can spend
  // the entire completion budget before emitting content, so exclude them.
  return { data: response.data.filter(supportsGameplayModel) };
}

/** Providers where OpenRouter documents an explicit cache_control breakpoint. */
export function usesExplicitCacheControl(modelId: string): boolean {
  return modelId.startsWith('anthropic/')
    || modelId === 'qwen/qwen3.5-plus-02-15'
    || modelId === 'qwen/qwen3.5-397b-a17b'
    || modelId === 'deepseek/deepseek-v3.2';
}
