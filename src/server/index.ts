import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer, WebSocket } from 'ws';

import { migrate } from './db.js';
import {
  getDiscordAuthUrl,
  exchangeCode,
  createOrUpdateUser,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
  getUserBySessionId,
  type AuthUser,
} from './auth.js';
import { GameManager } from './game-manager.js';
import { query } from './db.js';
import { filterCacheCapableModels, type OpenRouterModelsResponse } from './model-cache.js';
import type { GameEvent } from './game-session.js';

// Catch unhandled errors so we can see them in Railway logs
process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED_REJECTION:', err); });

const DEFAULT_WS_URL = process.env.UNBREWED_WS_URL || 'wss://unbrewed-engine-production.up.railway.app';

const app = new Hono();
const gameManager = new GameManager();

// Middleware
app.use('/api/*', cors());

// Health check — no DB required, just proves the process is up
app.get('/health', (c) => c.json({ status: 'ok' }));

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

// ─── OpenRouter Models Proxy (cached) ──────────────────

let modelsCache: { data: OpenRouterModelsResponse; fetchedAt: number } | null = null;
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getCacheCapableModels(): Promise<OpenRouterModelsResponse> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) return modelsCache.data;

  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`OpenRouter models API returned ${res.status}`);
  const response = await res.json() as OpenRouterModelsResponse;
  const filtered = filterCacheCapableModels(response);
  modelsCache = { data: filtered, fetchedAt: now };
  return filtered;
}

