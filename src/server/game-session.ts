import { WebSocket } from 'ws';
import { chooseValidatedAction } from '../actions.js';
import { buildPolicyRequest } from '../prompt.js';
import { PROTOCOL_VERSION, type Action, type ReplayBundleMessage, type ServerStateMessage } from '../protocol.js';
import { OpenRouterClient, type OpenRouterResponse } from './openrouter.js';

/**
 * Events emitted by a GameSession for persistence and live monitoring.
 */
export interface GameEvent {
  type: 'started' | 'state' | 'thinking' | 'action' | 'ended' | 'error';
  gameId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface GameEventSink {
  emit(event: GameEvent): void | Promise<void>;
}

export interface GameSessionConfig {
  gameId: string;
  wsUrl: string;
  roomId?: string | undefined;
  heroId: string;
  create: boolean;
  botDifficulty?: 'easy' | 'medium' | 'hard' | undefined;
  pilot?: string | undefined;
  strategyNotes?: string[] | undefined;
  openRouterApiKey: string;
  model: string;
  timeoutMs: number;
  sink: GameEventSink;
}

export interface GameSessionResult {
  roomId: string;
  seat: string;
  actionsSubmitted: number;
  fallbacks: number;
  totalCostUsd: number;
  won: boolean | null;
  winner: string | null;
  opponentHero: string | null;
  mapTitle: string | null;
  totalTurns: number;
}

const MAX_ACTIONS = 500;
const CYCLE_WINDOW = 10; // number of recent actions to check for cycles
const CYCLE_THRESHOLD = 6; // if 6 of last 10 actions are the same type, it's a cycle

export class GameSession {
  private ws: WebSocket | null = null;
  private roomId = '';
  private seat = '';
  private actionsSubmitted = 0;
  private fallbacks = 0;
  private totalCostUsd = 0;
  private decisionInFlight = false;
  private stopping = false;
  private abortController = new AbortController();
  private client: OpenRouterClient;
  private opponentHero: string | null = null;
  private mapTitle: string | null = null;
  private currentTurn = 0;
  private currentTurnOwner: string | null = null;
  private currentPhase: string | null = null;
  private recentActionTypes: string[] = []; // for cycle detection

  constructor(private readonly config: GameSessionConfig) {
    this.client = new OpenRouterClient({
      apiKey: config.openRouterApiKey,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });
  }

  get gameId(): string {
    return this.config.gameId;
  }

  get isActive(): boolean {
    return !this.stopping && this.ws !== null;
  }

  cancel(): void {
    this.stopping = true;
    this.abortController.abort();
    this.ws?.close(1000, 'cancelled');
  }

