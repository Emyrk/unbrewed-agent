import { query } from './db.js';
import { GameSession, type GameEvent, type GameEventSink, type GameSessionResult } from './game-session.js';
import { OpenRouterClient } from './openrouter.js';

export interface StartGameRequest {
  userId: string;
  heroId: string;
  model: string;
  openRouterApiKey: string;
  wsUrl: string;
  // Join existing room
  roomId?: string | undefined;
  // Or create against bot
  botDifficulty?: 'easy' | 'medium' | 'hard' | undefined;
  strategyNotes?: string[] | undefined;
}

export interface LiveGameInfo {
  gameId: string;
  userId: string;
  heroId: string;
  model: string;
  status: 'active';
  currentTurn: number;
  turnOwner: string | null;
  phase: string | null;
  thinking: boolean;
  actionsSubmitted: number;
  totalCostUsd: number;
  lastEvent: GameEvent | null;
  startedAt: number;
}

type LiveListener = (event: GameEvent) => void;

/**
 * Manages concurrent game sessions with persistence and live event broadcasting.
 */
export class GameManager {
  private activeSessions = new Map<string, { session: GameSession; info: LiveGameInfo }>();
  private listeners = new Set<LiveListener>();

  /** Subscribe to all live game events. */
  subscribe(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Get info on all currently active games. */
  getActiveGames(): LiveGameInfo[] {
    return Array.from(this.activeSessions.values()).map((s) => s.info);
  }

  /** Get info on a specific active game. */
  getActiveGame(gameId: string): LiveGameInfo | undefined {
    return this.activeSessions.get(gameId)?.info;
  }

  /** Cancel an active game. */
  cancelGame(gameId: string): boolean {
    const entry = this.activeSessions.get(gameId);
    if (!entry) return false;
    entry.session.cancel();
    return true;
  }

  /** Start a new game. Returns the game ID immediately; game runs in background. */
  async startGame(req: StartGameRequest): Promise<string> {
    const create = !req.roomId;
    const pilot = `llm:${req.model}`;

    // Insert game record
    const result = await query<{ id: string }>(
      `INSERT INTO games (user_id, room_id, our_hero, llm_model, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [req.userId, req.roomId ?? 'pending', req.heroId, req.model],
    );
    const gameId = result.rows[0]!.id;

    const info: LiveGameInfo = {
      gameId,
      userId: req.userId,
      heroId: req.heroId,
      model: req.model,
      status: 'active',
      currentTurn: 0,
      turnOwner: null,
      phase: null,
      thinking: false,
      actionsSubmitted: 0,
      totalCostUsd: 0,
      lastEvent: null,
      startedAt: Date.now(),
    };

    const sink: GameEventSink = {
      emit: async (event: GameEvent) => {
        event.data.userId = req.userId;
        if (event.data.turn !== undefined) info.currentTurn = event.data.turn as number;
        if (event.data.turnOwner !== undefined) info.turnOwner = event.data.turnOwner as string | null;
        if (event.data.phase !== undefined) info.phase = event.data.phase as string | null;
        if (event.type === 'action' && event.data.actionIndex !== undefined) {
          info.actionsSubmitted = (event.data.actionIndex as number) + 1;
        }
        if (event.data.totalCostUsd !== undefined) info.totalCostUsd = event.data.totalCostUsd as number;
        if (event.data.costUsd !== undefined) info.totalCostUsd += event.data.costUsd as number;
        info.thinking = event.type === 'thinking';

        const actionId = await this.persistEvent(event);
        if (actionId) event.data.actionId = actionId;

        // Prompts may include the player's private hand. Persist them for the owner,
        // but never put them on the shared live event stream.
        const publicData = { ...event.data };
        delete publicData.systemPrompt;
        delete publicData.userPrompt;
        delete publicData.modelOutput;
        delete publicData.selectedAction;
        const publicEvent: GameEvent = { ...event, data: publicData };
        info.lastEvent = publicEvent;
        for (const listener of this.listeners) {
          try {
            listener(publicEvent);
          } catch {
            // don't let a bad listener break the game
          }
        }
      },
    };

    const session = new GameSession({
      gameId,
      wsUrl: req.wsUrl,
      roomId: req.roomId,
      heroId: req.heroId,
      create,
      botDifficulty: req.botDifficulty,
      pilot,
      strategyNotes: req.strategyNotes,
      openRouterApiKey: req.openRouterApiKey,
      model: req.model,
      timeoutMs: 45_000,
      sink,
    });

    this.activeSessions.set(gameId, { session, info });

    // Run game in background
    session.run().then(
      async (result) => {
        this.activeSessions.delete(gameId);
        await this.finalizeGame(gameId, result, req.openRouterApiKey, req.model);
      },
      async (err) => {
        this.activeSessions.delete(gameId);
        await this.markGameErrored(gameId, err instanceof Error ? err.message : String(err));
      },
    );

    return gameId;
  }

  private async persistEvent(event: GameEvent): Promise<string | null> {
    try {
      if (event.type === 'started') {
        const { roomId, seat } = event.data;
        await query(
          'UPDATE games SET room_id = $1, our_seat = $2 WHERE id = $3',
          [roomId, seat, event.gameId],
        );
      } else if (event.type === 'action') {
        const d = event.data;
        const inserted = await query<{ id: string }>(
          `INSERT INTO game_actions
            (game_id, action_index, turn_number, legal_action_count, chosen_index,
             choice_source, confidence, reason, prompt_tokens, completion_tokens,
             total_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms,
             system_prompt, user_prompt, model_output, selected_action, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           RETURNING id`,
          [
            event.gameId,
            d.actionIndex,
            d.turn,
            d.legalActionCount,
            d.chosenIndex,
            d.choiceSource,
            d.confidence,
            d.reason,
            d.promptTokens,
            d.completionTokens,
            d.totalTokens,
            d.cacheReadTokens,
            d.cacheWriteTokens,
            d.costUsd,
            d.latencyMs,
            d.systemPrompt,
            d.userPrompt,
            d.modelOutput,
            JSON.stringify(d.selectedAction ?? null),
            d.error,
          ],
        );
        // Update running cost total
        await query(
          'UPDATE games SET total_cost_usd = total_cost_usd + $1 WHERE id = $2',
          [d.costUsd ?? 0, event.gameId],
        );
        return inserted.rows[0]?.id ?? null;
      }
      return null;
    } catch (err) {
      console.error('Failed to persist game event:', err);
      return null;
    }
  }

  private async finalizeGame(
    gameId: string,
    result: GameSessionResult,
    openRouterApiKey: string,
    model: string,
  ): Promise<void> {
    try {
      await query(
        `UPDATE games SET
          status = 'completed',
          winner = $1,
          won = $2,
          total_turns = $3,
          total_actions = $4,
          total_cost_usd = $5,
          opponent_hero = $6,
          map_title = $7,
          ended_at = now()
        WHERE id = $8`,
        [
          result.winner,
          result.won,
          result.totalTurns,
          result.actionsSubmitted,
          result.totalCostUsd,
          result.opponentHero,
          result.mapTitle,
          gameId,
        ],
      );

      // Run post-game analysis
      await this.runPostGameAnalysis(gameId, result, openRouterApiKey, model);
    } catch (err) {
      console.error('Failed to finalize game:', err);
    }
  }

  private async runPostGameAnalysis(
    gameId: string,
    result: GameSessionResult,
    apiKey: string,
    model: string,
  ): Promise<void> {
    try {
      // Fetch actions for this game
      const actionsResult = await query<{
        action_index: number;
        choice_source: string;
        reason: string;
        cost_usd: number;
      }>(
        'SELECT action_index, choice_source, reason, cost_usd FROM game_actions WHERE game_id = $1 ORDER BY action_index',
        [gameId],
      );

      const client = new OpenRouterClient({ apiKey, model, timeoutMs: 60_000 });

      const analysisPrompt = `You just finished playing an Unbrewed (Unmatched board game) match.

Game result:
- Hero: ${result.opponentHero ? `You played against ${result.opponentHero}` : 'Unknown opponent'}
- Map: ${result.mapTitle ?? 'Unknown'}
- Outcome: ${result.won === true ? 'YOU WON' : result.won === false ? 'YOU LOST' : 'DRAW/UNKNOWN'}
- Total turns: ${result.totalTurns}
- Total actions: ${result.actionsSubmitted}
- Fallback actions: ${result.fallbacks}
- Total LLM cost: $${result.totalCostUsd.toFixed(4)}

Action log (your reasoning per action):
${actionsResult.rows.map((a) => `  #${a.action_index}: [${a.choice_source}] ${a.reason}`).join('\n')}

Provide a JSON analysis with these fields:
{
  "summary": "2-3 sentence game summary",
  "mistakes": "Key mistakes or suboptimal plays. Be specific about turns/actions.",
  "lessons": "Concrete lessons for future games against this hero/map combo."
}

Output JSON only, no markdown.`;

      const response = await client.complete(
        'You are an expert Unmatched/Unbrewed strategy analyst.',
        analysisPrompt,
      );

      try {
        const analysis = JSON.parse(response) as {
          summary?: string;
          mistakes?: string;
          lessons?: string;
        };
        await query(
          `UPDATE games SET analysis_summary = $1, analysis_mistakes = $2, analysis_lessons = $3 WHERE id = $4`,
          [analysis.summary ?? null, analysis.mistakes ?? null, analysis.lessons ?? null, gameId],
        );
      } catch {
        // If parsing fails, store raw text as summary
        await query('UPDATE games SET analysis_summary = $1 WHERE id = $2', [response.slice(0, 2000), gameId]);
      }
    } catch (err) {
      console.error('Post-game analysis failed:', err);
    }
  }

  private async markGameErrored(gameId: string, error: string): Promise<void> {
    try {
      await query(
        `UPDATE games SET status = 'errored', error_message = $1, ended_at = now() WHERE id = $2`,
        [error.slice(0, 1000), gameId],
      );
    } catch (err) {
      console.error('Failed to mark game as errored:', err);
    }
  }
}
