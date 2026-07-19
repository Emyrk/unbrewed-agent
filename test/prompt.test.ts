import { describe, expect, it } from 'vitest';
import { buildPolicyRequest, GAMEPLAY_SYSTEM_PROMPT } from '../src/prompt.js';
import type { Action, ServerStateMessage } from '../src/protocol.js';

const move = { type: 'MANEUVER_DRAW', player: 'p1' } as unknown as Action;

describe('policy prompt contract', () => {
  it('includes competitive Unmatched rules and locks the model into JSON-only policy mode', () => {
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('exactly 2 actions');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('MANEUVER');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('EXHAUSTION');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('more than 7');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('high-priority inefficiency');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('profitable attacks');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('12 words');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('Do not call tools');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('Output JSON only');
    expect(GAMEPLAY_SYSTEM_PROMPT).toContain('Choose exactly one legal action by index');
  });

  it('adds compact visible fighter and deck context without inventing hidden information', () => {
    const state = {
      type: 'STATE',
      v: 21,
      view: {
        self: {
          heroId: 'king-taranis',
          health: 7,
          hand: [{ id: 'card-1', title: 'Test Attack', value: 3 }],
          deckSize: 12,
          discard: [{ id: 'card-2', title: 'Used Scheme' }],
        },
        opponent: { heroId: 'baba-yaga', health: 9, handSize: 4 },
        hiddenServerState: { opponentHand: ['must-not-copy'] },
      },
      legalActions: [move],
    } as unknown as ServerStateMessage;

    const body = JSON.parse(buildPolicyRequest({
      state,
      seat: 'p1',
      roomId: 'room-1',
      ownHeroId: 'king-taranis',
    }).user);

    expect(body.matchupContext.ownHeroId).toBe('king-taranis');
    expect(body.matchupContext.visibleFacts).toContainEqual({ path: 'self.deckSize', value: 12 });
    expect(body.matchupContext.visibleFacts).toContainEqual({ path: 'opponent.heroId', value: 'baba-yaga' });
    expect(JSON.stringify(body.matchupContext)).not.toContain('hiddenServerState');
    expect(JSON.stringify(body.matchupContext)).not.toContain('must-not-copy');
  });

  it('adds the Clone Troopers team defeat condition when visible', () => {
    const state = {
      type: 'STATE',
      v: 21,
      view: { opponent: { heroId: 'clone-troopers', health: 2 } },
      legalActions: [move],
    } as unknown as ServerStateMessage;

    const body = JSON.parse(buildPolicyRequest({ state, seat: 'p1', roomId: 'room-1' }).user);
    expect(body.characterRuleNotes).toHaveLength(1);
    expect(body.characterRuleNotes[0]).toContain('every Clone');
  });

  it('caps extracted matchup context to avoid runaway prompt size', () => {
    const view = {
      self: {
        cards: Array.from({ length: 100 }, (_, i) => ({ id: `card-${i}`, title: `Card ${i}`, text: 'x'.repeat(200) })),
      },
    };
    const state = { type: 'STATE', v: 21, view, legalActions: [move] } as unknown as ServerStateMessage;
    const body = JSON.parse(buildPolicyRequest({ state, seat: 'p1', roomId: 'room-1' }).user);
    expect(JSON.stringify(body.matchupContext).length).toBeLessThan(14_000);
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
    expect(body.legalActions).toEqual([{ ...move, index: 0 }]);
    expect(body.strategyNotes).toEqual(['value actions that preserve cards']);
  });
});