  async run(): Promise<GameSessionResult> {
    const ws = new WebSocket(this.config.wsUrl);
    this.ws = ws;

    const send = (payload: unknown) => ws.send(JSON.stringify(payload));

    return new Promise<GameSessionResult>((resolve, reject) => {
      const done = () =>
        resolve({
          roomId: this.roomId,
          seat: this.seat,
          actionsSubmitted: this.actionsSubmitted,
          fallbacks: this.fallbacks,
          totalCostUsd: this.totalCostUsd,
          won: null,
          winner: null,
          opponentHero: this.opponentHero,
          mapTitle: this.mapTitle,
          totalTurns: this.currentTurn,
        });

      ws.on('open', () => {
        if (this.config.create) {
          send({
            v: PROTOCOL_VERSION,
            type: 'CREATE_ROOM',
            heroId: this.config.heroId,
            bot: this.config.botDifficulty ? { difficulty: this.config.botDifficulty } : undefined,
            pilot: this.config.pilot,
          });
        } else {
          if (!this.config.roomId) throw new Error('roomId required for join');
          send({
            v: PROTOCOL_VERSION,
            type: 'JOIN_ROOM',
            roomId: this.config.roomId,
            heroId: this.config.heroId,
            pilot: this.config.pilot,
          });
        }
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;

        if (msg.type === 'ROOM_CREATED' || msg.type === 'ROOM_JOINED') {
          this.roomId = String(msg.roomId);
          this.seat = String(msg.you);
          void this.config.sink.emit({
            type: 'started',
            gameId: this.config.gameId,
            timestamp: Date.now(),
            data: { roomId: this.roomId, seat: this.seat },
          });
          return;
        }

        if (msg.type === 'STATE') {
          const state = msg as unknown as ServerStateMessage;
          this.extractMetadata(state);
          void this.config.sink.emit({
            type: 'state',
            gameId: this.config.gameId,
            timestamp: Date.now(),
            data: {
              turn: this.currentTurn,
              turnOwner: this.currentTurnOwner,
              phase: this.currentPhase,
              actionRequired: state.legalActions.length > 0,
              legalActions: state.legalActions.length,
            },
          });
          void this.act(state).catch((err) => {
            void this.config.sink.emit({
              type: 'error',
              gameId: this.config.gameId,
              timestamp: Date.now(),
              data: { error: String(err) },
            });
          });
          return;
        }

        if (msg.type === 'ERROR') {
          const error = `${String(msg.code ?? 'ERROR')}: ${String(msg.message ?? 'unknown')}`;
          void this.config.sink.emit({
            type: 'error',
            gameId: this.config.gameId,
            timestamp: Date.now(),
            data: { error },
          });
          reject(new Error(error));
          return;
        }

        if (msg.type === 'REPLAY_BUNDLE') {
          const bundle = msg as unknown as ReplayBundleMessage;
          const { meta } = bundle.bundle;
          const won = meta.winner === null ? null : meta.winner === this.seat;
          this.mapTitle = meta.mapTitle;
          this.currentTurn = meta.turns;

          // Extract opponent hero from meta
          for (const [seatId, heroId] of Object.entries(meta.heroes)) {
            if (seatId !== this.seat) this.opponentHero = heroId;
          }

          void this.config.sink.emit({
            type: 'ended',
            gameId: this.config.gameId,
            timestamp: Date.now(),
            data: {
              won,
              winner: meta.winner,
              totalTurns: meta.turns,
              totalCostUsd: this.totalCostUsd,
              totalActions: this.actionsSubmitted,
              opponentHero: this.opponentHero,
              mapTitle: this.mapTitle,
            },
          });

          resolve({
            roomId: this.roomId,
            seat: this.seat,
            actionsSubmitted: this.actionsSubmitted,
            fallbacks: this.fallbacks,
            totalCostUsd: this.totalCostUsd,
            won,
            winner: meta.winner,
            opponentHero: this.opponentHero,
            mapTitle: this.mapTitle,
            totalTurns: meta.turns,
          });
          ws.close(1000, 'game over');
        }
      });

      ws.on('close', done);
      ws.on('error', reject);
    });
  }

