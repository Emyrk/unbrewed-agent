import { describe, expect, it } from 'vitest';
import { createShareToken, hashShareToken } from '../src/server/share-token.js';

describe('diagnostic share tokens', () => {
  it('creates high-entropy URL-safe tokens and stores only a deterministic hash', () => {
    const first = createShareToken();
    const second = createShareToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(first).not.toBe(second);
    expect(hashShareToken(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashShareToken(first)).toBe(hashShareToken(first));
    expect(hashShareToken(first)).not.toBe(hashShareToken(second));
  });
});
