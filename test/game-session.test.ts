import { describe, expect, it } from 'vitest';
import { hasRepeatedExactAction } from '../src/server/game-session.js';

describe('game action cycle detection', () => {
  it('does not treat repeated action types with distinct payloads as a cycle', () => {
    const signatures = Array.from({ length: 10 }, (_, index) => JSON.stringify({
      type: 'RESPOND_PROMPT',
      promptId: `prompt-${index}`,
      optionId: `option-${index}`,
    }));
    expect(hasRepeatedExactAction(signatures)).toBe(false);
  });

  it('detects an exact submitted action repeated six times in ten decisions', () => {
    const repeated = JSON.stringify({ type: 'MANEUVER', player: 'p1' });
    const signatures = [
      repeated,
      JSON.stringify({ type: 'ATTACK', target: 'a' }),
      repeated,
      JSON.stringify({ type: 'ATTACK', target: 'b' }),
      repeated,
      JSON.stringify({ type: 'ATTACK', target: 'c' }),
      repeated,
      repeated,
      JSON.stringify({ type: 'ATTACK', target: 'd' }),
      repeated,
    ];
    expect(hasRepeatedExactAction(signatures)).toBe(true);
  });
});
