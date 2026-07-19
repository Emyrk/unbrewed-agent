import { describe, expect, it } from 'vitest';
import { indexLegalActions, chooseValidatedAction } from '../src/actions.js';
import type { Action } from '../src/protocol.js';

const attack = { type: 'ATTACK', player: 'p1', attacker: 'a', defender: 'd', card: 'c1' } as unknown as Action;
const maneuver = { type: 'MANEUVER_DRAW', player: 'p1' } as unknown as Action;
const forfeit = { type: 'FORFEIT', player: 'p1' } as unknown as Action;

describe('action indexing', () => {
  it('serializes each legal action once while adding a stable index', () => {
    const indexed = indexLegalActions([attack, maneuver]);

    expect(indexed).toEqual([
      { ...attack, index: 0 },
      { ...maneuver, index: 1 },
    ]);
  });
});

describe('validated action choice', () => {
  it('uses the model-selected action when the output is valid JSON with an in-range choice', () => {
    const result = chooseValidatedAction('{"choice":1,"confidence":0.8,"reason":"draw first"}', [attack, maneuver]);

    expect(result.action).toBe(maneuver);
    expect(result.source).toBe('model');
    expect(result.reason).toBe('draw first');
  });

  it('extracts JSON from fenced or prose-wrapped model output', () => {
    const result = chooseValidatedAction('```json\n{"choice":0,"reason":"pressure"}\n```', [attack]);

    expect(result.action).toBe(attack);
    expect(result.source).toBe('model');
  });

  it('accepts the exact fenced JSON shape produced by gameplay models', () => {
    const raw = '```json\n{"choice":1,"confidence":0.9,"reason":"Draw to find attack options and reposition Veyra safely."}\n```';
    const result = chooseValidatedAction(raw, [attack, maneuver]);

    expect(result.action).toBe(maneuver);
    expect(result.source).toBe('model');
    expect(result.error).toBeUndefined();
  });

  it('falls back to the first non-forfeit action when output is invalid', () => {
    const result = chooseValidatedAction('I choose to be spooky', [forfeit, maneuver]);

    expect(result.action).toBe(maneuver);
    expect(result.source).toBe('fallback');
    expect(result.error).toContain('No JSON object');
  });

  it('falls back when the model chooses an out-of-range action', () => {
    const result = chooseValidatedAction('{"choice":99,"reason":"oops"}', [attack, maneuver]);

    expect(result.action).toBe(attack);
    expect(result.source).toBe('fallback');
    expect(result.error).toContain('out of range');
  });
});
