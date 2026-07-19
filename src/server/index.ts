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
  type AuthUser,
} from './auth.js';
import { GameManager } from './game-manager.js';
import { query } from './db.js';
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

  wss.on('connection', (ws) => {
    console.log('Live monitor client connected');
    const unsubscribe = gameManager.subscribe((event: GameEvent) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });

    const activeGames = gameManager.getActiveGames();
    if (activeGames.length > 0) {
      ws.send(JSON.stringify({ type: 'snapshot', games: activeGames }));
    }

    ws.on('close', () => {
      unsubscribe();
      console.log('Live monitor client disconnected');
    });
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
