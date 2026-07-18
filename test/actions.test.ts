import { describe, expect, it } from 'vitest';
import { indexLegalActions, chooseValidatedAction, summarizeAction } from '../src/actions.js';
import type { Action } from '../src/protocol.js';

const attack = { type: 'ATTACK', player: 'p1', attacker: 'a', defender: 'd', card: 'c1' } as unknown as Action;
const maneuver = { type: 'MANEUVER_DRAW', player: 'p1' } as unknown as Action;
const forfeit = { type: 'FORFEIT', player: 'p1' } as unknown as Action;

describe('action indexing', () => {
  it('preserves exact legal action objects while adding stable indexes and summaries', () => {
    const indexed = indexLegalActions([attack, maneuver]);

    expect(indexed).toEqual([
      { index: 0, action: attack, summary: summarizeAction(attack) },
      { index: 1, action: maneuver, summary: summarizeAction(maneuver) },
    ]);
    expect(indexed[0]!.action).toBe(attack);
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
