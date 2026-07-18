import { describe, expect, it } from 'vitest';
import { summarizeReplayBundle } from '../src/ws-agent.js';
import type { ReplayBundleMessage } from '../src/protocol.js';

const replayMessage: ReplayBundleMessage = {
  v: 21,
  type: 'REPLAY_BUNDLE',
  bundle: {
    v: 1,
    engine: { schemaVersion: 1, dslVersion: '0.10.0' },
    config: {
      seed: 123,
      players: {
        p1: { heroId: 'triceratops' },
        p2: { heroId: 'king-taranis' },
      },
      map: {},
    },
    actionLog: [
      { type: 'MANEUVER_DRAW', player: 'p2' },
      { type: 'ATTACK', player: 'p2' },
      { type: 'COMMIT_DEFENSE_CARD', player: 'p1' },
    ],
    meta: {
      winner: 'p2',
      heroes: { p1: 'triceratops', p2: 'king-taranis' },
      turns: 9,
      endedAt: 1784410000000,
      mapTitle: 'The Mended Drum',
    },
  },
};

describe('replay result logging', () => {
  it('summarizes replay bundle winner relative to the agent seat', () => {
    expect(summarizeReplayBundle(replayMessage, 'p2')).toEqual({
      winner: 'p2',
      won: true,
      heroes: { p1: 'triceratops', p2: 'king-taranis' },
      turns: 9,
      actionCount: 3,
      mapTitle: 'The Mended Drum',
      endedAt: 1784410000000,
    });
  });

  it('reports a loss when the winner is another seat', () => {
    const summary = summarizeReplayBundle(
      {
        ...replayMessage,
        bundle: { ...replayMessage.bundle, meta: { ...replayMessage.bundle.meta, winner: 'p1' } },
      },
      'p2',
    );

    expect(summary.won).toBe(false);
    expect(summary.winner).toBe('p1');
  });
});
