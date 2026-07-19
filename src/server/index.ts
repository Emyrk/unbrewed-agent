import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

import { migrate } from './db.js';
import {
  getDiscordAuthUrl,
  exchangeCode,
  createOrUpdateUser,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
  type AuthUser,
} from './auth.js';
import { GameManager } from './game-manager.js';
import { query } from './db.js';
import type { GameEvent } from './game-session.js';

const DEFAULT_WS_URL = process.env.UNBREWED_WS_URL || 'wss://unbrewed-engine-production.up.railway.app';

const app = new Hono();
const gameManager = new GameManager();

// Middleware
app.use('/api/*', cors());

// ─── Auth Routes ───────────────────────────────────────

app.get('/auth/login', (c) => {
  return c.redirect(getDiscordAuthUrl());
});

app.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.json({ error: 'Missing code' }, 400);

  try {
    const discordUser = await exchangeCode(code);
    const userId = await createOrUpdateUser(discordUser);
    const sessionId = await createSession(userId);
    setSessionCookie(c, sessionId);
    return c.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err);
    return c.json({ error: 'Authentication failed' }, 500);
  }
});

app.get('/auth/logout', (c) => {
  clearSessionCookie(c);
  return c.redirect('/');
});

app.get('/api/me', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ user: null });
  return c.json({ user });
});

// ─── Game API Routes ───────────────────────────────────

/** Auth guard helper */
async function requireAuth(c: { req: { raw: Request }; json: (body: unknown, status?: number) => Response } & Record<string, unknown>): Promise<AuthUser | null> {
  // Re-use Hono context for cookie reading
  const user = await getSessionUser(c as any);
  if (!user) {
    return null;
  }
  return user;
}

app.post('/api/games', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    heroId: string;
    model: string;
    openRouterApiKey: string;
    roomId?: string;
    botDifficulty?: 'easy' | 'medium' | 'hard';
    wsUrl?: string;
  }>();

  if (!body.heroId || !body.model || !body.openRouterApiKey) {
    return c.json({ error: 'heroId, model, and openRouterApiKey are required' }, 400);
  }

  const gameId = await gameManager.startGame({
    userId: user.id,
    heroId: body.heroId,
    model: body.model,
    openRouterApiKey: body.openRouterApiKey,
    wsUrl: body.wsUrl || DEFAULT_WS_URL,
    roomId: body.roomId,
    botDifficulty: body.botDifficulty,
  });

  return c.json({ gameId, status: 'active' });
});

app.get('/api/games', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') || 50), 100);
  const offset = Number(c.req.query('offset') || 0);

  let sql = `SELECT id, status, room_id, our_hero, opponent_hero, map_title, llm_model,
                    won, total_turns, total_actions, total_cost_usd,
                    analysis_summary, started_at, ended_at
             FROM games WHERE user_id = $1`;
  const params: unknown[] = [user.id];

  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const result = await query(sql, params);

  // Also attach live info for active games
  const activeGames = gameManager.getActiveGames().filter((g) => g.userId === user.id);

  return c.json({ games: result.rows, activeGames });
});

app.get('/api/games/:id', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const gameId = c.req.param('id');
  const gameResult = await query(
    `SELECT * FROM games WHERE id = $1 AND user_id = $2`,
    [gameId, user.id],
  );
  if (gameResult.rows.length === 0) return c.json({ error: 'Not found' }, 404);

  const actionsResult = await query(
    `SELECT * FROM game_actions WHERE game_id = $1 ORDER BY action_index`,
    [gameId],
  );

  // Include live info if game is active
  const liveInfo = gameManager.getActiveGame(gameId);

  return c.json({
    game: gameResult.rows[0],
    actions: actionsResult.rows,
    live: liveInfo ?? null,
  });
});

app.delete('/api/games/:id', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const gameId = c.req.param('id');
  // Verify ownership
  const gameResult = await query(
    'SELECT id FROM games WHERE id = $1 AND user_id = $2',
    [gameId, user.id],
  );
  if (gameResult.rows.length === 0) return c.json({ error: 'Not found' }, 404);

  const cancelled = gameManager.cancelGame(gameId);
  if (!cancelled) return c.json({ error: 'Game not active' }, 400);

  return c.json({ ok: true });
});

app.get('/api/stats', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const stats = await query(
    `SELECT
       COUNT(*)::int as total_games,
       COUNT(*) FILTER (WHERE won = true)::int as wins,
       COUNT(*) FILTER (WHERE won = false)::int as losses,
       COUNT(*) FILTER (WHERE status = 'active')::int as active,
       COALESCE(SUM(total_cost_usd), 0)::numeric as total_cost,
       COALESCE(AVG(total_cost_usd) FILTER (WHERE status = 'completed'), 0)::numeric as avg_cost_per_game
     FROM games WHERE user_id = $1`,
    [user.id],
  );

  return c.json(stats.rows[0] ?? {});
});

// ─── Static Files (Dashboard) ──────────────────────────

app.use('/*', serveStatic({ root: './public' }));

// Fallback to index.html for SPA routing
app.get('*', serveStatic({ root: './public', path: 'index.html' }));

// ─── Start Server ──────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);

async function start() {
  await migrate();
  console.log(`Starting server on port ${PORT}`);

  const server = serve({ fetch: app.fetch, port: PORT }) as Server;

  // Set up WebSocket server for live game monitoring
  const wss = new WebSocketServer({ server, path: '/api/live' });

  wss.on('connection', (ws) => {
    console.log('Live monitor client connected');
    const unsubscribe = gameManager.subscribe((event: GameEvent) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });

    // Send current active games on connect
    const activeGames = gameManager.getActiveGames();
    if (activeGames.length > 0) {
      ws.send(JSON.stringify({ type: 'snapshot', games: activeGames }));
    }

    ws.on('close', () => {
      unsubscribe();
      console.log('Live monitor client disconnected');
    });
  });

  console.log(`Server running at http://localhost:${PORT}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
