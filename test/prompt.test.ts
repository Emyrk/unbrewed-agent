import { describe, expect, it } from 'vitest';
import { buildPolicyRequest, GAMEPLAY_SYSTEM_PROMPT } from '../src/prompt.js';
import type { Action, ServerStateMessage } from '../src/protocol.js';

const move = { type: 'MANEUVER_DRAW', player: 'p1' } as unknown as Action;

describe('policy prompt contract', () => {
  it('locks Hermes into JSON-only policy mode without tool calls', () => {
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('Do not call tools');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('Output JSON only');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('Choose exactly one legal action by index');
  });

  it('builds a redacted observation request with indexed legal actions', () => {
    const state = {
      type: 'STATE',
      v: 21,
      view: { self: { id: 'p1' }, phase: 'PLAY' },
      legalActions: [move],
      events: [{ type: 'TURN_STARTED', player: 'p1' }],
    } as unknown as ServerStateMessage;

    const request = buildPolicyRequest({ state, seat: 'p1', roomId: 'room-1', strategyNotes: ['value actions that preserve cards'] });

    expect(request.system).toBe(GAMEPLAY_SYSTEM_PROMPT);
    const body = JSON.parse(request.user);
    expect(body.roomId).toBe('room-1');
    expect(body.seat).toBe('p1');
    expect(body.view).toEqual(state.view);
    expect(body.legalActions).toEqual([{ index: 0, summary: 'MANEUVER_DRAW {"player":"p1"}', action: move }]);
    expect(body.strategyNotes).toEqual(['value actions that preserve cards']);
  });
});