  private extractMetadata(state: ServerStateMessage): void {
    const view = state.view as Record<string, unknown> | null;
    if (!view) return;
    const candidates = [view, view.gameState, view.state, view.game]
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)));

    let foundTurnOwner = false;
    for (const candidate of candidates) {
      if (typeof candidate.mapTitle === 'string' && !this.mapTitle) this.mapTitle = candidate.mapTitle;

      for (const key of ['turn', 'turnNumber', 'currentTurn', 'turnCount', 'round']) {
        if (typeof candidate[key] === 'number' && candidate[key] as number > 0) {
          this.currentTurn = candidate[key] as number;
          break;
        }
      }

      for (const key of ['turnOwner', 'activePlayer', 'currentPlayer', 'turnPlayer', 'activeSeat']) {
        if (typeof candidate[key] === 'string' && candidate[key]) {
          this.currentTurnOwner = candidate[key];
          foundTurnOwner = true;
          break;
        }
      }

      for (const key of ['phase', 'currentPhase', 'step', 'prompt']) {
        if (typeof candidate[key] === 'string' && candidate[key]) {
          this.currentPhase = candidate[key];
          break;
        }
      }
    }

    if (this.actionsSubmitted > 0 && this.currentTurn === 0) {
      this.currentTurn = Math.ceil(this.actionsSubmitted / 2);
    }
    if (!foundTurnOwner) {
      this.currentTurnOwner = state.legalActions.length > 0 ? this.seat : 'opponent';
    }
  }

  /** Detect if we're stuck in a cycle of repeated actions. */
  private detectCycle(): boolean {
    if (this.recentActionTypes.length < CYCLE_WINDOW) return false;
    const window = this.recentActionTypes.slice(-CYCLE_WINDOW);
    const counts = new Map<string, number>();
    for (const t of window) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const count of counts.values()) {
      if (count >= CYCLE_THRESHOLD) return true;
    }
    return false;
  }

  /** Pick a random non-forfeit action. */
  private randomAction(legalActions: Action[]): Action {
    const nonForfeit = legalActions.filter((a) => a.type !== 'FORFEIT');
    const pool = nonForfeit.length > 0 ? nonForfeit : legalActions;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  private async act(state: ServerStateMessage): Promise<void> {
    if (this.stopping || this.decisionInFlight) return;
    if (!this.roomId || !this.seat || state.legalActions.length === 0) return;

    // Hard cap on actions to prevent runaway games
    if (this.actionsSubmitted >= MAX_ACTIONS) {
      console.log(`Game ${this.config.gameId}: hit max actions (${MAX_ACTIONS}), stopping`);
      this.stopping = true;
      this.ws?.close(1000, 'max actions reached');
      return;
    }

    this.decisionInFlight = true;

    try {
      const request = buildPolicyRequest({
        state,
        seat: this.seat,
        roomId: this.roomId,
        ownHeroId: this.config.heroId,
        strategyNotes: this.config.strategyNotes,
      });

      void this.config.sink.emit({
        type: 'thinking',
        gameId: this.config.gameId,
        timestamp: Date.now(),
        data: {
          turn: this.currentTurn,
          turnOwner: this.currentTurnOwner,
          phase: this.currentPhase,
          legalActions: state.legalActions.length,
          actionIndex: this.actionsSubmitted,
          model: this.config.model,
        },
      });

      const startedAt = Date.now();
      let response: OpenRouterResponse;
      let llmError: string | null = null;
      try {
        response = await this.client.completeWithUsage(request.system, request.user);
      } catch (err) {
        llmError = err instanceof Error ? err.message : String(err);
        response = { text: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 } };
      }
      const latencyMs = Date.now() - startedAt;

      if (this.stopping) return;

      // Enforce minimum delay so the game doesn't play inhumanly fast
      const MIN_ACTION_DELAY_MS = 250;
      const remaining = MIN_ACTION_DELAY_MS - latencyMs;
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      if (this.stopping) return;

      let choice = chooseValidatedAction(response.text, state.legalActions);
      if (choice.source === 'fallback') this.fallbacks++;

      // Cycle detection: if stuck in a loop, switch to random actions
      this.recentActionTypes.push(choice.action.type);
      if (this.recentActionTypes.length > CYCLE_WINDOW * 2) {
        this.recentActionTypes = this.recentActionTypes.slice(-CYCLE_WINDOW);
      }
      if (this.detectCycle()) {
        const randomAct = this.randomAction(state.legalActions);
        choice = {
          action: randomAct,
          source: 'fallback',
          reason: 'Cycle detected — switching to random action to break loop.',
          confidence: null,
        };
        this.fallbacks++;
        console.log(`Game ${this.config.gameId}: cycle detected at action ${this.actionsSubmitted}, using random action`);
      }

      const actionCost = response.usage.cost_usd;
      this.totalCostUsd += actionCost;

      // Send action to the game server
      this.ws?.send(
        JSON.stringify({ v: PROTOCOL_VERSION, type: 'ACTION', roomId: this.roomId, action: choice.action }),
      );
      this.actionsSubmitted++;

      void this.config.sink.emit({
        type: 'action',
        gameId: this.config.gameId,
        timestamp: Date.now(),
        data: {
          actionIndex: this.actionsSubmitted - 1,
          turn: this.currentTurn,
          chosenIndex: choice.source === 'model' ? state.legalActions.indexOf(choice.action) : -1,
          choiceSource: choice.source,
          confidence: choice.confidence,
          reason: choice.reason,
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          costUsd: actionCost,
          latencyMs,
          legalActionCount: state.legalActions.length,
          systemPrompt: request.system,
          userPrompt: request.user,
          modelOutput: response.text,
          selectedAction: choice.action,
          error: choice.error ?? llmError,
        },
      });
    } finally {
      this.decisionInFlight = false;
    }
  }
}
