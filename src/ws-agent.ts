import { WebSocket } from 'ws';
import { chooseValidatedAction } from './actions.js';
import type { PolicyClient } from './hermes.js';
import { buildPolicyRequest } from './prompt.js';
import { PROTOCOL_VERSION, type ReplayBundleMessage, type ServerStateMessage } from './protocol.js';

export interface ReplayResultSummary {
  winner: string | null;
  won: boolean | null;
  heroes: Record<string, string>;
  turns: number;
  actionCount: number;
  mapTitle: string;
  endedAt: number;
}

export function summarizeReplayBundle(msg: ReplayBundleMessage, seat: string): ReplayResultSummary {
  const { meta, actionLog } = msg.bundle;
  return {
    winner: meta.winner,
    won: meta.winner === null ? null : meta.winner === seat,
    heroes: meta.heroes,
    turns: meta.turns,
    actionCount: actionLog.length,
    mapTitle: meta.mapTitle,
    endedAt: meta.endedAt,
  };
}

export interface AgentRunOptions {
  wsUrl: string;
  roomId?: string | undefined;
  heroId: string;
  create?: boolean;
  botDifficulty?: 'easy' | 'medium' | 'hard' | undefined;
  strategyNotes?: string[] | undefined;
  pilot?: string | undefined;
  hermes?: PolicyClient | undefined;
  maxActions?: number | undefined;
}

export interface AgentRunResult {
  roomId: string;
  seat: string;
  actionsSubmitted: number;
  fallbacks: number;
  replayResult: ReplayResultSummary | null;
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const ws = new WebSocket(options.wsUrl);
  let roomId = options.roomId ?? '';
  let seat = '';
  let actionsSubmitted = 0;
  let fallbacks = 0;
  let replayResult: ReplayResultSummary | null = null;
  let decisionInFlight = false;
  let stopping = false;
  const maxActions = options.maxActions ?? Number.POSITIVE_INFINITY;

  function send(payload: unknown): void {
    ws.send(JSON.stringify(payload));
  }

  async function act(state: ServerStateMessage): Promise<void> {
    if (stopping || decisionInFlight || actionsSubmitted >= maxActions) return;
    if (!roomId || !seat || state.legalActions.length === 0) return;
    decisionInFlight = true;
    try {
      const request = buildPolicyRequest({ state, seat, roomId, strategyNotes: options.strategyNotes });
      const startedAt = Date.now();
      console.log(JSON.stringify({ event: 'decision_started', roomId, seat, legalActions: state.legalActions.length, actionsSubmitted }));
      let raw = '';
      if (options.hermes) {
        raw = await options.hermes.complete(request.system, request.user);
      } else {
        raw = 'No Hermes client configured';
      }
      const latencyMs = Date.now() - startedAt;
      if (stopping || actionsSubmitted >= maxActions) return;
      const choice = chooseValidatedAction(raw, state.legalActions);
      if (choice.source === 'fallback') fallbacks++;
      send({ v: PROTOCOL_VERSION, type: 'ACTION', roomId, action: choice.action });
      actionsSubmitted++;
      console.log(JSON.stringify({ event: 'action_submitted', actionsSubmitted, source: choice.source, latencyMs, reason: choice.reason, error: choice.error ?? null }));
      if (actionsSubmitted >= maxActions) {
        stopping = true;
        ws.close(1000, 'max actions reached');
      }
    } finally {
      decisionInFlight = false;
    }
  }

  return await new Promise<AgentRunResult>((resolve, reject) => {
    const done = () => resolve({ roomId, seat, actionsSubmitted, fallbacks, replayResult });
    ws.on('open', () => {
      console.log(JSON.stringify({ event: 'ws_open', wsUrl: options.wsUrl, command: options.create ? 'create-bot' : 'join', roomId: options.roomId ?? null }));
      if (options.create) {
        send({
          v: PROTOCOL_VERSION,
          type: 'CREATE_ROOM',
          heroId: options.heroId,
          bot: options.botDifficulty ? { difficulty: options.botDifficulty } : undefined,
          pilot: options.pilot,
        });
      } else {
        if (!options.roomId) throw new Error('roomId is required unless create=true');
        send({ v: PROTOCOL_VERSION, type: 'JOIN_ROOM', roomId: options.roomId, heroId: options.heroId, pilot: options.pilot });
        console.log(JSON.stringify({ event: 'join_sent', roomId: options.roomId, heroId: options.heroId }));
      }
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === 'ROOM_CREATED' || msg.type === 'ROOM_JOINED') {
        roomId = String(msg.roomId);
        seat = String(msg.you);
        console.log(JSON.stringify({ event: msg.type, roomId, seat }));
        return;
      }
      if (msg.type === 'STATE') {
        console.log(JSON.stringify({ event: 'state_received', roomId, seat, legalActions: Array.isArray(msg.legalActions) ? msg.legalActions.length : null, decisionInFlight, actionsSubmitted }));
        void act(msg as unknown as ServerStateMessage).catch(reject);
        return;
      }
      if (msg.type === 'ERROR') {
        reject(new Error(`${String(msg.code ?? 'ERROR')}: ${String(msg.message ?? 'unknown error')}`));
        return;
      }
      if (msg.type === 'REPLAY_BUNDLE') {
        replayResult = summarizeReplayBundle(msg as unknown as ReplayBundleMessage, seat);
        console.log(JSON.stringify({ event: 'replay_result', roomId, seat, ...replayResult }));
        ws.close(1000, 'game over');
      }
    });
    ws.on('close', done);
    ws.on('error', reject);
  });
}