app.get('/api/models', async (c) => {
  try {
    return c.json(await getCacheCapableModels());
  } catch (err) {
    console.error('Failed to fetch cache-capable OpenRouter models:', err);
    return c.json({ error: 'Failed to fetch models' }, 502);
  }
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

  let cacheCapableModels: OpenRouterModelsResponse;
  try {
    cacheCapableModels = await getCacheCapableModels();
  } catch (err) {
    console.error('Could not validate model cache support:', err);
    return c.json({ error: 'Could not validate OpenRouter model cache support. Try again shortly.' }, 503);
  }
  if (!cacheCapableModels.data.some((model) => model.id === body.model)) {
    return c.json({ error: 'This model does not advertise discounted prompt-cache reads and is disabled.' }, 400);
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
    `SELECT id, game_id, action_index, turn_number, legal_action_count, chosen_index,
            choice_source, confidence, reason, prompt_tokens, completion_tokens,
            total_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
            latency_ms, error_message, created_at
     FROM game_actions WHERE game_id = $1 ORDER BY action_index`,
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

app.get('/api/games/:id/actions/:actionId', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const result = await query(
    `SELECT a.*
     FROM game_actions a
     JOIN games g ON g.id = a.game_id
     WHERE a.id = $1 AND a.game_id = $2 AND g.user_id = $3`,
    [c.req.param('actionId'), c.req.param('id'), user.id],
  );
  if (result.rows.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ action: result.rows[0] });
});

app.get('/api/games/:id/export', async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const gameId = c.req.param('id');
  const gameResult = await query(
    'SELECT * FROM games WHERE id = $1 AND user_id = $2',
    [gameId, user.id],
  );
  if (gameResult.rows.length === 0) return c.json({ error: 'Not found' }, 404);

  const actionsResult = await query(
    'SELECT * FROM game_actions WHERE game_id = $1 ORDER BY action_index',
    [gameId],
  );
  const actions = actionsResult.rows as Array<Record<string, unknown>>;
  const numbers = (key: string) => actions.map((action) => Number(action[key] ?? 0));
  const summary = {
    actionCount: actions.length,
    fallbackCount: actions.filter((action) => action.choice_source === 'fallback').length,
    maxLegalActionCount: Math.max(0, ...numbers('legal_action_count')),
    maxPromptTokens: Math.max(0, ...numbers('prompt_tokens')),
    totalPromptTokens: numbers('prompt_tokens').reduce((sum, value) => sum + value, 0),
    totalCompletionTokens: numbers('completion_tokens').reduce((sum, value) => sum + value, 0),
    totalCacheReadTokens: numbers('cache_read_tokens').reduce((sum, value) => sum + value, 0),
    totalCacheWriteTokens: numbers('cache_write_tokens').reduce((sum, value) => sum + value, 0),
  };

  return c.json({
    exportedAt: new Date().toISOString(),
    warning: 'This owner-only diagnostic contains prompts and redacted player views, including your private hand. It does not contain your OpenRouter API key.',
    game: gameResult.rows[0],
    summary,
    actions,
  }, 200, {
    'Content-Disposition': `attachment; filename="unbrewed-game-${gameId}.json"`,
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

// ─── Static Files (manual, no serveStatic dependency) ──

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PUBLIC_DIR = join(process.cwd(), 'public');

app.get('/*', async (c) => {
  // Try to serve static file from public/
  let filePath = c.req.path === '/' ? '/index.html' : c.req.path;
  // Prevent directory traversal
  if (filePath.includes('..')) return c.json({ error: 'Forbidden' }, 403);

  try {
    const fullPath = join(PUBLIC_DIR, filePath);
    const content = await readFile(fullPath);
    const ext = extname(filePath);
    return c.body(content, 200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
  } catch {
    // SPA fallback: serve index.html for any unmatched route
    try {
      const content = await readFile(join(PUBLIC_DIR, 'index.html'));
      return c.body(content, 200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
    } catch {
      return c.json({ error: 'Not found' }, 404);
    }
  }
});

// ─── Start Server ──────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);

async function start() {
  console.log(`Starting server on port ${PORT}`);
  console.log(`NODE_ENV=${process.env.NODE_ENV}, DATABASE_URL=${process.env.DATABASE_URL ? 'set' : 'NOT SET'}`);

  // Create raw http server so we can attach WebSocket to it
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const request = new Request(url.toString(), {
        method: req.method ?? 'GET',
        headers: Object.entries(req.headers).reduce<Record<string, string>>((acc, [k, v]) => {
          if (v) acc[k] = Array.isArray(v) ? v.join(', ') : v;
          return acc;
        }, {}),
        body: req.method !== 'GET' && req.method !== 'HEAD' ? new Uint8Array(await readBody(req)) : null,
      });

      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      console.error('Request error:', err);
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });

  // Set up WebSocket server for live game monitoring
  const wss = new WebSocketServer({ server, path: '/api/live' });

  wss.on('connection', async (ws, request) => {
    try {
      const cookies = parseCookies(request.headers.cookie);
      const user = await getUserBySessionId(cookies.ub_session);
      if (!user) {
        ws.close(1008, 'Unauthorized');
        return;
      }

      console.log(`Live monitor client connected for user ${user.id}`);
      const unsubscribe = gameManager.subscribe((event: GameEvent) => {
        if (event.data.userId !== user.id) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
      });

      const activeGames = gameManager.getActiveGames().filter((game) => game.userId === user.id);
      ws.send(JSON.stringify({ type: 'snapshot', games: activeGames }));

      ws.on('close', () => {
        unsubscribe();
        console.log(`Live monitor client disconnected for user ${user.id}`);
      });
    } catch (err) {
      console.error('Live monitor authentication failed:', err);
      ws.close(1011, 'Authentication failed');
    }
  });

  // Run migrations after server is listening (so healthcheck passes during DB setup)
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await migrate();
      break;
    } catch (err) {
      console.error(`Migration attempt ${attempt}/10 failed:`, err);
      if (attempt === 10) {
        console.error('All migration attempts failed, exiting');
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').map((part) => {
    const [name, ...value] = part.trim().split('=');
    return [name ?? '', decodeURIComponent(value.join('='))];
  }).filter(([name]) => Boolean(name)));
}

function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
